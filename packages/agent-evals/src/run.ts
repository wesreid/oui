/**
 * Running a suite (ADR-0260 §3): every scenario on every channel it runs on,
 * each turn through the SDK's own turn runner with the product's real agent
 * configuration, and every expectation checked after its turn.
 *
 * What the harness replaces is only what reaches the outside: the model's
 * network (replayed, recorded or live), storage (one conversation in memory),
 * the realtime server (memory.ts) and each tool's execution (its stub).
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
  historyOf,
  hostSystemPrompt,
  withoutClientUI,
  type AgentTurnPayload,
  type RegisteredTool,
  type ToolExecutionResult,
  type TurnHistoryMessage,
  type TurnMessage,
  type TurnOutcome,
} from '@ouispec/agent-worker';
import { recordingFetch, replayingFetch, type RecordedExchange } from '@ouispec/agent-worker/testing';
import type { AgentEvalExpectation, AgentEvalScenario, AgentEvalSuite, AgentEvalTextMatcher } from '@ouispec/contract';
import type { AgentEvalConfig, EvalAgentConfig, EvalChannel, EvalMode } from './config.js';
import { CASSETTE_VERSION, cassettePath, fingerprint, readCassette, writeCassette } from './cassettes.js';
import { checkSuite, readSuiteFile } from './suite.js';
import { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from './matchers.js';
import { judge } from './judge.js';
import { NO_PAGE, createMemoryApprovalStore, createMemoryEmit, createMemoryStops } from './memory.js';

// ─── What a run reports ─────────────────────────────────────────────────────

/** One assertion that did not hold, or why a case could not be run. */
export interface EvalFailure {
  /** The turn it is about (0-based, in the scenario's turns); -1 for the case as a whole. */
  turn: number;
  /** `says`, `toolCalled`, …; `recording`, `stub`, `scenario` or `turn` for what stopped the case. */
  assertion: string;
  message: string;
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
  modelRequests: number;
  outcome: TurnOutcome['status'];
  stopReason?: string;
}

export interface EvalCaseResult {
  suite: string;
  scenario: string;
  title: string;
  channel: string;
  mode: EvalMode;
  passed: boolean;
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

export const failureLine = (f: EvalFailure) => `${f.turn >= 0 ? `turn ${f.turn + 1}, ` : ''}${f.assertion}: ${f.message}`;

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
  const passed = results.filter((r) => r.passed).length;
  return { mode: options.mode ?? 'replay', cases: results, passed, failed: results.length - passed };
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
] as const satisfies ReadonlyArray<keyof EvalAgentConfig>;

