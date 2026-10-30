/**
 * Running a suite: every scenario on every channel it runs on,
 * each turn through the SDK's own turn runner with the product's real agent
 * configuration, and every expectation checked after its turn.
 *
 * What the harness replaces is only what reaches the outside: the model's
 * network (replayed, recorded or live), storage (one conversation in memory,
 * or the product's own store), the realtime server (memory.ts), the person's
 * page (page.ts, from the suite's fixture) and each tool's execution (its
 * stub).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_SOCKET_EVENTS,
  type ApprovalChannel,
  type ApprovalPreview,
  type StaffSpeaker,
  type TurnStoppedMarker,
} from '@ouispec/agent-core';
import {
  createAgentTurnRunner,
  describeModel,
  hostSystemPrompt,
  loadBuiltinTools,
  UI_ACT_TOOL,
  withoutClientUI,
  type AgentTurnPayload,
  type RegisteredTool,
  type ToolExecutionResult,
  type TurnMessage,
  type TurnOutcome,
} from '@ouispec/agent-worker';
import { recordingFetch, replayingFetch, type RecordedExchange } from '@ouispec/agent-worker/testing';
import { toolName } from '@ouispec/bindings';
import type { AgentEvalBound, AgentEvalExpectation, AgentEvalPage, AgentEvalScenario, AgentEvalSuite, AgentEvalTextMatcher } from '@ouispec/contract';
import type { AgentEvalConfig, EvalAgentConfig, EvalChannel, EvalMode } from './config.js';
import { CASSETTE_VERSION, cassettePath, fingerprint, readCassette, writeCassette } from './cassettes.js';
import { checkSuite, readSuiteFile } from './suite.js';
import { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from './matchers.js';
import { judge, type JudgeOptions } from './judge.js';
import { NO_PAGE, createMemoryApprovalStore, createMemoryEmit, createMemoryHistory, createMemoryStops, type EvalHistoryTurn } from './memory.js';
import { createFixturePage, type EvalPage, type EvalPageRun } from './page.js';
import { recordingCalls, turnUsage, type EvalModelCall, type EvalTurnUsage } from './usage.js';

// ─── What a run reports ─────────────────────────────────────────────────────

/** One assertion that did not hold, or why a case could not be run. */
export interface EvalFailure {
  /** The turn it is about (0-based, in the scenario's turns); -1 for the case as a whole. */
  turn: number;
  /** `says`, `toolCalled`, …; `recording`, `stub`, `scenario`, `page` or `turn` for what stopped the case. */
  assertion: string;
  message: string;
  /**
   * `assertion`: the agent did not do what the scenario says. `judge`: a
   * rubric could not be decided, because the judge gave no verdict; the reply
   * was not judged, so this says nothing about the agent. `case`: the case
   * could not run as written (no recording, a call no stub answers, a turn
   * that failed).
   */
  kind: 'assertion' | 'judge' | 'case';
}

/** Choice buttons a turn offered (`present_options`). */
export interface EvalChoices {
  /** What is asked with them: what it says first, then the question. */
  question: string;
  options: Array<{ label: string; value?: string; description?: string }>;
}

/** What one of the agent's turns did, as the assertions read it. */
export interface EvalTurnRecord {
  turn: number;
  kind: 'user' | 'approval';
  /** What the customer wrote; empty for an approval's continuation. */
  customer: string;
  /** Everything the agent said in the turn, as it was stored and sent: its text, and a readback. */
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** The approval the turn stopped at, when it stopped at one. */
  approval: { tool: string; args: Record<string, unknown>; preview: ApprovalPreview } | null;
  /** True when the turn ran no model call because a person held the conversation. */
  held: boolean;
  /** Requests that reached the model's network in the turn, retries included. */
  modelRequests: number;
  /** What the turn's model calls used, as the provider reported it. */
  usage: EvalTurnUsage;
  /** The choice buttons it offered. */
  choices: EvalChoices[];
  /** Where the page was after the turn, and what ran on it during the turn; null with no page. */
  page: { at: string; ran: EvalPageRun[] } | null;
  outcome: TurnOutcome['status'];
  stopReason?: string;
}

export interface EvalCaseResult {
  suite: string;
  scenario: string;
  title: string;
  channel: string;
  mode: EvalMode;
  /** True only when every assertion held and every rubric was judged. */
  passed: boolean;
  /** `failed`: an assertion did not hold, or the case could not run; `unjudged`: none failed, but a rubric could not be judged. */
  status: 'passed' | 'failed' | 'unjudged';
  failures: EvalFailure[];
  turns: EvalTurnRecord[];
  /** The recording's file. */
  cassette: string;
  modelRequests: number;
  durationMs: number;
}

export interface EvalReport {
  mode: EvalMode;
  cases: EvalCaseResult[];
  passed: number;
  failed: number;
  /** Cases where nothing failed but a rubric could not be judged. */
  unjudged: number;
}

/** One scenario on one channel, ready to run. */
export interface EvalCase {
  /** `suite › scenario-id [channel]` */
  name: string;
  suite: AgentEvalSuite;
  scenario: AgentEvalScenario;
  channel: string;
  /** Runs it; resolves with what happened, failures included. */
  run(): Promise<EvalCaseResult>;
  /** Runs it, and throws an `EvalCaseFailed` listing every failure: for a test runner. */
  assert(): Promise<EvalCaseResult>;
}

/** A case whose assertions did not all hold, with every failure in its message. */
export class EvalCaseFailed extends Error {
  constructor(readonly result: EvalCaseResult) {
    super(`${result.suite} › ${result.scenario} [${result.channel}] failed:\n${result.failures.map((f) => `  - ${failureLine(f)}`).join('\n')}`);
    this.name = 'EvalCaseFailed';
  }
}

export const failureLine = (f: EvalFailure) =>
  `${f.turn >= 0 ? `turn ${f.turn + 1}, ` : ''}${f.kind === 'judge' ? 'not judged, ' : ''}${f.assertion}: ${f.message}`;

export interface EvalRunOptions {
  /** Default `replay`. */
  mode?: EvalMode;
  /** Only these channels. */
  channels?: readonly string[];
  /** Only these scenarios, by id. */
  scenarios?: readonly string[];
  /** Where relative paths start when the configuration does not say (`config.root`). Default: the working directory. */
  root?: string;
}

// ─── Finding the cases ──────────────────────────────────────────────────────

function rootOf(config: AgentEvalConfig, fallback: string | undefined): string {
  if (config.root instanceof URL) return fileURLToPath(config.root);
  if (typeof config.root === 'string') return config.root.startsWith('file:') ? fileURLToPath(config.root) : resolve(config.root);
  return resolve(fallback ?? process.cwd());
}

/** Every scenario on every channel it runs on, as cases to run. */
export async function evalCases(config: AgentEvalConfig, options: EvalRunOptions = {}): Promise<EvalCase[]> {
  const root = rootOf(config, options.root);
  const channelNames = Object.keys(config.channels);
  if (channelNames.length === 0) throw new Error('[agent-evals] the configuration names no channels');
  const mode = options.mode ?? 'replay';
  const cassettes = resolve(root, config.cassettes);
  const suites = config.suites.map((entry) => {
    if (typeof entry !== 'string') return checkSuite(entry, `the suite "${(entry as { name?: string }).name ?? '(unnamed)'}"`, channelNames);
    const path = resolve(root, entry);
    return checkSuite(readSuiteFile(path), path, channelNames);
  });
  for (const name of options.channels ?? []) {
    if (!channelNames.includes(name)) throw new Error(`[agent-evals] no channel "${name}" in the configuration (${channelNames.join(', ')})`);
  }
  const cases: EvalCase[] = [];
  for (const suite of suites) {
    for (const scenario of suite.scenarios) {
      if (options.scenarios && !options.scenarios.includes(scenario.id)) continue;
      for (const channel of scenario.channels ?? suite.channels ?? channelNames) {
        if (options.channels && !options.channels.includes(channel)) continue;
        const run = () => runEvalCase(config, { suite, scenario, channel, mode, cassettes });
        cases.push({
          name: `${suite.name} › ${scenario.id} [${channel}]`,
          suite,
          scenario,
          channel,
          run,
          async assert() {
            const result = await run();
            if (!result.passed) throw new EvalCaseFailed(result);
            return result;
          },
        });
      }
    }
  }
  if (options.scenarios) {
    const found = new Set(cases.map((c) => c.scenario.id));
    const missing = options.scenarios.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`[agent-evals] no scenario ${missing.join(', ')} on the channels asked for`);
  }
  return cases;
}

/** Runs every case, one after another, and reports them all. */
export async function runEvals(
  config: AgentEvalConfig,
  options: EvalRunOptions & { onCase?: (result: EvalCaseResult) => void } = {},
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const evalCase of await evalCases(config, options)) {
    const result = await evalCase.run();
    results.push(result);
    options.onCase?.(result);
  }
  const count = (status: EvalCaseResult['status']) => results.filter((r) => r.status === status).length;
  return { mode: options.mode ?? 'replay', cases: results, passed: count('passed'), failed: count('failed'), unjudged: count('unjudged') };
}

// ─── One case ───────────────────────────────────────────────────────────────

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
/** The realtime server's URL as a run names it: every touchpoint is in memory, so nothing ever goes there. */
const NOWHERE = 'http://agent-evals.invalid';

const AGENT_PARTS = [
  'persona',
  'systemPrompt',
  'toolPolicy',
  'turnPolicy',
  'maxRounds',
  'maxTokens',
  'temperature',
  'toolTimeoutMs',
  'turnDeadlineMs',
  'retries',
  'beforeTurn',
  'filterEvent',
  'modelProviderOptions',
  'forcedToolChoice',
  'requireReplyBeforeChoice',
] as const satisfies ReadonlyArray<keyof EvalAgentConfig>;