/** Only the parts a turn runs with: anything else a product's configuration carries (its storage, its realtime server) stays out. */
function agentParts(config: EvalAgentConfig): Omit<EvalAgentConfig, 'tools'> {
  const parts: Record<string, unknown> = {};
  for (const key of AGENT_PARTS) if (config[key] !== undefined) parts[key] = config[key];
  return parts as Omit<EvalAgentConfig, 'tools'>;
}

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
  const fail = (turn: number, assertion: string, message: string) => failures.push({ turn, assertion, message });
  const path = cassettePath(target.cassettes, suite, scenario, channel);
  let modelRequests = 0;
  const result = (): EvalCaseResult => ({
    suite: suite.name,
    scenario: scenario.id,
    title: scenario.title,
    channel,
    mode,
    passed: failures.length === 0,
    failures,
    turns,
    cassette: path,
    modelRequests,
    durationMs: Date.now() - started,
  });

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
  const configured = fingerprint({
    systemPrompt: hostSystemPrompt(agent, { ...customer, context: withoutClientUI(context) }),
    tools: await resolveTools(`${conversationId}-0`),
    channel: { name: channel, settings },
    suite,
    scenario,
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
  const model = config.model({ fetch: counted, mode, purpose: 'agent' });
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
      fail(currentTurn, 'stub', `the agent called ${tool.name} with ${JSON.stringify(args)}, and no stub answers that call`);
      return { success: false, error: `[agent-evals] ${tool.name} has no stub for this call; nothing was run` };
    },
  });

  // The realtime server and the product's store, in memory.
  const emit = createMemoryEmit();
  const approvals = createMemoryApprovalStore();
  const stops = createMemoryStops();
  const history: TurnHistoryMessage[] = [];
  let snapshot: TurnHistoryMessage[] = [];
  let stored: Array<{ messages: TurnMessage[]; stopped?: TurnStoppedMarker }> = [];
  const runner = createAgentTurnRunner<null>({
    ...agentParts(agent),
    tools: async ({ turnId }) => (await resolveTools(turnId)).map(wrap),
    model,
    ...(config.promptCacheBreakpoint ? { promptCacheBreakpoint: config.promptCacheBreakpoint } : {}),
    realtime: { url: NOWHERE, apiKey: 'agent-evals', emit },
    uiActions: { channel: NO_PAGE },
    approvals: { store: approvals },
    stops: { client: stops },
    getDb: async () => null,
    getHistory: async () => snapshot,
    persistMessages: async ({ messages, stopped }) => {
      stored.push({ messages, ...(stopped ? { stopped } : {}) });
      history.push(...historyOf(messages));
    },
    logger: QUIET,
  });

  const runTurn = async (index: number, kind: 'user' | 'approval', payload: Pick<AgentTurnPayload, 'content' | 'approval'>) => {
    currentTurn = index;
    const turnId = `${conversationId}-${index}`;
    snapshot = [...history];
    if (kind === 'user') history.push({ role: 'user', content: payload.content });
    stored = [];
    const before = modelRequests;
    const outcome = await runner.run({
      turnId,
      conversationId,
      ...customer,
      socketRoom: `eval:turn:${turnId}`,
      content: payload.content,
      context: kind === 'user' ? context : sharedContext,
      channel: approvalChannel,
      ...(payload.approval ? { approval: payload.approval } : {}),
    });
    const messages = stored.flatMap((s) => s.messages);
    const asked = emit.events.find((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED && e.data.turnId === turnId);
    const pending = asked ? approvals.asked.find((a) => a.approvalId === asked.data.approvalId) : undefined;
    const stopReason = outcome.status === 'stopped' ? outcome.stopReason : undefined;
    const record: EvalTurnRecord = {
      turn: index,
      kind,
      customer: payload.content,
      reply: replyOf(messages),
      toolCalls: messages.flatMap((m) => (m.toolCalls ?? []).map((c) => ({ name: c.name, args: c.arguments }))),
      approval: pending ? { tool: pending.tool, args: pending.args, preview: pending.preview } : null,
      held: stopReason === 'taken_over' && modelRequests === before,
      modelRequests: modelRequests - before,
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
          history.push({ role: 'staff', speaker: held, content: null, takeover: 'taken_over' });
        } else if ('say' in action) {
          history.push({ role: 'staff', speaker: held!, content: action.say });
        } else {
          stops.release(conversationId);
          history.push({ role: 'staff', speaker: held!, content: null, takeover: 'handed_back' });
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
        const decided = approvals.decide(waiting.approvalId, { userId: customer.userId, decision: turn.approval, channel: approvalChannel });
        if (!decided.ok) {
          fail(index, 'scenario', `the approval of ${waiting.tool} could not be decided: ${decided.reason}`);
          break;
        }
        ran = await runTurn(index, 'approval', {
          content: '',
          approval:
            turn.approval === 'approve'
              ? { approvalId: waiting.approvalId, decision: 'approve', token: decided.token! }
              : { approvalId: waiting.approvalId, decision: 'decline' },
        });
      }
      const expectation = mergeExpectations(turn.expect, turn.expectOn?.[channel]);
      for (const failure of await check(expectation, ran.record, ran.stored, judgeModel)) fail(index, failure.assertion, failure.message);
    }
  } catch (err) {
    fail(currentTurn, 'turn', `the run stopped: ${err instanceof Error ? err.message : String(err)}`);
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
      model: describeModel(model),
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
  const lists = ['says', 'mustNotSay', 'toolCalled', 'toolNotCalled', 'doesNotStore'] as const;
  const merged: Record<string, unknown> = { ...general, ...channel };
  for (const key of lists) {
    const joined = [...(general[key] ?? []), ...(channel[key] ?? [])];
    if (joined.length > 0) merged[key] = joined;
  }
  return merged as AgentEvalExpectation;
}

type Judge = Parameters<typeof judge>[0];

/** Whether a matcher matches `text`; a rubric is put to the judge. */
async function matches(
  matcher: AgentEvalTextMatcher,
  text: string,
  record: EvalTurnRecord,
  judgeModel: Judge,
): Promise<{ matched: boolean; why?: string } | { error: string }> {
  if (typeof matcher === 'object' && 'rubric' in matcher) {
    const verdict = await judge(judgeModel, matcher.rubric, record.customer, text);
    return 'error' in verdict ? verdict : { matched: verdict.pass, why: verdict.reason };
  }
  return { matched: matchesText(matcher, text) };
}

const quoted = (text: string) => JSON.stringify(text.length > 400 ? `${text.slice(0, 400)}…` : text);

/** Every way a turn breaks its expectation. */
export async function check(
  expect: AgentEvalExpectation,
  record: EvalTurnRecord,
  stored: string,
  judgeModel: Judge,
): Promise<Array<{ assertion: string; message: string }>> {
  const out: Array<{ assertion: string; message: string }> = [];
  const reply = record.reply;

  const textAssertion = async (assertion: string, matcher: AgentEvalTextMatcher, text: string, want: boolean, what: string) => {
    const got = await matches(matcher, text, record, judgeModel);
    if ('error' in got) {
      out.push({ assertion, message: `${describeMatcher(matcher)} could not be judged: ${got.error}` });
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
  const callsText = calls.length ? calls.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join('; ') : 'no tool';
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
  return out;
}