/** Only the parts a turn runs with: anything else a product's configuration carries (its storage, its realtime server) stays out. */
function agentParts(config: EvalAgentConfig): Omit<EvalAgentConfig, 'tools' | 'approvals' | 'uiActions'> {
  const parts: Record<string, unknown> = {};
  for (const key of AGENT_PARTS) if (config[key] !== undefined) parts[key] = config[key];
  return parts as Omit<EvalAgentConfig, 'tools' | 'approvals' | 'uiActions'>;
}

/** The SDK's own interaction tools (`present_options`, `confirm_action`, …): they reach no backend, so with no stub they run as they are. */
const INTERACTION_TOOLS = new Set(loadBuiltinTools().map((t) => t.name));

/** The choice buttons among a turn's calls. */
const choicesOf = (calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>): EvalChoices[] =>
  calls
    .filter((c) => c.name === 'present_options')
    .map((c) => {
      const { context, prompt, options } = c.args as { context?: unknown; prompt?: unknown; options?: unknown };
      return {
        question: [context, prompt].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n\n'),
        options: (Array.isArray(options) ? options : []).map((o: Record<string, unknown>) => ({
          label: String(o?.label ?? ''),
          ...(typeof o?.value === 'string' ? { value: o.value } : {}),
          ...(typeof o?.description === 'string' ? { description: o.description } : {}),
        })),
      };
    });

/** Whether a stored tool result says the call did not run: `success: false`. */
const refusedResult = (content: string | null | undefined): boolean => {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as { success?: unknown };
    return parsed?.success === false;
  } catch {
    return false;
  }
};

/** The text a stored turn's messages said to the customer, in order. */
const replyOf = (messages: readonly TurnMessage[]) =>
  messages
    .filter((m) => m.role === 'assistant' && m.content?.trim())
    .map((m) => m.content!.trim())
    .join('\n\n');

/** Everything a turn stored, as text: what `doesNotStore` searches. */
const storedText = (messages: readonly TurnMessage[]) =>
  messages
    .flatMap((m) => [m.content ?? '', ...(m.toolCalls ?? []).map((c) => JSON.stringify(c.arguments))])
    .join('\n');

export async function runEvalCase(
  config: AgentEvalConfig,
  target: { suite: AgentEvalSuite; scenario: AgentEvalScenario; channel: string; mode: EvalMode; cassettes: string },
): Promise<EvalCaseResult> {
  const { suite, scenario, channel, mode } = target;
  const started = Date.now();
  const settings: EvalChannel = config.channels[channel] ?? {};
  const failures: EvalFailure[] = [];
  const turns: EvalTurnRecord[] = [];
  const fail = (turn: number, assertion: string, message: string, kind: EvalFailure['kind'] = 'case') => failures.push({ turn, assertion, message, kind });
  const path = cassettePath(target.cassettes, suite, scenario, channel);
  let modelRequests = 0;
  const result = (): EvalCaseResult => {
    const status = failures.length === 0 ? 'passed' : failures.every((f) => f.kind === 'judge') ? 'unjudged' : 'failed';
    return {
    suite: suite.name,
    scenario: scenario.id,
    title: scenario.title,
    channel,
    mode,
    passed: status === 'passed',
    status,
    failures,
    turns,
    cassette: path,
    modelRequests,
    durationMs: Date.now() - started,
    };
  };

  const customer = { userId: config.customer?.userId ?? 'eval-customer', accountId: config.customer?.accountId ?? 'eval-account' };
  const conversationId = `eval-${scenario.id}-${channel}`;
  const approvalChannel: ApprovalChannel = settings.approvals ?? 'ui';
  const sharedContext: Record<string, unknown> = { ...(suite.context ?? {}), ...(settings.context ?? {}), ...(scenario.context ?? {}) };
  // A customer's message on a voice channel says it was spoken; an approval's continuation is no message at all.
  const context: Record<string, unknown> = { ...sharedContext, ...(settings.input ? { input: settings.input } : {}) };

  // The product's real configuration for this channel and scenario.
  const agent = await config.agent({ channel, scenario, suite });
  const resolveTools = async (turnId: string): Promise<RegisteredTool[]> =>
    typeof agent.tools === 'function' ? await agent.tools({ ...customer, turnId }) : agent.tools;
  // The person's page: the scenario's, else the suite's.
  const pageFixture: AgentEvalPage | null = scenario.page === false ? null : (scenario.page ?? suite.page ?? null);
  const configured = fingerprint({
    systemPrompt: hostSystemPrompt(agent, { ...customer, context: withoutClientUI(context) }),
    tools: await resolveTools(`${conversationId}-0`),
    channel: { name: channel, settings },
    suite,
    scenario,
    // What else shapes what the model is asked, when the scenario has it.
    ...(pageFixture ? { page: { fixture: pageFixture, manifest: config.page?.manifest ?? null, knowledge: config.page?.knowledge ?? null } } : {}),
    ...(agent.modelProviderOptions !== undefined ? { modelProviderOptions: agent.modelProviderOptions } : {}),
    ...(agent.forcedToolChoice !== undefined ? { forcedToolChoice: agent.forcedToolChoice } : {}),
    ...(agent.requireReplyBeforeChoice ? { requireReplyBeforeChoice: true } : {}),
    ...(agent.uiActions !== undefined ? { uiActions: agent.uiActions } : {}),
  });

  // The model's network: replayed, recorded or live, every request counted.
  const exchanges: RecordedExchange[] = [];
  let network: typeof globalThis.fetch;
  let recorded = 0;
  if (mode === 'replay') {
    const cassette = readCassette(path);
    if (!cassette) {
      fail(-1, 'recording', `there is no recording at ${path}: record it with \`agent-evals --record\``);
      return result();
    }
    if (cassette.fingerprint !== configured) {
      fail(
        -1,
        'recording',
        `${path} was recorded against another agent configuration or scenario (its system prompt, tools, channel or turns have changed since ${cassette.recordedAt}): record it again with \`agent-evals --record\``,
      );
      return result();
    }
    recorded = cassette.exchanges.length;
    network = replayingFetch(cassette.exchanges);
  } else {
    network = mode === 'record' ? recordingFetch(exchanges) : globalThis.fetch;
  }
  const counted: typeof globalThis.fetch = (input, init) => {
    modelRequests += 1;
    return network(input, init);
  };
  const providerModel = config.model({ fetch: counted, mode, purpose: 'agent' });
  // Every call of the agent's model, as the provider reported what it used: never the judge's.
  const modelCalls: EvalModelCall[] = [];
  const model = recordingCalls(providerModel, (call) => modelCalls.push(call));
  const judgeModel = (config.judge ?? config.model)({ fetch: counted, mode, purpose: 'judge' });

  // Each tool runs only as its stub says: an eval never reaches a real backend.
  let currentTurn = -1;
  const stubbed = async (tool: RegisteredTool, args: Record<string, unknown>, call: Parameters<RegisteredTool['execute']>[1]) => {
    for (const cases of [scenario.stubs?.[tool.name], suite.stubs?.[tool.name]]) {
      const hit = cases?.find((c) => c.when === undefined || holdsSubset(args, c.when));
      if (hit) return hit.result as ToolExecutionResult;
    }
    return (await config.stubs?.[tool.name]?.(args, { channel, scenario, tool: tool.name, call })) ?? null;
  };
  const wrap = (tool: RegisteredTool): RegisteredTool => ({
    ...tool,
    async execute(args, call) {
      const answer = await stubbed(tool, args, call);
      if (answer) return answer;
      if (INTERACTION_TOOLS.has(tool.name)) return tool.execute(args, call);
      fail(currentTurn, 'stub', `the agent called ${tool.name} with ${JSON.stringify(args)}, and no stub answers that call`);
      return { success: false, error: `[agent-evals] ${tool.name} has no stub for this call; nothing was run` };
    },
  });

  // The person's page, as the fixture declares it.
  let page: EvalPage | null = null;
  if (pageFixture) {
    try {
      page = createFixturePage(pageFixture, config.page);
    } catch (err) {
      fail(-1, 'page', err instanceof Error ? err.message : String(err));
      return result();
    }
  }

  // The realtime server in memory, and the product's store (its own, or the whole conversation in memory).
  const emit = createMemoryEmit();
  const approvals = createMemoryApprovalStore();
  const stops = createMemoryStops();
  const history = await (config.history?.({ channel, scenario, suite }) ?? createMemoryHistory());
  let stored: Array<{ messages: TurnMessage[]; stopped?: TurnStoppedMarker }> = [];
  let readingFor: EvalHistoryTurn | null = null;
  const runner = createAgentTurnRunner<null>({
    ...agentParts(agent),
    tools: async ({ turnId }) => (await resolveTools(turnId)).map(wrap),
    model,
    ...(config.promptCacheBreakpoint ? { promptCacheBreakpoint: config.promptCacheBreakpoint } : {}),
    realtime: { url: NOWHERE, apiKey: 'agent-evals', emit },
    // The page answers; with none, nothing does, at once (a turn whose context carries a snapshot is told the page is not responding).
    uiActions: { ...agent.uiActions, ...(page ? { channel: page.channel } : { channel: NO_PAGE, resultTimeoutMs: 0 }) },
    approvals: {
      store: approvals,
      ...(agent.approvals?.preview ? { preview: agent.approvals.preview } : {}),
      ...(agent.approvals?.validateBeforeApproval ? { validateBeforeApproval: agent.approvals.validateBeforeApproval } : {}),
    },
    stops: { client: stops },
    getDb: async () => null,
    // The turn it reads for, as a product's worker has it from the turn's payload.
    getHistory: (id, _db, request) => history.getHistory(id, { ...request, ...(readingFor ? { turn: readingFor } : {}) }),
    persistMessages: async ({ db: _db, ...turn }) => {
      stored.push({ messages: turn.messages, ...(turn.stopped ? { stopped: turn.stopped } : {}) });
      return history.persistMessages(turn);
    },
    logger: QUIET,
  });

  const runTurn = async (index: number, kind: 'user' | 'approval', payload: Pick<AgentTurnPayload, 'content' | 'approval'>) => {
    currentTurn = index;
    const turnId = `${conversationId}-${index}`;
    // The product's API stores the customer's message before it runs the turn.
    if (kind === 'user') await history.append(conversationId, { role: 'user', content: payload.content });
    stored = [];
    const before = modelRequests;
    const callsBefore = modelCalls.length;
    const ranBefore = page?.ran.length ?? 0;
    // The turn is sent from where the page is, with what it offers now, as the person's tab sends it.
    const pageContext = page ? await page.context() : {};
    const sent = { ...(kind === 'user' ? context : sharedContext), ...pageContext };
    readingFor = { conversationId, turnId, index, kind, suite, scenario, channel, user: { ...customer }, context: sent, at: page?.location() ?? null };
    const outcome = await runner.run({
      turnId,
      conversationId,
      ...customer,
      socketRoom: `eval:turn:${turnId}`,
      content: payload.content,
      context: sent,
      channel: approvalChannel,
      ...(payload.approval ? { approval: payload.approval } : {}),
    });
    const messages = stored.flatMap((s) => s.messages);
    const toolCalls = messages.flatMap((m) => (m.toolCalls ?? []).map((c) => ({ name: c.name, args: c.arguments })));
    // A choice the runtime sent back (refused, invalid, or held for a reply) was never shown.
    const notShown = new Set(
      messages.filter((m) => m.role === 'tool' && m.toolCallId && refusedResult(m.content)).map((m) => m.toolCallId as string),
    );
    const shownCalls = messages.flatMap((m) =>
      (m.toolCalls ?? []).filter((c) => !notShown.has(c.id)).map((c) => ({ name: c.name, args: c.arguments })),
    );
    const asked = emit.events.find((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED && e.data.turnId === turnId);
    const pending = asked ? approvals.asked.find((a) => a.approvalId === asked.data.approvalId) : undefined;
    const stopReason = outcome.status === 'stopped' ? outcome.stopReason : undefined;
    const record: EvalTurnRecord = {
      turn: index,
      kind,
      customer: payload.content,
      reply: replyOf(messages),
      toolCalls,
      approval: pending ? { tool: pending.tool, args: pending.args, preview: pending.preview } : null,
      held: stopReason === 'taken_over' && modelRequests === before,
      modelRequests: modelRequests - before,
      usage: turnUsage(modelCalls.slice(callsBefore)),
      choices: choicesOf(shownCalls),
      page: page ? { at: page.location(), ran: page.ran.slice(ranBefore) } : null,
      outcome: outcome.status,
      ...(stopReason ? { stopReason } : {}),
    };
    if (outcome.status === 'failed') fail(index, 'turn', `the turn failed: ${outcome.error.code} ${outcome.error.message}`);
    turns.push(record);
    return { record, stored: storedText(messages) };
  };

  try {
    let held: StaffSpeaker | null = null;
    for (const [index, turn] of scenario.turns.entries()) {
      if ('staff' in turn) {
        const action = turn.staff;
        if ('takeOver' in action) {
          const { displayName, role, userId } = action.takeOver;
          held = { userId: userId ?? `staff-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, displayName, ...(role ? { role } : {}) };
          stops.hold(conversationId, held);
          await history.append(conversationId, { role: 'staff', speaker: held, content: null, takeover: 'taken_over' });
        } else if ('say' in action) {
          await history.append(conversationId, { role: 'staff', speaker: held!, content: action.say });
        } else {
          stops.release(conversationId);
          await history.append(conversationId, { role: 'staff', speaker: held!, content: null, takeover: 'handed_back' });
          held = null;
        }
        continue;
      }
      let ran: Awaited<ReturnType<typeof runTurn>>;
      if ('user' in turn) {
        ran = await runTurn(index, 'user', { content: turn.user });
      } else {
        const waiting = turns.at(-1)?.approval ? approvals.asked.at(-1) : undefined;
        if (!waiting) {
          fail(index, 'scenario', `the customer answers an approval, but the turn before asked for none`);
          break;
        }
        const decided = approvals.answer(waiting.approvalId, { userId: customer.userId, decision: turn.approval, channel: approvalChannel });
        if (!decided.ok) {
          fail(index, 'scenario', `the approval of ${waiting.tool} could not be decided: ${decided.reason}`);
          break;
        }
        // The approval store hands the person's tab its grant, so the page runs the approved request.
        if (page && decided.decision === 'approve') page.grant({ approvalId: decided.approvalId, argsHash: decided.argsHash, expiresAt: decided.expiresAt });
        ran = await runTurn(index, 'approval', {
          content: '',
          approval:
            turn.approval === 'approve'
              ? { approvalId: waiting.approvalId, decision: 'approve', token: decided.decision === 'approve' ? decided.token : '' }
              : { approvalId: waiting.approvalId, decision: 'decline' },
        });
      }
      const expectation = mergeExpectations(turn.expect, turn.expectOn?.[channel]);
      for (const failure of await check(expectation, ran.record, ran.stored, judgeModel, { judge: config.judgeOptions })) {
        fail(index, failure.assertion, failure.message, failure.kind ?? 'assertion');
      }
    }
  } catch (err) {
    fail(currentTurn, 'turn', `the run stopped: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    page?.close();
  }

  // Replayed, the run asks exactly what was recorded: fewer requests is a run that went another way.
  if (mode === 'replay' && failures.length === 0 && modelRequests !== recorded) {
    fail(-1, 'recording', `the recording holds ${recorded} model responses and the run asked for ${modelRequests}: record it again with \`agent-evals --record\``);
  }
  if (mode === 'record') {
    writeCassette(path, {
      version: CASSETTE_VERSION,
      suite: suite.name,
      scenario: scenario.id,
      channel,
      model: describeModel(providerModel),
      recordedAt: new Date().toISOString(),
      fingerprint: configured,
      exchanges,
    });
  }
  return result();
}

// ─── Checking a turn ────────────────────────────────────────────────────────

/** A turn's general expectation and its channel's, as one: lists joined, the channel's single values winning. */
export function mergeExpectations(general?: AgentEvalExpectation, channel?: AgentEvalExpectation): AgentEvalExpectation {
  if (!general) return channel ?? {};
  if (!channel) return general;
  const lists = ['says', 'mustNotSay', 'toolCalled', 'toolNotCalled', 'doesNotStore', 'calls'] as const;
  const merged: Record<string, unknown> = { ...general, ...channel };
  for (const key of lists) {
    const joined = [...(general[key] ?? []), ...(channel[key] ?? [])];
    if (joined.length > 0) merged[key] = joined;
  }
  return merged as AgentEvalExpectation;
}

type Judge = Parameters<typeof judge>[0];

/** One way a turn broke its expectation; `kind: 'judge'` when a rubric could not be judged at all. */
export interface CheckFailure {
  assertion: string;
  message: string;
  kind?: 'assertion' | 'judge';
}

/** Whether a matcher matches `text`; a rubric is put to the judge. */
async function matches(
  matcher: AgentEvalTextMatcher,
  text: string,
  record: EvalTurnRecord,
  judgeModel: Judge,
  options: JudgeOptions | undefined,
): Promise<{ matched: boolean; why?: string } | { error: string }> {
  if (typeof matcher === 'object' && 'rubric' in matcher) {
    const verdict = await judge(judgeModel, matcher.rubric, record.customer, text, options);
    return 'error' in verdict ? verdict : { matched: verdict.pass, why: verdict.reason };
  }
  return { matched: matchesText(matcher, text) };
}

const quoted = (text: string) => JSON.stringify(text.length > 400 ? `${text.slice(0, 400)}…` : text);
const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;

/** A page action named either way: by its id (`service-lane.view`) or by its name in the index (`service_lane_view`). */
const sameAction = (a: string, b: string) => a === b || toolName(a) === toolName(b);

/** How a bound reads in a report: "1", "at least 2", "at most 40,000", "2 to 4". */
function describeBound(bound: { min?: number; max?: number }, format: (n: number) => string = (n) => n.toLocaleString('en-US')): string {
  if (bound.min !== undefined && bound.max !== undefined) return bound.min === bound.max ? format(bound.min) : `${format(bound.min)} to ${format(bound.max)}`;
  return bound.min !== undefined ? `at least ${format(bound.min)}` : `at most ${format(bound.max!)}`;
}
const within = (value: number, bound: { min?: number; max?: number }) =>
  (bound.min === undefined || value >= bound.min) && (bound.max === undefined || value <= bound.max);

/** Where an address points: its path, and its query's parameters. */
function addressOf(address: string): { path: string; query: Record<string, string> } {
  const url = new URL(address, 'http://page.invalid');
  return { path: url.pathname.replace(/\/+$/, '') || '/', query: Object.fromEntries(url.searchParams) };
}

/** Every way a turn breaks its expectation. */
export async function check(
  expect: AgentEvalExpectation,
  record: EvalTurnRecord,
  stored: string,
  judgeModel: Judge,
  options: { judge?: JudgeOptions } = {},
): Promise<CheckFailure[]> {
  const out: CheckFailure[] = [];
  const reply = record.reply;

  const textAssertion = async (assertion: string, matcher: AgentEvalTextMatcher, text: string, want: boolean, what: string) => {
    const got = await matches(matcher, text, record, judgeModel, options.judge);
    if ('error' in got) {
      out.push({ assertion, message: `${describeMatcher(matcher)} could not be judged: ${got.error}`, kind: 'judge' });
    } else if (got.matched !== want) {
      out.push({
        assertion,
        message: `${what} ${want ? 'does not match' : 'matches'} ${describeMatcher(matcher)}${got.why ? ` (judge: ${got.why})` : ''}: ${quoted(text)}`,
      });
    }
  };

  for (const matcher of expect.says ?? []) await textAssertion('says', matcher, reply, true, 'the reply');
  for (const matcher of expect.mustNotSay ?? []) await textAssertion('mustNotSay', matcher, reply, false, 'the reply');
  if (expect.refusal !== undefined) {
    await textAssertion('refusal', expect.refusal === true ? DEFAULT_REFUSAL : expect.refusal, reply, true, 'the reply, as a refusal,');
  }
  for (const matcher of expect.doesNotStore ?? []) await textAssertion('doesNotStore', matcher, stored, false, 'what the turn stored');

  const calls = record.toolCalls;
  const describeCall = (c: { name: string; args: Record<string, unknown> }) =>
    c.name === UI_ACT_TOOL && typeof c.args.action === 'string' ? `${UI_ACT_TOOL} ${c.args.action} ${JSON.stringify(c.args.input ?? {})}` : `${c.name} ${JSON.stringify(c.args)}`;
  const callsText = calls.length ? calls.map(describeCall).join('; ') : 'no tool';
  for (const wanted of expect.toolCalled ?? []) {
    const hit = calls.some((c) => c.name === wanted.name && (wanted.args === undefined || holdsSubset(c.args, wanted.args)));
    if (!hit) {
      out.push({
        assertion: 'toolCalled',
        message: `${wanted.name}${wanted.args ? ` with ${JSON.stringify(wanted.args)}` : ''} was not called; the agent called ${callsText}`,
      });
    }
  }
  for (const name of expect.toolNotCalled ?? []) {
    const hit = name === '*' ? calls.length > 0 : calls.some((c) => c.name === name);
    if (hit) out.push({ assertion: 'toolNotCalled', message: `${name === '*' ? 'a tool' : name} was called: ${callsText}` });
  }

  for (const counted of expect.calls ?? []) {
    const n = calls.filter((c) =>
      'tool' in counted
        ? c.name === counted.tool && (counted.args === undefined || holdsSubset(c.args, counted.args))
        : c.name === UI_ACT_TOOL &&
          typeof c.args.action === 'string' &&
          sameAction(c.args.action, counted.action) &&
          (counted.args === undefined || holdsSubset(c.args.input ?? {}, counted.args)),
    ).length;
    const bound: AgentEvalBound =
      counted.times !== undefined
        ? { min: counted.times, max: counted.times }
        : counted.min === undefined && counted.max === undefined
          ? { min: 1 }
          : { ...(counted.min !== undefined ? { min: counted.min } : {}), ...(counted.max !== undefined ? { max: counted.max } : {}) };
    if (!within(n, bound)) {
      const what = 'tool' in counted ? counted.tool : `the page's action ${counted.action}`;
      out.push({
        assertion: 'calls',
        message: `${what}${counted.args ? ` with ${JSON.stringify(counted.args)}` : ''} was called ${n} time${n === 1 ? '' : 's'}, not ${describeBound(bound)}; the agent called ${callsText}`,
      });
    }
  }

  if (expect.approvalRequested === false) {
    if (record.approval) out.push({ assertion: 'approvalRequested', message: `the turn stopped for approval of ${record.approval.tool}` });
  } else if (expect.approvalRequested) {
    const wanted = expect.approvalRequested;
    const asked = record.approval;
    if (!asked) {
      out.push({ assertion: 'approvalRequested', message: `the turn did not stop for an approval; the agent called ${callsText}` });
    } else {
      if (wanted.tool && asked.tool !== wanted.tool) out.push({ assertion: 'approvalRequested', message: `the approval is of ${asked.tool}, not ${wanted.tool}` });
      if (wanted.args && !holdsSubset(asked.args, wanted.args)) {
        out.push({ assertion: 'approvalRequested', message: `the approval is of ${JSON.stringify(asked.args)}, which does not hold ${JSON.stringify(wanted.args)}` });
      }
      if (!asked.preview.readback.trim()) out.push({ assertion: 'approvalRequested', message: 'the approval has no readback' });
      else if (wanted.readback) await textAssertion('approvalRequested', wanted.readback, asked.preview.readback, true, 'the readback');
    }
  }

  if (expect.held !== undefined && record.held !== expect.held) {
    out.push({
      assertion: 'held',
      message: expect.held
        ? `the turn ran (${record.modelRequests} model request${record.modelRequests === 1 ? '' : 's'}, ${record.stopReason ?? record.outcome}): it should not have, while a person held the conversation`
        : 'the turn did not run: a person held the conversation',
    });
  }

  if (expect.usage) {
    const u = record.usage;
    const bounds: Array<[string, number, AgentEvalBound | undefined, string]> = [
      ['modelCalls', u.calls.length, expect.usage.modelCalls, 'model calls'],
      ['firstCallInputTokens', u.firstCallInputTokens, expect.usage.firstCallInputTokens, 'input tokens in its first model call'],
      ['inputTokens', u.inputTokens, expect.usage.inputTokens, 'input tokens in all its model calls'],
      ['outputTokens', u.outputTokens, expect.usage.outputTokens, 'output tokens'],
    ];
    for (const [name, value, bound, what] of bounds) {
      if (bound && !within(value, bound)) out.push({ assertion: `usage.${name}`, message: `the turn used ${value.toLocaleString('en-US')} ${what}, not ${describeBound(bound)}` });
    }
    const perCall = expect.usage.callInputTokens;
    if (perCall) {
      const outside = u.calls.map((c, i) => [i + 1, c.inputTokens] as const).filter(([, n]) => !within(n, perCall));
      if (outside.length > 0) {
        out.push({
          assertion: 'usage.callInputTokens',
          message: `${outside.map(([i, n]) => `call ${i} used ${n.toLocaleString('en-US')}`).join(', ')} input tokens, not ${describeBound(perCall)} each`,
        });
      }
    }
    const share = expect.usage.cachedShare;
    if (share && !within(u.cachedShare, share)) {
      out.push({
        assertion: 'usage.cachedShare',
        message: `${pct(u.cachedShare)} of its input (${u.cacheReadTokens.toLocaleString('en-US')} of ${u.inputTokens.toLocaleString('en-US')} tokens) was read from the prompt cache, not ${describeBound(share, pct)}`,
      });
    }
  }

  if (expect.choices === false) {
    if (record.choices.length > 0) {
      out.push({ assertion: 'choices', message: `the turn offered choices: ${record.choices.flatMap((c) => c.options.map((o) => JSON.stringify(o.label))).join(', ')}` });
    }
  } else if (expect.choices) {
    const wanted = expect.choices;
    const options = record.choices.flatMap((c) => c.options);
    if (record.choices.length === 0) {
      out.push({ assertion: 'choices', message: `the turn offered no choices; the agent called ${callsText}` });
    } else {
      const optionText = (o: (typeof options)[number]) => (o.description ? `${o.label}: ${o.description}` : o.label);
      const listed = options.map((o) => `- ${optionText(o)}`).join('\n');
      for (const matcher of wanted.options ?? []) {
        if (typeof matcher === 'object' && 'rubric' in matcher) {
          // A judge reads the options as the person sees them.
          await textAssertion('choices', matcher, listed, true, 'the choices offered');
        } else if (!options.some((o) => matchesText(matcher, optionText(o)))) {
          out.push({ assertion: 'choices', message: `no choice offered matches ${describeMatcher(matcher)}: ${options.map((o) => JSON.stringify(o.label)).join(', ')}` });
        }
      }
      const question = record.choices.map((c) => c.question).join('\n\n');
      for (const matcher of wanted.question ?? []) await textAssertion('choices', matcher, question, true, 'the question asked with the choices');
      if (wanted.count && !within(options.length, wanted.count)) {
        out.push({ assertion: 'choices', message: `${options.length} choice${options.length === 1 ? ' was' : 's were'} offered, not ${describeBound(wanted.count)}` });
      }
    }
  }

  if (expect.page) {
    const wanted = expect.page;
    const page = record.page;
    if (!page) {
      out.push({ assertion: 'page', message: 'the scenario has no page: give the suite or the scenario one (`page`)' });
    } else {
      const ranText = page.ran.length ? page.ran.map((r) => `${r.action} ${JSON.stringify(r.input)}`).join('; ') : 'nothing';
      if (wanted.at !== undefined) {
        const want = addressOf(wanted.at);
        const got = addressOf(page.at);
        if (got.path !== want.path || !Object.entries(want.query).every(([k, v]) => got.query[k] === v)) {
          out.push({ assertion: 'page.at', message: `the page is at ${page.at}, not ${wanted.at}` });
        }
      }
      for (const run of wanted.ran ?? []) {
        const hit = page.ran.some((r) => (sameAction(r.action, run.action) || sameAction(r.id, run.action)) && (run.input === undefined || holdsSubset(r.input, run.input)));
        if (!hit) out.push({ assertion: 'page.ran', message: `${run.action}${run.input ? ` with ${JSON.stringify(run.input)}` : ''} did not run on the page; it ran ${ranText}` });
      }
      for (const name of wanted.notRan ?? []) {
        const hit = name === '*' ? page.ran.length > 0 : page.ran.some((r) => sameAction(r.action, name) || sameAction(r.id, name));
        if (hit) out.push({ assertion: 'page.notRan', message: `${name === '*' ? 'an action' : name} ran on the page: ${ranText}` });
      }
    }
  }
  return out;
}
