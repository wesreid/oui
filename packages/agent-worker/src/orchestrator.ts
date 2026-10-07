/**
 * Agent Orchestrator — powered by Vercel AI SDK.
 *
 * The model is the host's: any `ai` library model, passed in configuration
 * (ADR-0227 §2.2, "Model"). The core names no provider. The AI SDK handles:
 *   - each provider's wire format (internal, never exposed)
 *   - tool_use / tool_result pairing (automatic, no manual repair needed)
 *   - Multi-round tool loops (via stopWhen)
 *   - True token streaming with coalescing
 *   - Step callbacks for logging
 *   - Error categorization and retries
 *
 * Our value-add stays:
 *   - UI tools from the client's OUI surfaces, answered by the client (ADR-0209)
 *   - Schema-based tool loading
 *   - Persona/prompt compilation
 *   - Emit adapter (realtime socket streaming)
 *   - ApiSurface binding for tool execution
 *   - Configurable TurnPolicy for product-specific step control
 */
import { streamText, dynamicTool, jsonSchema, isStepCount, hasToolCall } from 'ai';
import type { ModelMessage, AssistantModelMessage, ToolModelMessage, TextPart, ToolCallPart } from 'ai';
import {
  AGENT_SOCKET_EVENTS,
  argsHash,
  canonicalJson,
  turnStoppedNote,
  type ApprovalContinuation,
  type ApprovalRequiredEvent,
  type TurnStoppedMarker,
} from '@ouispec/agent-core';
import { DEFAULT_STOP_GRACE_MS, TurnStopped, stopOf, watchTurnStop, type TurnStopState } from './stop/turn-stop.js';
import { stoppedTurnMessages, type RecordedCall, type RecordedStep } from './stop/partial.js';
import { resultText, stoppedNotRun, stoppedWhileRunning } from './stop/results.js';
import type { AgentWorkerConfig, AgentTurnInput, AgentTurnResult, TurnMessage, TurnHistoryMessage } from './types.js';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from './tools/types.js';
import { defaultTurnPolicy, type StepTool } from './turn-policy.js';
import { evaluateToolPolicySafe } from './authz/tool-policy.js';
import { createToolInputValidator } from './tools/input-validation.js';
import { readClientPage, withoutClientUI, type ClientPage } from './ui/snapshot.js';
import { KNOWLEDGE_TOOL, knowledgeTool, readClientKnowledge, withClientKnowledge } from './ui/knowledge.js';
import { withNewestPageStateOnly } from './ui/newest-page-state.js';
import { withClock } from './prompt/clock.js';
import { withUserText } from './prompt/user-text.js';
import { AttachmentGuard } from './attachments/guard.js';
import { ATTACHMENT_DATA_NOTE, turnAttachmentParts, withReferenceLines, withTurnAttachments, withoutLeftOut } from './attachments/content.js';
import { attachmentTools } from './attachments/tools.js';
import { acceptsMediaType, attachmentIdsIn, attachmentNameForModel, misplacedAttachmentInputs, type AttachmentRef } from '@ouispec/agent-core';

const ATTACHMENT_LIST_HINT = 'attachment_list lists the files that can.';
import {
  buildUITools,
  createPageSight,
  DefinitionUnavailable,
  fitNotes,
  jobWaitOf,
  UI_ACT_TOOL,
  UI_DESCRIBE_TOOL,
  UI_READ_TOOL,
} from './ui/ui-tools.js';
import { DEFAULT_INDEX_CHARS, indexText, pageFingerprint, type HeldDefinitions, type PageSurface } from './ui/page-index.js';
import { describeSchema } from './ui/outline.js';
import { createUISequence, type UISlot } from './ui/ui-sequence.js';
import { createTurnLedger } from './turn-ledger.js';
import { DEFAULT_PAGE_STATE_CHARS, observationSchemas, observationsText } from './ui/observations.js';
import { approvalRequirement, APPROVAL_TOOL_NOTE, type ApprovalRequirement } from './approvals/requirement.js';
import { buildApprovalPreview, declaredTitle } from './approvals/preview.js';
import {
  approvalMarker,
  approvedExpiredMarker,
  expiredNote,
  markedResult,
  notRunResult,
  ranNote,
  refusedNote,
  resolveContinuation,
  unavailableNote,
  waitingCalls,
  withdrawnMarker,
} from './approvals/continuation.js';

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_UI_RESULT_TIMEOUT_MS = 20_000;
/** Time left, before the turn's deadline, for the model to answer after waiting on a UI action's work. */
const UI_ANSWER_MARGIN_MS = 45_000;

/**
 * Tools that hand the turn back to the user. The turn stops after any of them:
 * the model must not carry on as if the user had already answered.
 */
const USER_INPUT_TOOLS = ['present_options', 'confirm_action', 'request_user_decision'] as const;

type AgentLogNamespace = 'agent:turn' | 'agent:llm' | 'agent:tool' | 'agent:prompt' | 'agent:stream' | 'agent:ui';

function log(level: 'info' | 'warn' | 'error' | 'debug', ns: AgentLogNamespace, message: string, data?: Record<string, unknown>): void {
  const entry = { level, ns, message, timestamp: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

type AiTool = ReturnType<typeof dynamicTool>;

/** What one call came to: the text the model reads as its result, and whether the tool itself ran. */
interface CallOutcome {
  text: string;
  ran: boolean;
}

/** A call refused before its tool ran. */
const notRun = (payload: Record<string, unknown>): CallOutcome => ({ text: JSON.stringify(payload), ran: false });

/**
 * Run a complete agent turn using the Vercel AI SDK.
 *
 * A turn runs in one or more segments. Each segment is one `streamText` call
 * with a fixed tool set. When a UI action changes what the client's page
 * offers (navigating is the common case), the segment ends and the turn
 * continues in a new one whose tools are the new page's (ADR-0209 D3). The
 * round cap counts across segments.
 */
export async function runAgentTurn(
  config: AgentWorkerConfig,
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  const maxRounds = config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  // null: the model takes no temperature, so none is sent.
  const temperature = config.temperature === null ? undefined : config.temperature ?? DEFAULT_TEMPERATURE;
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const turnDeadlineMs = config.turnDeadlineMs ?? 240_000; // 4 min, below the 5 min Lambda ceiling
  const retries = config.retries ?? 3;
  const uiResultTimeoutMs = config.ui?.resultTimeoutMs ?? DEFAULT_UI_RESULT_TIMEOUT_MS;
  const uiJobWaitMs = jobWaitOf({ jobWaitMs: config.ui?.jobWaitMs });

  if (!config.model) {
    throw new Error('[agent-sdk] config.model is required: pass an `ai` library model (ADR-0227 §2.2)');
  }
  const { turnId, socketRoom } = input;

  log('info', 'agent:turn', 'Turn started', {
    turnId,
    conversationId: input.conversationId,
    userId: input.userId,
    historyLength: input.history?.length ?? 0,
    contentLength: input.content.length,
    maxRounds,
    maxTokens,
    temperature,
  });

  // ─── The client's UI (ADR-0209 D1) ─────────────────────────────────────────
  // The turn carries the surfaces of the client that sent it. They are the only
  // source of UI tools, so the tools always describe the page the user is on.
  const client = readClientPage(input.context ?? null);
  if (client && !config.ui) {
    throw new Error(
      '[agent-sdk] The turn carries UI surfaces but the worker has no UI action channel (config.ui): ' +
        'its UI actions could be sent but never answered.',
    );
  }
  // What the page offers, in index (ADR-0245 §2.1): kept current by every answer.
  let currentPage: PageSurface[] = client?.page ?? [];
  // The turn's UI actions run one at a time, in the order the model called them (ui-sequence.ts).
  const uiSequence = createUISequence();
  // The page as the turn's snapshot gave it, under the client's hash for it.
  if (client) uiSequence.record(client.page, client.surfacesHash);
  // The definitions the turn holds: those a client sent, and those fetched since.
  const heldDefinitions: HeldDefinitions = client?.held ?? new Map();
  // Whether the page can be seen (ADR-0245 §2.5): nothing that changes it runs while it cannot.
  const sight = createPageSight();
  const uiCounts = { describes: 0, reads: 0, acts: 0, guides: 0 };
  // Earlier answers' page states replaced, summed over the turn's steps.
  let pageStatesNotRepeated = 0;

  // The knowledge the client sent for its page goes after the host's prompt.
  const knowledge = readClientKnowledge(input.context ?? null);

  // ─── Files (ADR-0252 §2.11, §2.12) ─────────────────────────────────────────
  // With the host's file area, the turn's files go to the model with its
  // message, the attachment tools reach every file of the conversation, and the
  // cost guard caps what the model is given of them.
  const fileArea = config.attachments ?? null;
  const fileOwner = { userId: input.userId, accountId: input.accountId, conversationId: input.conversationId };
  let conversationFileTokens = 0;
  if (fileArea?.store.conversationUsage) {
    try {
      conversationFileTokens = await fileArea.store.conversationUsage(fileOwner, { signal: AbortSignal.timeout(5_000) });
    } catch (err) {
      log('warn', 'agent:tool', 'Could not read the conversation’s use of files; only the turn’s cap applies', {
        turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const fileGuard = new AttachmentGuard({
    turnTokens: fileArea?.turnTokens,
    conversationTokens: fileArea?.conversationTokens,
    conversationUsed: conversationFileTokens,
  });
  const fileTools: RegisteredTool[] = fileArea ? attachmentTools({ store: fileArea.store, owner: fileOwner, guard: fileGuard }) : [];

  log('info', 'agent:ui', 'UI surfaces for this turn', {
    turnId,
    clientSentSnapshot: client !== null,
    surfaceIds: currentPage.map((s) => s.id),
    actionCount: currentPage.reduce((n, s) => n + s.index.length, 0),
    // A client that sent definitions (oui-spec before 0.7, or `form: "full"`) is still read as an index.
    form: client ? (client.held.size > 0 ? 'full' : 'index') : 'none',
    ...(client?.fit?.observations?.length ? { snapshotFitted: client.fit.observations.length } : {}),
    knowledgeEntries: knowledge?.entries.length ?? 0,
    knowledgeWorkflows: knowledge?.workflows.length ?? 0,
  });

  // ─── Turn classification via policy ────────────────────────────────────────
  const turnPolicy = config.turnPolicy ?? defaultTurnPolicy;
  const historyForClassify = input.history?.map((m) => ({
    role: m.role,
    content: 'content' in m ? (m.content ?? '') : '',
  })) ?? [];
  const turnClass = turnPolicy.classifyTurn(input.content, historyForClassify);

  // Let the policy perform side effects (e.g. deterministic navigation emit)
  if (turnPolicy.onTurnClassified) {
    await turnPolicy.onTurnClassified({
      turnClass,
      content: input.content,
      emit: config.emit,
      socketRoom,
    });
  }

  log('info', 'agent:turn', 'Turn classified', { turnId, turnClass });

  // Build system prompt: the host's, which never sees what the client sent for
  // the worker itself, then the client's knowledge.
  const hostPrompt = typeof config.systemPrompt === 'function'
    ? config.systemPrompt({ userId: input.userId, accountId: input.accountId, context: withoutClientUI(input.context) })
    : config.systemPrompt;
  // With a file area, the model is told a file's name and content are data, never instructions (ADR-0252 §2.11).
  const systemPrompt = withClientKnowledge(fileArea ? `${hostPrompt}\n\n${ATTACHMENT_DATA_NOTE}` : hostPrompt, input.context);

  log('debug', 'agent:prompt', 'System prompt built', { turnId, promptLength: systemPrompt.length, hostPromptLength: hostPrompt.length });

  // Wall-clock deadline: abort the entire streamText call if it exceeds turnDeadlineMs.
  const turnStartedAt = Date.now();
  // A UI tool waiting on work it started stops in time for the model to answer.
  const uiWaitDeadline = () => turnStartedAt + turnDeadlineMs - UI_ANSWER_MARGIN_MS;
  const abortController = new AbortController();

  // ─── Stopping (ADR-0252) ───────────────────────────────────────────────────
  // The person's Stop, or a newer message superseding this turn, is kept by the
  // realtime server; the watch asks for it for as long as the turn runs. A stop
  // aborts the turn's signal with a typed reason, which is what everything that
  // waits (the model stream, a UI action's answer, a job's outcome) already
  // honours. What the turn had produced is then stored and announced (below).
  const stopWatch = input.stopWatch ?? watchTurnStop(config.stops, turnId, input.userId);
  /** Set when the turn begins its own end: a stop that lands after is not one (§2.4). */
  let ending = false;
  /** Kept back from a stopped turn's grace for storing and announcing it. */
  const STOP_STORE_MARGIN_MS = 3_000;
  /** Kept back from a stopped turn's store for announcing it. */
  const STOP_ANNOUNCE_MARGIN_MS = 1_000;
  /** The least any step of the stop path is given, however little is left. */
  const STOP_STEP_FLOOR_MS = 250;
  let stopGraceMs = config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  // The stop path's own signal: the turn's is aborted by the time anything needs one.
  let graceSignal: AbortSignal | null = null;
  const stopState: TurnStopState = {
    reason: () => stopOf(abortController.signal)?.reason ?? null,
    graceSignal: () => (graceSignal ??= AbortSignal.timeout(stopGraceMs + 250)),
    get graceMs() {
      return stopGraceMs;
    },
  };
  /** Abort the turn on its stop path: what it had produced is stored, then announced. */
  const stopTurn = (stop: TurnStopped) => {
    if (ending || abortController.signal.aborted) return;
    // Never longer than this process has left, less what storing and announcing take.
    const remaining = input.remainingMs?.();
    if (remaining !== undefined) stopGraceMs = Math.max(0, Math.min(stopGraceMs, remaining - STOP_STORE_MARGIN_MS));
    graceSignal = AbortSignal.timeout(stopGraceMs + 250);
    log('info', 'agent:turn', stop.reason === 'deadline' ? 'Turn ran out of time' : 'Turn asked to stop', {
      turnId,
      reason: stop.reason,
      graceMs: stopGraceMs,
    });
    abortController.abort(stop);
  };
  stopWatch.onStop((record) => stopTurn(new TurnStopped(record.reason, record.at)));
  // The turn's deadline ends it on the same path (ADR-0252 §6.4): what it did
  // before it ran out of time is kept, marked, and the next turn is told.
  const deadlineTimer = setTimeout(() => stopTurn(new TurnStopped('deadline', Date.now())), turnDeadlineMs);

  // Build tool execution context
  const toolCtx: ToolExecutionContext = {
    userId: input.userId,
    accountId: input.accountId,
    turnId,
    conversationId: input.conversationId,
    userToken: input.userToken,
    apiSurface: config.apiSurface,
    abortSignal: abortController.signal,
    socketRoom,
    stop: stopState,
  };

  // Track tool executions for emit events and persistence.
  // We capture toolCallId from the execute options (2nd argument).
  const executedToolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];
  // The pictures results came with, by call: given to the model with that call's result (ui/answer-image.ts).
  const answerImages = new Map<string, { mediaType: string; base64: string }>();
  // The text results came with (a file's text, read by attachment_read), by call: the model's only, like the pictures.
  const answerTexts = new Map<string, string>();

  // The worker's own record of the turn, kept as it runs: what a stopped turn
  // is stored from (stop/partial.ts). The model stream's own results do not
  // survive an abort, so nothing on the stop path reads them.
  const recordedSteps: Array<RecordedStep & { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = [];
  const recordedCalls = new Map<string, RecordedCall & { settled: Promise<void> }>();
  let streamedText = '';
  /** Records a call as it arrives, and its result when it settles. */
  const tracked = (toolCallId: string, toolName: string, callInput: unknown, run: () => Promise<string>): Promise<string> => {
    const call = { toolCallId, toolName, input: callInput, text: null as string | null, settled: Promise.resolve() };
    recordedCalls.set(toolCallId, call);
    const result = run().then((text) => {
      call.text = text;
      return text;
    });
    call.settled = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // Per-tool invocation quotas — mandatory for side-effecting tools.
  // Quota is per-turn, held in this closure — never module scope. It spans
  // segments: rebuilding the tool set does not reset what was already used.
  const toolInvocationCounts = new Map<string, number>();
  const DEFAULT_TOOL_QUOTA = 12;
  const SIDE_EFFECT_TOOL_QUOTA = 2;
  // A UI action is not counted (session 24611234: filling 12 slides of 3 values each
  // ran one action 36 times, and a cap of 12 stopped it). What is refused is a loop:
  // the same call with the same input, made again after it changed nothing three
  // times in a row. Undo five times, or nudge a layer five times, is work: each changes the page.
  const UNCHANGED_REPEATS = 3;
  const uiRepeats = new Map<string, { unchanged: number; lastState: string | null }>();

  // What each call of the turn did: said back to the model before every step
  // after one did not succeed, so its reply matches it (ADR-0244 §2.5).
  const ledger = createTurnLedger();

  // ─── Approvals (ADR-0228) ──────────────────────────────────────────────────
  // The first call in a turn that needs the user's approval stops the turn:
  // it is stored as a pending approval, the card is shown, and nothing else
  // runs until they decide. Each call is approved separately.
  let approvalHold: { approvalId: string; title: string } | null = null;

  // jsonSchema() carries no validator, so a call's arguments are whatever the
  // model produced. Each tool's declared schema is compiled once per turn.
  const validators = new WeakMap<object, ReturnType<typeof createToolInputValidator>>();
  const validatorFor = (schema: Record<string, unknown>) => {
    let v = validators.get(schema);
    if (!v) {
      // The schema the tool DECLARED, not the model-facing stand-in: a strict
      // empty schema only gives the model a valid schema for a tool that
      // declared no properties, and enforcing it would reject input such a
      // tool has always received.
      v = createToolInputValidator(schema);
      validators.set(schema, v);
    }
    return v;
  };

  /**
   * Runs one call of a tool: validation, quota, policy, approval, then the
   * tool. `approved` is set only for the call a redeemed approval token names,
   * in the turn after the user's decision.
   */
  const executeCall = async (
    t: RegisteredTool,
    rawArgs: unknown,
    toolUseId: string,
    uiSlot: UISlot | undefined,
    approved?: { approvalId: string; argsHash: string },
  ): Promise<CallOutcome> => {
    const startMs = Date.now();
    const isUI = t.kind === 'ui';

    // A stopped turn starts nothing more.
    if (stopState.reason()) return { text: resultText(stoppedNotRun(t.name)), ran: false };

    /**
     * A call refused before its tool ran: invalid input, over its quota, or
     * denied by policy. The model gets the reason; so does the client, as a
     * call that started and failed, so a session's record holds every call
     * the model made with its arguments (ADR-0244 §2.7).
     */
    const refused = async (payload: { error: string } & Record<string, unknown>, given: unknown): Promise<CallOutcome> => {
      ledger.record({ tool: t.name, ok: false, error: payload.error });
      const now = Date.now();
      await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, {
        turnId,
        toolUseId,
        name: t.name,
        input: given,
        timestamp: now,
      });
      await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE, {
        turnId,
        toolUseId,
        name: t.name,
        result: { error: payload.error, refused: true },
        success: false,
        durationMs: 0,
        timestamp: now,
      });
      return notRun({ success: false, ...payload });
    };
    // A UI tool waits for the client's answer, which has its own deadline, and
    // then for the outcome of work it started: for uiJobWaitMs at most, and
    // never past uiWaitDeadline.
    const timeoutMs = isUI
      ? Math.max(
          toolTimeoutMs,
          uiResultTimeoutMs + 5_000,
          Math.min(uiJobWaitMs, Math.max(0, uiWaitDeadline() - Date.now())) + uiResultTimeoutMs + 5_000,
        )
      : toolTimeoutMs;

    // ── No changes while blind (ADR-0245 §2.5) ──
    // After an answer that came without the page's state, or no answer, only
    // reading runs until a read shows the page again. A change called then is
    // refused here, before its definition is fetched or policy is asked; one
    // called in the same response as the action that blinded the turn is
    // refused in its place in the UI order (ui-tools.ts).
    const reads = isUI && t.effect === 'view';
    if (isUI && !reads) {
      const refusal = sight.refuseChange();
      if (refusal) {
        log('warn', 'agent:ui', 'UI action refused: the page cannot be seen', { turnId, toolName: t.name, stopped: refusal.stopped });
        return refused({ error: refusal.error, notRun: true, ...(refusal.stopped ? { uiStopped: true } : { blind: true }) }, rawArgs);
      }
    }

    // ── Input validation ──
    // Before quota and policy: an invalid call consumes no quota and never
    // reaches the host. The model gets the errors so it can correct the call.
    // A UI action's schema is its definition's, fetched from the page when the
    // action is first used (ADR-0245 §2.1).
    let schema = (t.inputSchema ?? {}) as Record<string, unknown>;
    if (t.resolveInputSchema) {
      try {
        schema = await t.resolveInputSchema({ ...toolCtx, toolCallId: toolUseId });
      } catch (err) {
        if (!(err instanceof DefinitionUnavailable)) throw err;
        return refused({ error: err.message, notRun: true }, rawArgs);
      }
    }
    const validation = validatorFor(schema)(rawArgs);
    if (!validation.ok) {
      log('warn', 'agent:tool', 'Tool call rejected: invalid input', {
        turnId,
        toolName: t.name,
        errors: validation.errors,
      });
      // A UI action's input was written from its line in the index or from an
      // outline: say what it takes, so the next call is right.
      const takes = isUI ? describeSchema(schema) : null;
      return refused(
        {
          error: `Invalid input for "${t.name}": ${validation.errors.join('; ')}`,
          invalidInput: true,
          ...(takes && !('error' in takes)
            ? takes.whole
              ? { takes: JSON.parse(takes.text) as unknown }
              : { takesInOutline: takes.text, openAPart: `${UI_DESCRIBE_TOOL} with this action and a path` }
            : {}),
        },
        rawArgs,
      );
    }
    const args = validation.value;

    // ── Attached files named in the call (ADR-0252 §2.13) ──
    // Each must be a file of this turn's conversation, ready, and of a type the
    // input takes, checked before anything is dispatched; the page then
    // resolves it through its own host. An action declaring a file where none
    // can be checked is not run at all.
    const misplaced = misplacedAttachmentInputs(schema);
    if (misplaced.length > 0) {
      return refused(
        {
          error: `"${t.name}" declares an attached file at ${misplaced.join(', ')}, where none can be checked: it cannot be run with a file.`,
          notRun: true,
        },
        args,
      );
    }
    const namedFiles = attachmentIdsIn(schema, args);
    const callFiles = new Map<string, AttachmentRef>();
    if (namedFiles.length > 0) {
      if (!fileArea) {
        return refused({ error: `"${t.name}" takes an attached file, and this assistant cannot use attached files.`, notRun: true }, args);
      }
      const ids = [...new Set(namedFiles.map((f) => f.id))];
      try {
        for (const ref of await fileArea.store.describe(ids, fileOwner, { signal: abortController.signal })) callFiles.set(ref.id, ref);
      } catch (err) {
        log('warn', 'agent:tool', 'Could not check the files a call names; it was not run', {
          turnId,
          toolName: t.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return refused({ error: `The files "${t.name}" names could not be checked just now. It was not run; try again.`, notRun: true }, args);
      }
      const missing = ids.filter((id) => !callFiles.has(id) || callFiles.get(id)!.removed);
      if (missing.length > 0) {
        return refused(
          {
            error: `${missing.map((id) => `"${id}"`).join(', ')} ${missing.length === 1 ? 'is not a file' : 'are not files'} of this conversation that can be used. ${ATTACHMENT_LIST_HINT}`,
            notRun: true,
          },
          args,
        );
      }
      const pending = ids.filter((id) => callFiles.get(id)!.pending);
      if (pending.length > 0) {
        return refused(
          {
            error: `${pending.map((id) => `"${id}"`).join(', ')} ${pending.length === 1 ? 'is' : 'are'} still being checked, and can be used once that is done. It was not run.`,
            notRun: true,
          },
          args,
        );
      }
      // The type each input takes, checked here as the page checks it (OUI spec §7.3.11).
      const wrongType = namedFiles.filter((f) => !acceptsMediaType(f.input, callFiles.get(f.id)!.mediaType));
      if (wrongType.length > 0) {
        return refused(
          {
            error: wrongType
              .map((f) => {
                const ref = callFiles.get(f.id)!;
                return `${f.property}: ${attachmentNameForModel(ref.name)} (${f.id}) is ${ref.mediaType}; it takes ${f.input.mediaTypes!.join(', ')}.`;
              })
              .join(' '),
            notRun: true,
          },
          args,
        );
      }
    }
    // Told to the model with the result, so it sends the value itself next time (below).
    const readFromText = validation.coerced ?? [];

    // The call as a repeat is judged by: its name and its exact input. Set for a UI action that changes the page.
    let repeatKey: string | null = null;

    // ── Quota enforcement ──
    // UI actions run as the user in their own session (ADR-0182 §3), so the
    // backend side-effect cap does not apply to them (ADR-0209 D5). They are
    // bounded by the turn's steps and deadline; only a repeated identical call is refused.
    const currentCount = toolInvocationCounts.get(t.name) ?? 0;
    const isSideEffecting = schema.sideEffects !== false; // fail-closed: undefined = side-effecting
    if (isUI) {
      // A UI action that only reads (a room's inspect and query, ADR-0244 §2.2)
      // changes nothing however often it is called.
      if (!reads) {
        let input: string;
        try {
          input = canonicalJson(args);
        } catch {
          input = JSON.stringify(args);
        }
        repeatKey = `${t.name} ${input}`;
        const unchanged = uiRepeats.get(repeatKey)?.unchanged ?? 0;
        if (unchanged >= UNCHANGED_REPEATS) {
          return refused(
            {
              error:
                `"${t.name}" with exactly this input has changed nothing the last ${unchanged} times it ran in this turn. ` +
                'Running it again would change nothing again: read the page for why, then change the input or stop.',
              repeatedCall: true,
            },
            args,
          );
        }
      }
    } else {
      const quota = isSideEffecting ? SIDE_EFFECT_TOOL_QUOTA : DEFAULT_TOOL_QUOTA;
      if (currentCount >= quota) {
        return refused(
          {
            error: `Tool "${t.name}" has reached its maximum invocation quota of ${quota} for this turn. Please proceed without calling it again.`,
            quotaExceeded: true,
          },
          args,
        );
      }
      toolInvocationCounts.set(t.name, currentCount + 1);
    }

    // ── Policy enforcement ──
    // A deny always wins, over an approval too (ADR-0228 §2.1).
    const requirement = approvalRequirement(t);
    let policyRequiresApproval = false;
    if (config.toolPolicy) {
      const decision = await evaluateToolPolicySafe(config.toolPolicy, {
        userId: input.userId,
        accountId: input.accountId,
        toolName: t.name,
        args,
        turnId,
        hasSideEffects: isSideEffecting,
        toolKind: isUI ? 'ui' : 'backend',
        ...(t.toolClass ? { toolClass: t.toolClass } : {}),
        effect: requirement.effect,
        destructive: requirement.destructive,
      });

      if (decision.action === 'deny') {
        return refused({ error: decision.reason, policyDenied: true }, args);
      }
      policyRequiresApproval = decision.action === 'require_approval';
    }

    // ── Approval (ADR-0228) ──
    // Checked and set with no await in between, so of the calls in one
    // response exactly the first that needs approval stops the turn.
    if (approvalHold && !approved) {
      const error =
        `Not run: this turn is waiting for the user's approval of "${approvalHold.title}". ` +
        'Nothing else runs until they decide; ask again afterwards if it is still needed.';
      ledger.record({ tool: t.name, ok: false, error });
      return notRun({ success: false, notRun: true, error });
    }
    if ((requirement.required || policyRequiresApproval) && !approved) {
      ledger.record({ tool: t.name, ok: false, error: 'Not run: it waits for the user’s approval on the card' });
      return { text: await requestApproval(t, args, toolUseId, requirement, callFiles), ran: false };
    }

    if (t.name === UI_DESCRIBE_TOOL) uiCounts.describes++;
    else if (t.name === UI_READ_TOOL) uiCounts.reads++;
    // It reads what the client sent, and touches no page.
    else if (t.name === KNOWLEDGE_TOOL) uiCounts.guides++;
    else if (isUI) uiCounts.acts++;

    log('info', 'agent:tool', 'Tool call started', {
      turnId,
      toolName: t.name,
      kind: t.kind ?? 'backend',
      input: args,
      ...(approved ? { approvalId: approved.approvalId } : {}),
    });

    // Emit tool call started BEFORE execution
    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, {
      turnId,
      toolUseId,
      name: t.name,
      input: args,
      timestamp: startMs,
    });

    // Execute with timeout
    let result: ToolExecutionResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        t.execute(args, {
          ...toolCtx,
          toolCallId: toolUseId,
          ...(uiSlot ? { uiSlot } : {}),
          ...(approved ? { approval: approved } : {}),
        }),
        new Promise<ToolExecutionResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool ${t.name} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A host tool that the stop cut short failed with whatever its abort threw:
    // its result says what happened instead. (A UI tool says so itself.)
    if (!isUI && stopState.reason() && result && typeof result === 'object' && 'success' in result && !result.success) {
      result = stoppedWhileRunning(t.name);
    }

    const durationMs = Date.now() - startMs;

    // Normalize result — built-in tools (present_options, etc.) return the
    // raw payload directly, while schema and UI tools return { success, data, error }.
    const isWrapped = result && typeof result === 'object' && 'success' in result;
    const resultData = isWrapped ? (result.data ?? result.error ?? null) : result;
    const resultSuccess = isWrapped ? result.success : true;
    // A failed call that still carries data (a UI action's page state) must
    // not lose its error message on the way to the model.
    const payload = isWrapped && !result.success && result.data !== undefined && result.error
      ? { error: result.error, ...(result.data as Record<string, unknown>) }
      : resultData;
    const modelPayload =
      readFromText.length > 0 && payload && typeof payload === 'object' && !Array.isArray(payload)
        ? {
            ...(payload as Record<string, unknown>),
            inputNote:
              `${readFromText.map((k) => `"${k}"`).join(', ')} arrived as JSON text and ${readFromText.length === 1 ? 'was' : 'were'} read as the ` +
              'list or object it spells. Send a list or an object as itself, not inside a string.',
          }
        : payload;

    log('info', 'agent:tool', 'Tool call completed', {
      turnId,
      toolName: t.name,
      success: resultSuccess,
      durationMs,
      ...(isUI && !resultSuccess ? { error: isWrapped ? result.error : undefined } : {}),
    });

    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE, {
      turnId,
      toolUseId,
      name: t.name,
      result: modelPayload,
      success: resultSuccess,
      durationMs,
      timestamp: Date.now(),
    });

    ledger.record({
      tool: t.name,
      ok: resultSuccess,
      ...(resultSuccess ? {} : { error: isWrapped && result.error ? result.error : 'it did not succeed' }),
    });

    // Did this run change the page? Not when it failed, when the page says it changed no row,
    // or when the page's state is what it was after the same call last ran.
    if (repeatKey) {
      const answer = (modelPayload ?? {}) as { state?: unknown; result?: { changed?: unknown } };
      const state = answer.state === undefined ? null : JSON.stringify(answer.state);
      const changed = answer.result?.changed;
      const held = uiRepeats.get(repeatKey);
      const noChange =
        !resultSuccess ||
        changed === false ||
        (Array.isArray(changed) && changed.length === 0) ||
        (state !== null && held?.lastState === state);
      uiRepeats.set(repeatKey, { unchanged: noChange ? (held?.unchanged ?? 0) + 1 : 0, lastState: state });
    }

    // A picture in the result is the model's to look at with this call's
    // result, and nothing else's: it is not in the text above, the event or the record.
    if (isWrapped && result.image) answerImages.set(toolUseId, result.image);
    if (isWrapped && typeof result.modelText === 'string') answerTexts.set(toolUseId, result.modelText);
    return { text: JSON.stringify(modelPayload ?? { error: 'no result' }), ran: true };
  };

  /**
   * A call's result as the model is given it: its text, and the picture the
   * result came with, as an image part of the same tool result.
   */
  const toModelOutput = ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
    const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
    const image = answerImages.get(toolCallId);
    const fileText = answerTexts.get(toolCallId);
    if (!image && fileText === undefined) return { type: 'text' as const, value: text };
    return {
      type: 'content' as const,
      value: [
        { type: 'text' as const, text },
        ...(fileText !== undefined ? [{ type: 'text' as const, text: fileText }] : []),
        ...(image ? [{ type: 'file' as const, mediaType: image.mediaType, data: { type: 'data' as const, data: image.base64 } }] : []),
      ],
    };
  };

  /**
   * Stops the turn at a call that needs the user's approval (ADR-0228 §2.2.1):
   * stores it as a pending approval, shows the card, and tells the model only
   * that it is waiting. The model never sees a token.
   */
  const requestApproval = async (
    t: RegisteredTool,
    args: Record<string, unknown>,
    toolUseId: string,
    requirement: ApprovalRequirement,
    files: ReadonlyMap<string, AttachmentRef>,
  ): Promise<string> => {
    // A file is shown by its name and size; the approval stays bound to its id (ADR-0252 §2.13).
    const preview = buildApprovalPreview(t, args, files);
    approvalHold = { approvalId: toolUseId, title: preview.title };
    const refuse = (why: string) => {
      approvalHold = null;
      log('error', 'agent:tool', 'Approval could not be requested; the call was not run', { turnId, toolName: t.name, why });
      return JSON.stringify({
        success: false,
        notRun: true,
        error: `"${preview.title}" needs the user's approval, which could not be asked for (${why}). It was not run.`,
      });
    };
    if (!config.approvals) return refuse('this assistant has no approval store');

    const expiresAt = Date.now() + requirement.ttlMs;
    try {
      const hash = await argsHash(args);
      await config.approvals.create({
        approvalId: toolUseId,
        toolCallId: toolUseId,
        conversationId: input.conversationId,
        turnId,
        userId: input.userId,
        tool: t.name,
        args,
        argsHash: hash,
        effect: requirement.effectName,
        destructive: requirement.destructive,
        argsSensitive: t.argsSensitive !== false,
        expiresAt,
        preview,
      });
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }

    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, {
      turnId,
      conversationId: input.conversationId,
      approvalId: toolUseId,
      tool: t.name,
      effect: requirement.effectName,
      destructive: requirement.destructive,
      preview,
      expiresAt,
      timestamp: Date.now(),
    } satisfies ApprovalRequiredEvent);
    log('info', 'agent:tool', 'Turn stopped for the user’s approval', {
      turnId,
      toolName: t.name,
      approvalId: toolUseId,
      effect: requirement.effectName,
      destructive: requirement.destructive,
    });
    return JSON.stringify({
      success: false,
      awaitingApproval: true,
      approvalId: toolUseId,
      message:
        `Waiting for the user to approve "${preview.title}" on the approval card. It has not run. ` +
        'The turn ends here: it runs only if they approve it there, and the next turn tells you the outcome.',
    });
  };

  // Convert a RegisteredTool to an AI SDK tool. Our tools have runtime-defined
  // JSON Schemas — dynamicTool accepts raw JSON Schema via jsonSchema(), which
  // is exactly our use case.
  function toAiTool(t: RegisteredTool): AiTool {
    const rawSchema = t.inputSchema && Object.keys(t.inputSchema.properties ?? {}).length > 0
      ? t.inputSchema
      : { type: 'object' as const, properties: {}, additionalProperties: false };
    const isUI = t.kind === 'ui';

    // A UI call takes its place in the turn's UI order synchronously, as the
    // model's call arrives: the checks and the emit below await, and calls from
    // one response may get through them in any order (ui-sequence.ts). The place
    // is given up if the call never reaches the page, and otherwise held until
    // its action settles.
    const execute = (rawArgs: unknown, options: { toolCallId?: string } | undefined): Promise<string> => {
      const toolUseId = options?.toolCallId ?? `tool_${Date.now()}`;
      const uiSlot = isUI ? uiSequence.reserve() : undefined;
      return tracked(toolUseId, t.name, rawArgs, async () => {
        const { text } = await executeCall(t, rawArgs, toolUseId, uiSlot).finally(() => uiSlot?.release());
        executedToolResults.push({ toolCallId: toolUseId, toolName: t.name, result: text });
        return text;
      });
    };

    // A call that needs approval says so in its description, in place of any
    // "confirm first" instruction: the card is the confirmation.
    const description = approvalRequirement(t).required ? `${t.description}\n\n${APPROVAL_TOOL_NOTE}` : t.description;
    return dynamicTool({
      description,
      inputSchema: jsonSchema(rawSchema),
      execute,
      toModelOutput,
    });
  }

  // The turn's UI tools for the page as it is now (ADR-0245 §2.2). One tool
  // per action is built, and none of them is given to the model: `ui_act` runs
  // them, so validation, quota, policy and approval see the action itself.
  // Rebuilt only when what the page offers changes.
  type CurrentUI = {
    fingerprint: string;
    actions: Map<string, RegisteredTool>;
    describe: RegisteredTool;
    read: RegisteredTool;
  };
  let builtUI: CurrentUI | null = null;
  function currentUI(): CurrentUI | null {
    if (!config.ui || currentPage.length === 0) return null;
    const fingerprint = pageFingerprint(currentPage);
    if (builtUI?.fingerprint === fingerprint) return builtUI;
    const built = buildUITools(currentPage, {
      channel: config.ui.channel,
      resultTimeoutMs: uiResultTimeoutMs,
      maxObservationChars: config.ui.maxObservationChars,
      waitDeadline: uiWaitDeadline,
      jobWaitMs: uiJobWaitMs,
      currentPage: () => currentPage,
      sequence: uiSequence,
      held: heldDefinitions,
      sight,
      log: (level, message, data) => log(level, 'agent:ui', message, { turnId, ...data }),
      onResult: (_answer, page) => {
        // The page the answer stands for is the page from now on: the next
        // call is looked up in it, and the model was told what changed.
        if (page && pageFingerprint(page) !== pageFingerprint(currentPage)) {
          log('info', 'agent:ui', 'The page changed; the turn continues with what it now offers', {
            turnId,
            from: currentPage.map((s) => s.id),
            to: page.map((s) => s.id),
          });
          currentPage = [...page];
        }
      },
    });
    for (const c of built.collisions) {
      log('error', 'agent:ui', 'Two mounted surfaces declare the same action id; the first keeps it', {
        turnId,
        ...c,
      });
    }
    builtUI = {
      fingerprint,
      actions: new Map(built.tools.map((t) => [t.name, t])),
      describe: built.describe,
      read: built.read,
    };
    return builtUI;
  }

  // The host's tools the model is given. A host tool with a UI tool's name, or
  // with the id of an action of the page, is withheld (ADR-0209 D6): for a
  // UI-only agent, the page is the authority.
  function hostTools(ui: CurrentUI | null): RegisteredTool[] {
    const sdkOwned = new Set(fileTools.map((t) => t.name));
    if (!ui) return [...config.tools.tools.filter((t) => !sdkOwned.has(t.name)), ...fileTools];
    const taken = (name: string) =>
      sdkOwned.has(name) || ui.actions.has(name) || name === UI_ACT_TOOL || name === UI_DESCRIBE_TOOL || name === UI_READ_TOOL;
    const withheld = config.tools.tools.filter((t) => taken(t.name)).map((t) => t.name);
    if (withheld.length > 0) {
      log('error', 'agent:ui', 'Host tools collide with UI tools or action ids; the host tools are withheld this turn', {
        turnId,
        withheld,
      });
    }
    return [...config.tools.tools.filter((t) => !taken(t.name)), ...fileTools];
  }

  /** Every tool a call can name: the host's, and the page's actions. What an approved call is looked up in. */
  function callableTools(): RegisteredTool[] {
    const ui = currentUI();
    return [...hostTools(ui), ...(ui ? [...ui.actions.values()] : [])];
  }

  // What the turn policy constrained this step to, in terms of the page's
  // actions (set in prepareStep): `ui_act` enforces it, since the model's own
  // tool list only knows `ui_act`.
  let stepActions: { only: ReadonlySet<string> | null; forced: string | null } = { only: null, forced: null };

  /**
   * `ui_act`: runs one action of the page. The action's own tool goes through
   * `executeCall`, so the call is validated against the action's definition,
   * counted, judged by policy and approved as the action it is.
   */
  function actAiTool(): AiTool {
    return dynamicTool({
      description:
        'Runs one action of the user’s page, as the user would. `action` is an action id from the page’s index; `input` is what it takes. ' +
        'The index line says what an action takes in outline: when that is not enough to write its input, call ' +
        `${UI_DESCRIBE_TOOL} first. The answer says what happened, what the page now offers where that changed, and what it shows.`,
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The action’s id, exactly as the page’s index gives it.' },
          input: { type: 'object', description: 'The action’s input. Leave out for an action that takes nothing.' },
        },
        required: ['action'],
        additionalProperties: false,
      }),
      execute: (rawArgs: unknown, options: { toolCallId?: string } | undefined): Promise<string> => {
        const toolUseId = options?.toolCallId ?? `tool_${Date.now()}`;
        return tracked(toolUseId, UI_ACT_TOOL, rawArgs, () => act(rawArgs, toolUseId));
      },
      toModelOutput,
    });

    async function act(rawArgs: unknown, toolUseId: string): Promise<string> {
        const { action, input: actionInput } = (rawArgs ?? {}) as { action?: unknown; input?: unknown };
        // Taken as the call arrives, like any UI call (ui-sequence.ts), and
        // given up if it never reaches the page.
        const uiSlot = uiSequence.reserve();
        const notAnAction = (error: string): string => {
          uiSlot.release();
          ledger.record({ tool: typeof action === 'string' && action ? action : UI_ACT_TOOL, ok: false, error });
          const text = JSON.stringify({ success: false, notRun: true, error });
          executedToolResults.push({ toolCallId: toolUseId, toolName: UI_ACT_TOOL, result: text });
          return text;
        };
        if (typeof action !== 'string' || !action) return notAnAction(`${UI_ACT_TOOL} needs "action": an action id from the page's index.`);
        if (stepActions.forced && action !== stepActions.forced) {
          return notAnAction(`This step runs "${stepActions.forced}" and nothing else: call ${UI_ACT_TOOL} with that action.`);
        }
        if (stepActions.only && !stepActions.only.has(action)) {
          return notAnAction(`"${action}" is not available at this step.`);
        }
        // Looked up in the page as it is now: an earlier action of this response may have changed it.
        const ui = currentUI();
        const tool = ui?.actions.get(action);
        if (!tool) {
          const ids = ui ? [...ui.actions.keys()] : [];
          const near = ids.filter((id) => id.includes(action) || action.includes(id)).slice(0, 8);
          return notAnAction(
            `"${action}" is not an action of the page as it is now.` +
              (near.length ? ` Did you mean: ${near.join(', ')}?` : ' Read the page’s index for what it offers; an action is named by its id there.'),
          );
        }
        const { text } = await executeCall(tool, actionInput ?? {}, toolUseId, uiSlot).finally(() => uiSlot.release());
        executedToolResults.push({ toolCallId: toolUseId, toolName: UI_ACT_TOOL, result: text });
        return text;
    }
  }

  /** A tool the model is given, as a turn policy sees it: its name, kind and class. */
  function describeStepTool(name: string): StepTool {
    if (name === UI_ACT_TOOL || name === UI_DESCRIBE_TOOL || name === UI_READ_TOOL) return { name, kind: 'ui' };
    // The SDK's own file tools take their names before the host's (hostTools).
    const registered = fileTools.find((t) => t.name === name) ?? config.tools.tools.find((t) => t.name === name);
    if (!registered) return { name, kind: 'builtin' };
    return { name, kind: registered.kind === 'ui' ? 'ui' : 'backend', ...(registered.toolClass ? { toolClass: registered.toolClass } : {}) };
  }

  function assembleTools(): Record<string, AiTool> {
    const ui = currentUI();
    const tools: Record<string, AiTool> = {};
    for (const t of hostTools(ui)) tools[t.name] = toAiTool(t);
    if (ui) {
      tools[UI_ACT_TOOL] = actAiTool();
      tools[UI_DESCRIBE_TOOL] = toAiTool(ui.describe);
      tools[UI_READ_TOOL] = toAiTool(ui.read);
    }
    // What the prompt leaves out of the client's knowledge, read when it is needed.
    if (knowledge && !tools[KNOWLEDGE_TOOL]) tools[KNOWLEDGE_TOOL] = toAiTool(knowledgeTool(knowledge));
    return tools;
  }

  /**
   * The turn after the user's decision on an approval card (ADR-0228 §2.2.5):
   * redeem the token and run exactly the stored call, or learn that they
   * declined. What happened goes to the model as an `<approval>` note.
   *
   * A call that was run is ONE call to the model: its outcome becomes the
   * result of the call the model made, in place of "waiting for approval"
   * (`outcome`, which `convertHistoryToCoreMessages` puts there), and is
   * persisted as a result of that same call id, so later turns read it the
   * same way. Only when that call is no longer in the history the model is
   * given does the outcome follow the user's message as a call of its own.
   */
  async function continueApproval(continuation: ApprovalContinuation): Promise<{
    note: string;
    /** The approved call's outcome, as the result of the call already in the history. */
    outcome: TurnHistoryMessage | null;
    messages: ModelMessage[];
    persisted: TurnMessage[];
  }> {
    const outcome = await resolveContinuation(config.approvals, continuation, {
      userId: input.userId,
      conversationId: input.conversationId,
    });
    /** The tool name of the call the model made that waited on this approval, when the history still holds it. */
    const askedAs = (approvalId: string): string | null => {
      for (const m of input.history ?? []) {
        if (m.role !== 'assistant') continue;
        const call = m.tool_calls?.find((tc) => tc.id === approvalId);
        if (call) return call.function?.name ?? (call as unknown as { name?: string }).name ?? 'unknown';
      }
      return null;
    };
    /**
     * A call that will never run says so as its stored result, in place of
     * "waiting for approval", so a later turn reads how it ended.
     */
    const settledNotRun = (approvalId: string, note: string, content: string) => {
      const name = askedAs(approvalId);
      return name
        ? {
            note,
            outcome: { role: 'tool' as const, content, tool_call_id: approvalId, name },
            messages: [],
            persisted: [{ role: 'tool' as const, content, toolCallId: approvalId, name }],
          }
        : { note, outcome: null, messages: [], persisted: [] };
    };
    if (outcome.kind === 'note') {
      log('info', 'agent:tool', 'Approval continuation ran nothing', { turnId, approvalId: continuation.approvalId, decision: continuation.decision });
      if (!outcome.settled) return { note: outcome.note, outcome: null, messages: [], persisted: [] };
      return settledNotRun(continuation.approvalId, outcome.note, notRunResult(approvalMarker(outcome.settled, false)));
    }
    const { call } = outcome;
    const tool = callableTools().find((t) => t.name === call.tool);
    if (!tool) {
      log('warn', 'agent:tool', 'Approved call is not available this turn; it was not run', { turnId, approvalId: call.approvalId, toolName: call.tool });
      return settledNotRun(
        call.approvalId,
        unavailableNote(call.tool),
        notRunResult(approvalMarker('approved', false), 'It is not available where they are now.'),
      );
    }
    const uiSlot = tool.kind === 'ui' ? uiSequence.reserve() : undefined;
    const executed = await executeCall(tool, call.args, call.approvalId, uiSlot, {
      approvalId: call.approvalId,
      argsHash: call.argsHash,
    }).finally(() => uiSlot?.release());
    const { ran } = executed;
    // The result says it was approved by the person and run once (or not run), for this turn and every later one.
    const text = markedResult(executed.text, approvalMarker('approved', ran));
    const { title } = declaredTitle(tool);
    // The model sees the call as it would have made it: a UI action through `ui_act`.
    const called =
      tool.kind === 'ui'
        ? { name: UI_ACT_TOOL, input: { action: tool.name, input: call.args } }
        : { name: tool.name, input: call.args };
    const refusal = ran ? null : (JSON.parse(executed.text) as { error?: string }).error ?? 'it was refused';
    // The call the model made, which answered "waiting for approval": its id is the approval's.
    const asked = (input.history ?? []).some(
      (m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === call.approvalId),
    );
    if (asked) {
      return {
        note: ran ? ranNote(title, 'replaced') : refusedNote(title, refusal!),
        outcome: { role: 'tool', content: text, tool_call_id: call.approvalId, name: called.name },
        messages: [],
        persisted: [{ role: 'tool', content: text, toolCallId: call.approvalId, name: called.name }],
      };
    }
    const callId = `${call.approvalId}-approved`;
    return {
      note: ran ? ranNote(title, 'follows') : refusedNote(title, refusal!),
      outcome: null,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: called.name, input: called.input }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: called.name, output: { type: 'text', value: text } }] },
      ],
      persisted: [
        { role: 'assistant', content: null, toolCalls: [{ id: callId, name: called.name, arguments: called.input }] },
        { role: 'tool', content: text, toolCallId: callId, name: called.name },
      ],
    };
  }

  // Track cumulative text length emitted this turn.
  let totalTextEmitted = 0;

  // ─── Rounds are paragraphs ─────────────────────────────────────────────────
  // The turn streams as one reply, but the model writes it in rounds: text, a
  // tool call, then more text. Joined as they come, "Adding the file now." and
  // "I added it." read "now.I added" (dev, 2026-10-07). Where a round that said
  // something ended in tool calls, and more text follows, the stream carries a
  // paragraph break. Positions are in the turn's text (`streamedText`): the SDK
  // reports a step's end before the next step starts, but the text stream can
  // still be delivering that step's own text, so the break goes where the step's
  // text ends, not when its end is reported. The break is only streamed; what
  // the model said is recorded as it said it.
  const ROUND_BREAK = '\n\n';
  /** Where, in the turn's text, a round that said something and then called tools ended. */
  const roundBreaks: number[] = [];
  /** The turn's text the steps have reported so far. */
  let stepTextReported = 0;

  // ─── Coalesce token deltas ─────────────────────────────────────────────────
  // Buffer for 50ms or 32 chars, whichever comes first, to avoid one HTTP POST
  // per token delta to the realtime server.
  const COALESCE_MS = 50;
  const COALESCE_CHARS = 32;
  let tokenBuffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTokenBuffer = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (tokenBuffer.length > 0) {
      const text = tokenBuffer;
      tokenBuffer = '';
      totalTextEmitted += text.length;
      await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOKEN, {
        turnId,
        text,
        timestamp: Date.now(),
      });
    }
  };

  // Run the multi-round generation
  try {
  // ─── Prompt cache breakpoints ──────────────────────────────────────────────
  // Every round of every turn re-sent the same ~25k-token prefix at full price:
  // the system prompt plus ~87 tool schemas, unchanged from the first call to
  // the last. A five-round turn paid for it five times.
  //
  // Providers that cache by breakpoint (Bedrock, Anthropic) render the request
  // as tools -> system -> messages, and a breakpoint caches the whole prefix up
  // to itself. So a breakpoint at the end of the system block covers the tool
  // definitions too, even where the provider offers no way to mark tools.
  //
  // What marks a breakpoint is provider-specific, so it is the host's to say
  // (`promptCacheBreakpoint`, e.g. PROMPT_CACHE_BREAKPOINTS.bedrock). Without
  // one, nothing is marked: a provider that caches on its own still does.
  //
  // The system prompt has to travel as a message rather than the top-level
  // `system` field, because only a message carries `providerOptions`.
  //
  // Two breakpoints, both on content that is append-only:
  //   1. system (+ tools) — identical for every round of a segment, and for
  //      every turn on the same page.
  //   2. the end of the incoming history — stable across the rounds that follow
  //      it, since a round appends rather than rewrites.
  //
  // Caching is a PREFIX match: one byte earlier in the prefix invalidates
  // everything after it. Nothing volatile may move ahead of these points — no
  // timestamp or request id in the system prompt, and a stable tool order.
  // A new segment changes the tool set, so it writes a new prefix; that happens
  // only when the page changes. `cacheReadTokens` in the usage below is how you
  // tell caching is still working.
  const cachePoint = config.promptCacheBreakpoint;

  // A stop asked for while the turn waited to start (in a queue, or for the
  // turns before it to be stored) is heard first: nothing runs, and the turn
  // stores only that it was stopped.
  await stopWatch.checked();
  const stoppedBeforeStart = stopOf(abortController.signal);
  if (stoppedBeforeStart) return await finishStopped(stoppedBeforeStart, { expired: null, continued: null });

  // ─── The turn after an approval decision (ADR-0228 §2.2.5) ────────────────
  const continued = input.approval ? await continueApproval(input.approval) : null;

  // ─── Calls still stored as waiting, whose approval expired undecided ──────
  //
  // A card that expires with nobody clicking it sends nothing, so no turn ever
  // stored how the call ended: every later turn read "waiting for approval…
  // has not run" (dev, 2026-10-04). At the start of a turn the store is asked
  // about each call the history still shows as waiting. Only its explicit
  // answer settles one: `claimed` stores the expired result under the call's
  // own id; `already` (another turn holds the claim) tells the model for this
  // turn and stores nothing; `open` and `unknown` leave the call as it is. A
  // call whose "waiting" row is not in the history yet is simply not found.
  // Expiry is the store's clock's to decide, never this process's.
  /** Calls beyond the newest few are left: a store call per waiting call, on every turn, has to stay small. */
  const MAX_WAITING_SETTLED = 5;
  async function settleExpiredWaiting(): Promise<{
    outcomes: TurnHistoryMessage[];
    persisted: TurnMessage[];
    claimed: string[];
    /** How many expired with nobody deciding, how many the user had approved, and how many were withdrawn. */
    undecided: number;
    approved: number;
    withdrawn: number;
  }> {
    const settled = { outcomes: [] as TurnHistoryMessage[], persisted: [] as TurnMessage[], claimed: [] as string[], undecided: 0, approved: 0, withdrawn: 0 };
    const store = config.approvals;
    if (!store?.settleExpired) return settled;
    const owner = { userId: input.userId, conversationId: input.conversationId };
    const waiting = waitingCalls(input.history ?? [])
      // The call this very turn carries the decision for is the continuation's.
      .filter((w) => w.approvalId !== input.approval?.approvalId)
      .slice(0, MAX_WAITING_SETTLED);
    const answers = await Promise.all(
      waiting.map(async (w) => {
        try {
          return { w, answer: await store.settleExpired!(w.approvalId, owner) };
        } catch (err) {
          // A store that cannot be reached settles nothing: the call keeps reading "waiting".
          log('warn', 'agent:tool', 'Could not ask the approval store about a waiting call', { turnId, approvalId: w.approvalId, error: err instanceof Error ? err.message : String(err) });
          return { w, answer: null };
        }
      }),
    );
    for (const { w, answer } of answers) {
      if (answer?.outcome !== 'claimed' && answer?.outcome !== 'already') continue;
      // The user had approved it and it was never run, or nobody decided: the result says which.
      const wasApproved = answer.decided === 'approved';
      // Withdrawn (a new message, or its turn stopped) is said as that, not as time running out (ADR-0252 §2.6).
      const content = notRunResult(
        answer.withdrawn
          ? withdrawnMarker(answer.withdrawn, wasApproved)
          : wasApproved
            ? approvedExpiredMarker()
            : approvalMarker('expired', false),
      );
      if (answer.withdrawn) settled.withdrawn += 1;
      else if (wasApproved) settled.approved += 1;
      else settled.undecided += 1;
      const name = w.name ?? 'unknown';
      settled.outcomes.push({ role: 'tool', content, tool_call_id: w.approvalId, name });
      if (answer.outcome === 'claimed') {
        settled.persisted.push({ role: 'tool', content, toolCallId: w.approvalId, name });
        settled.claimed.push(w.approvalId);
      }
      log('info', 'agent:tool', 'A waiting call’s approval expired without the call running', {
        turnId,
        approvalId: w.approvalId,
        decided: wasApproved ? 'approved' : null,
        ...(answer.withdrawn ? { withdrawn: answer.withdrawn } : {}),
        stored: answer.outcome === 'claimed',
      });
    }
    return settled;
  }
  const expired = await settleExpiredWaiting();

  // Stopped while the approved call ran, or while the store was asked: the model is not called.
  const stoppedBeforeModel = stopOf(abortController.signal);
  if (stoppedBeforeModel) return await finishStopped(stoppedBeforeModel, { expired, continued });

  // Convert history to AI SDK CoreMessage format. The page the user is on
  // travels with their message, not in the system prompt: it changes on every
  // page, and in the system prompt it would invalidate the cached prefix. An
  // approved call that ran is the result of the call the model made (see
  // continueApproval).
  // The date and time on the user's clock travel with their message too: a
  // model has no clock, and the changing minute must stay out of the cached
  // system prompt (prompt/clock.ts).
  const turnFilesGiven = !!fileArea && (input.attachments?.length ?? 0) > 0;
  const messages: ModelMessage[] = [
    ...withClock(
      withPageState(
        withNote(
          convertHistoryToCoreMessages(
            // An approved call's outcome, and an expired one's, is a later result of the call already in the
            // history: it takes that call's place.
            [...(input.history ?? []), ...expired.outcomes, ...(continued?.outcome ? [continued.outcome] : [])],
            [input.content, continued?.note].filter(Boolean).join('\n\n'),
            // The turn's own message, when the history already holds it: its files are given below,
            // each with its line, so the history's copy of the message does not name them again.
            turnFilesGiven && input.history?.at(-1)?.role === 'user' ? input.history.length - 1 : null,
          ),
          // Said on the user's message whether or not the host's history already holds that message.
          expired.outcomes.length > 0 ? expiredNote(expired) : null,
        ),
        client,
        config.ui?.maxObservationChars ?? DEFAULT_PAGE_STATE_CHARS,
        config.ui?.maxIndexChars ?? DEFAULT_INDEX_CHARS,
      ),
      input.context ?? null,
    ),
    ...(continued?.messages ?? []),
  ];
  // The turn's files go with its message, after everything said about it (ADR-0252 §2.11).
  // A file that cannot be had is named with why; the turn goes on with the others.
  if (fileArea && turnFilesGiven) {
    try {
      const files = await turnAttachmentParts(input.attachments!, {
        store: fileArea.store,
        owner: fileOwner,
        guard: fileGuard,
        pdfAsDocument: fileArea.pdfAsDocument ?? false,
        perMessage: fileArea.perMessage,
        signal: abortController.signal,
      });
      if (files.failures.length > 0) {
        log('warn', 'agent:tool', 'Some of the message’s files could not be loaded; the turn goes on without them', { turnId, failures: files.failures });
      }
      messages.splice(0, messages.length, ...withTurnAttachments(messages, files));
    } catch (err) {
      log('error', 'agent:tool', 'The message’s files could not be given; the turn goes on with their lines', {
        turnId,
        error: err instanceof Error ? err.message : String(err),
      });
      messages.splice(
        0,
        messages.length,
        ...withTurnAttachments(messages, {
          parts: [],
          notes: [withReferenceLines('', input.attachments!), 'These files could not be loaded with this message.'],
          failures: [],
        }),
      );
    }
  }

  // The system prompt goes in `instructions`, NOT in `messages`.
  //
  // ai v7 rejects a system-role entry in `messages` outright —
  // AI_InvalidPromptError, "System messages are not allowed in the prompt or
  // messages fields" — because `allowSystemInMessages` defaults to false. An
  // earlier attempt at these breakpoints put it there and broke every turn.
  //
  // `instructions` takes `string | SystemModelMessage | SystemModelMessage[]`,
  // and the message form carries `providerOptions`, so the breakpoint travels
  // with it. (`system` is the deprecated alias for the same type.)
  const instructions = {
    role: 'system' as const,
    content: systemPrompt,
    ...(cachePoint ? { providerOptions: cachePoint } : {}),
  };

  const withCachePoint = (msgs: ModelMessage[]): ModelMessage[] => !cachePoint ? msgs : [
    ...msgs.slice(0, -1),
    ...msgs.slice(-1).map((m) => ({
      ...m,
      providerOptions: { ...(m.providerOptions ?? {}), ...cachePoint },
    }) as ModelMessage),
  ];

  type SegmentStep = Awaited<ReturnType<typeof streamText>['steps']>[number];
  const allSteps: SegmentStep[] = [];
  let conversation: ModelMessage[] = messages;
  let segments = 0;
  let responseMessageCount = 0;
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (;;) {
    segments++;
    const aiTools = assembleTools();
    const previousSteps = [...allSteps];

    log('info', 'agent:llm', 'Messages prepared', {
      turnId,
      segment: segments,
      messageCount: conversation.length,
      toolCount: Object.keys(aiTools).length,
    });

    const result = streamText({
      model: config.model,
      instructions,
      messages: withCachePoint(conversation),
      tools: aiTools,
      maxOutputTokens: maxTokens,
      maxRetries: retries,
      abortSignal: abortController.signal,
      stopWhen: [
        isStepCount(maxRounds - allSteps.length),
        ...USER_INPUT_TOOLS.map((name) => hasToolCall(name)),
        // A call is waiting for the user's approval: the turn ends here (ADR-0228).
        () => approvalHold !== null,
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      telemetry: {
        isEnabled: true,
        functionId: `agent-turn:${turnId}`,
      },
      prepareStep: async ({ steps, messages }) => {
        // The policy speaks of the page's actions by their ids, as it always
        // has: a `ui_act` call is shown to it as the action it ran, and the
        // actions are among the tool names it may choose from.
        const actionIds = [...(currentUI()?.actions.keys() ?? [])];
        const { note, ...policy } = await turnPolicy.prepareStep({
          // The policy counts steps across the whole turn, not per segment.
          steps: [...previousSteps, ...steps].map((step) => ({
            toolCalls: (step.toolCalls as Array<{ toolName: string; input?: unknown }> | undefined)?.map((tc) => ({
              toolName:
                tc.toolName === UI_ACT_TOOL && typeof (tc.input as { action?: unknown } | undefined)?.action === 'string'
                  ? (tc.input as { action: string }).action
                  : tc.toolName,
            })),
          })),
          turnClass,
          allToolNames: [...Object.keys(aiTools), ...actionIds],
          // What each tool is, so a policy can choose by class (the attachment tools are `attachment`).
          allTools: [
            ...Object.keys(aiTools).map((name) => describeStepTool(name)),
            ...actionIds.map((name) => ({ name, kind: 'ui' as const })),
          ],
        });
        // What it constrained, in the model's terms: an action is run through
        // `ui_act`, which holds the step to the actions the policy allowed.
        const isAction = (name: string) => actionIds.includes(name);
        const forced = typeof policy.toolChoice === 'object' && isAction(policy.toolChoice.toolName) ? policy.toolChoice.toolName : null;
        const allowed = policy.activeTools?.filter(isAction);
        stepActions = {
          forced,
          only: allowed && allowed.length < actionIds.length ? new Set(allowed) : null,
        };
        const constraints = {
          ...(policy.toolChoice ? { toolChoice: forced ? ({ type: 'tool', toolName: UI_ACT_TOOL } as const) : policy.toolChoice } : {}),
          ...(policy.activeTools
            ? {
                activeTools: [
                  ...policy.activeTools.filter((n) => !isAction(n)),
                  ...(allowed && allowed.length > 0 && !policy.activeTools.includes(UI_ACT_TOOL) ? [UI_ACT_TOOL] : []),
                ],
              }
            : {}),
        };
        // The policy's note goes after the system prompt, for this step only.
        // ai carries an instructions override forward to later steps, so a step
        // without a note sets the plain instructions back.
        // So does the turn's record, once a call has not succeeded.
        const notes = [note, forced ? `This step: call ${UI_ACT_TOOL} with action "${forced}".` : null, ledger.note()].filter(
          (n): n is string => !!n,
        );
        // The page's state on the newest answer only: an earlier page is not the page now.
        const trimmed = messages ? withNewestPageStateOnly(messages) : null;
        if (trimmed) pageStatesNotRepeated += trimmed.replaced;
        // The files this step would carry, within the turn's and the conversation's caps (ADR-0252 §2.11).
        const leftOutNow = fileGuard.beforeStep();
        if (leftOutNow.length > 0) {
          log('info', 'agent:tool', 'Files left out of the next step to keep within the cap', {
            turnId,
            attachments: leftOutNow.map((p) => ({ id: p.attachmentId, kind: p.kind, estimatedTokens: p.tokens })),
          });
        }
        const leftOut = fileGuard.leftOutParts();
        const stepMessages = leftOut.length > 0 && messages ? withoutLeftOut(trimmed?.messages ?? messages, leftOut) : trimmed?.messages;
        return {
          ...constraints,
          ...(stepMessages ? { messages: stepMessages } : {}),
          instructions: notes.length
            ? [instructions, ...notes.map((content) => ({ role: 'system' as const, content }))]
            : instructions,
        };
      },
      onStepEnd: async ({ text, toolCalls, usage: stepUsage }) => {
        stepTextReported += text?.length ?? 0;
        if (text && (toolCalls?.length ?? 0) > 0) roundBreaks.push(stepTextReported);
        recordedSteps.push({
          text: text ?? '',
          toolCalls: (toolCalls ?? []).map((tc) => ({ toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })),
          inputTokens: stepUsage?.inputTokens ?? 0,
          outputTokens: stepUsage?.outputTokens ?? 0,
          cacheReadTokens: stepUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: stepUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        });
        log('info', 'agent:llm', 'Step completed', {
          turnId,
          turnClass,
          segment: segments,
          textLength: text?.length ?? 0,
          toolCallCount: toolCalls?.length ?? 0,
          totalTextEmitted,
        });
      },
    });

    // A stop aborts the stream. However that surfaces, as a throw here or as the
    // stream simply ending, the turn then goes to its stop path, which reads
    // none of the stream's own results: they reject on an abort.
    try {
      for await (const textPart of result.textStream) {
        let rest = textPart;
        while (rest) {
          // Text after a round that ended in tool calls starts a new paragraph.
          if (roundBreaks.length > 0 && streamedText.length >= roundBreaks[0]) {
            roundBreaks.shift();
            if (streamedText.length > 0) tokenBuffer += ROUND_BREAK;
            continue;
          }
          // A piece never runs past the next break, should one reach across it.
          const upTo = roundBreaks.length > 0 ? roundBreaks[0] - streamedText.length : rest.length;
          const piece = rest.slice(0, upTo);
          rest = rest.slice(piece.length);
          streamedText += piece;
          tokenBuffer += piece;
        }
        if (tokenBuffer.length >= COALESCE_CHARS) {
          await flushTokenBuffer();
        } else if (!flushTimer) {
          flushTimer = setTimeout(() => flushTokenBuffer(), COALESCE_MS);
        }
      }
      await flushTokenBuffer();
      if (stopOf(abortController.signal)) break;

      // After the text stream completes, all promised properties resolve.
      const steps = await result.steps;
      const segmentUsage = await result.usage;
      const response = await result.response;

      allSteps.push(...steps);
      usageTotals.inputTokens += segmentUsage?.inputTokens ?? 0;
      usageTotals.outputTokens += segmentUsage?.outputTokens ?? 0;
      usageTotals.cacheReadTokens += segmentUsage?.inputTokenDetails?.cacheReadTokens ?? 0;
      usageTotals.cacheWriteTokens += segmentUsage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      responseMessageCount += response.messages.length;
      conversation = [...conversation, ...response.messages];
    } catch (err) {
      if (!stopOf(abortController.signal)) throw err;
    }

    // The model's tools no longer change with the page (ADR-0245 §2.2): what
    // the page offers reaches it in each answer, so the turn runs as one segment.
    break;
  }

  // ─── Stopped, or ending ────────────────────────────────────────────────────
  // Decided here with nothing awaited in between: either the stop was heard
  // before this point and the turn takes its stop path, or the turn has begun
  // its own end and a stop that lands from now on is not one. Its watch is
  // closed, so it cannot abort the store or cause a second announcement.
  const stop = stopOf(abortController.signal);
  if (stop) return await finishStopped(stop, { expired, continued });
  ending = true;
  stopWatch.close();

  // ─── Finalize ──────────────────────────────────────────────────────────────
  const steps = allSteps;

  // Determine stop reason
  let stopReason: AgentTurnResult['stopReason'] = 'complete';
  if (approvalHold) {
    stopReason = 'awaiting_approval';
  } else if (steps.length >= maxRounds) {
    stopReason = 'step_count';
  } else if (steps.some((s: { toolCalls?: Array<{ toolName: string }> }) => s.toolCalls?.some(tc => (USER_INPUT_TOOLS as readonly string[]).includes(tc.toolName)))) {
    stopReason = 'present_options';
  }
  // deadline and token_budget are caught by the try/catch — they produce errors, not normal returns

  // ─── Usage ─────────────────────────────────────────────────────────────────
  // `promptTokens` is the SUM over rounds, and it was the only number reported.
  // Read as a context measurement it is wrong by a factor of the round count: a
  // five-round turn showed 128,808 tokens when no single call exceeded ~26,000,
  // so the context ceiling fired on turns that were nowhere near the window and
  // said nothing about the ones that were.
  //
  // Both numbers matter, and they answer different questions:
  //   peakPromptTokens — the largest single call. What the context window sees,
  //                      and what the ceiling must be compared against.
  //   promptTokens     — the sum. What the turn costs.
  //
  // cacheReadTokens/cacheWriteTokens are the caching gauge: a read of roughly
  // the prefix size on every round after the first means the breakpoints above
  // are holding. Reads at zero across a multi-round turn mean something
  // volatile has moved into the prefix and the cache is being missed silently.
  const stepInputTokens = steps.map((s) => s.usage?.inputTokens ?? 0);
  const usage = {
    promptTokens: usageTotals.inputTokens,
    completionTokens: usageTotals.outputTokens,
    totalTokens: usageTotals.inputTokens + usageTotals.outputTokens,
    peakPromptTokens: stepInputTokens.length > 0 ? Math.max(...stepInputTokens) : 0,
    cacheReadTokens: usageTotals.cacheReadTokens,
    cacheWriteTokens: usageTotals.cacheWriteTokens,
  };

  log('info', 'agent:llm', 'Turn usage', {
    turnId,
    rounds: steps.length,
    segments,
    peakPromptTokens: usage.peakPromptTokens,
    promptTokens: usage.promptTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    // How the page was worked (ADR-0245 §2.6).
    ...(client
      ? {
          ui: {
            ...uiCounts,
            blindRefusals: sight.refusals(),
            definitionsHeld: heldDefinitions.size,
            stopped: sight.stopped(),
            // What bounds the model: the page's index as it reads it, against the most it is given
            // before the furthest surfaces are listed by id only.
            indexChars: indexText(client.page, Infinity).length,
            pageStatesNotRepeated,
            maxIndexChars: config.ui?.maxIndexChars ?? DEFAULT_INDEX_CHARS,
          },
        }
      : {}),
    ...(fileArea ? { attachments: fileGuard.usage() } : {}),
  });

  // The turn's messages, in the host's format, for it to store.
  const newMessages = [...expired.persisted, ...(continued?.persisted ?? []), ...convertResponseToTurnMessages({ steps }, executedToolResults)];

  // The host stores the turn before the client hears it is complete: a message sent the moment
  // it completes must be answered from a history that holds this turn.
  if (config.beforeTurnComplete) {
    try {
      await config.beforeTurnComplete({ rounds: steps.length, usage, newMessages });
    } catch (err) {
      log('error', 'agent:turn', 'beforeTurnComplete failed; the turn completes without it', {
        turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_COMPLETE, {
    turnId,
    rounds: steps.length,
    usage,
    timestamp: Date.now(),
  });

  log('info', 'agent:turn', 'Turn completed', {
    turnId,
    conversationId: input.conversationId,
    totalRounds: steps.length,
    segments,
    maxRoundsReached: steps.length >= maxRounds,
    usage,
    newMessageCount: responseMessageCount,
  });

  return {
    rounds: steps.length,
    usage,
    newMessages,
    ...(expired.claimed.length > 0 ? { settledApprovals: expired.claimed } : {}),
    maxRoundsReached: steps.length >= maxRounds,
    stopReason,
    ...(fileArea ? { attachments: fileGuard.usage() } : {}),
  };
  } finally {
    clearTimeout(deadlineTimer);
    if (flushTimer) clearTimeout(flushTimer);
    // The turn is over, however it ended: nothing is listening for a stop.
    ending = true;
    stopWatch.close();
  }

  /**
   * The end of a stopped turn (ADR-0252 §2.4): settle what was in flight, store
   * what the turn had produced, then say so. Persist first, announce after, as
   * a turn that ends by itself does.
   *
   * Everything here happens after the turn's signal was aborted, so nothing
   * here is given that signal. The wait for calls in flight is bounded by the
   * grace; the store and the announcement are bounded by what the process has
   * left, when the host says (`remainingMs`). Without that, they take as long
   * as the host's store and the emit adapter's own timeout take.
   */
  async function finishStopped(
    stopped: TurnStopped,
    earlier: {
      expired: { persisted: TurnMessage[]; claimed: string[] } | null;
      continued: { persisted: TurnMessage[] } | null;
    },
  ): Promise<AgentTurnResult> {
    ending = true;
    stopWatch.close();
    // Text the turn produced and had not sent yet is still the person's to see.
    await flushTokenBuffer().catch(() => undefined);

    // A call that was out when the stop came takes one last look for its answer
    // (the UI tools do, on the stop's own signal). They are waited for, a little
    // past that grace, and no longer.
    const pending = [...recordedCalls.values()].filter((call) => call.text === null);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending.map((call) => call.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, stopGraceMs + 500);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }

    // A stopped turn leaves no live card: an approval it asked for as the stop came
    // is withdrawn now, and a later turn records it as that (§2.6).
    const held = approvalHold as { approvalId: string; title: string } | null;
    if (held && config.approvals?.withdraw) {
      try {
        await config.approvals.withdraw(held.approvalId, { userId: input.userId, conversationId: input.conversationId }, 'stopped');
      } catch (err) {
        log('warn', 'agent:tool', 'Could not withdraw the stopped turn’s approval; it lasts until its time limit', {
          turnId,
          approvalId: held.approvalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const marker: TurnStoppedMarker = { reason: stopped.reason, at: stopped.at };
    const newMessages: TurnMessage[] = [
      ...(earlier.expired?.persisted ?? []),
      ...(earlier.continued?.persisted ?? []),
      ...stoppedTurnMessages({ steps: recordedSteps, calls: [...recordedCalls.values()], streamedText, marker }),
    ];
    const unsettled = [...recordedCalls.values()].filter((call) => call.text === null).map((call) => call.toolName);

    // The steps that ended reported their tokens; the step the stop cut short did not.
    const stepInputTokens = recordedSteps.map((step) => step.inputTokens);
    const promptTokens = stepInputTokens.reduce((sum, n) => sum + n, 0);
    const completionTokens = recordedSteps.reduce((sum, step) => sum + step.outputTokens, 0);
    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      peakPromptTokens: stepInputTokens.length > 0 ? Math.max(...stepInputTokens) : 0,
      cacheReadTokens: recordedSteps.reduce((sum, step) => sum + step.cacheReadTokens, 0),
      cacheWriteTokens: recordedSteps.reduce((sum, step) => sum + step.cacheWriteTokens, 0),
    };
    const rounds = recordedSteps.length;
    log('info', 'agent:llm', 'Turn usage', {
      turnId,
      rounds,
      stopped: true,
      stopReason: stopped.reason,
      peakPromptTokens: usage.peakPromptTokens,
      promptTokens: usage.promptTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(unsettled.length > 0 ? { unsettledCalls: unsettled } : {}),
      ...(client ? { ui: { ...uiCounts, blindRefusals: sight.refusals(), stopped: sight.stopped() } } : {}),
      ...(fileArea ? { attachments: fileGuard.usage() } : {}),
    });

    // The store and the announcement each get a limit of their own when the host says how long
    // the process has left: a slow store must not run it to its hard end with nothing announced.
    /** Whether the work finished within its limit. */
    const within = async (what: string, keepBackMs: number, work: () => Promise<unknown>): Promise<boolean> => {
      const remaining = input.remainingMs?.();
      if (remaining === undefined) {
        await work();
        return true;
      }
      const limitMs = Math.max(STOP_STEP_FLOOR_MS, remaining - keepBackMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol('timed out');
      const outcome = await Promise.race([
        work(),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), limitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === timedOut) {
        log('error', 'agent:turn', `The stopped turn's ${what} did not finish within its limit; the turn goes on without waiting for it`, {
          turnId,
          limitMs,
          remainingMs: remaining,
        });
        return false;
      }
      return true;
    };

    // Whether what the turn had produced was stored: a deadline stop that could not store it is
    // not a stopped turn but one that ran out of time with nothing kept (ADR-0252 §6.4).
    let stored = true;
    if (config.beforeTurnComplete) {
      try {
        // Kept back: time to announce after it.
        stored = await within('store', STOP_ANNOUNCE_MARGIN_MS, () => config.beforeTurnComplete!({ rounds, usage, newMessages, stopped: marker }));
      } catch (err) {
        stored = false;
        log('error', 'agent:turn', 'beforeTurnComplete failed; the stopped turn is announced without it', {
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await within('announcement', STOP_STEP_FLOOR_MS, () =>
        config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_COMPLETE, {
          turnId,
          rounds,
          usage,
          stopReason: stopped.reason,
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      log('error', 'agent:turn', 'The stopped turn could not be announced', { turnId, error: err instanceof Error ? err.message : String(err) });
    }

    log('info', 'agent:turn', 'Turn stopped', {
      turnId,
      conversationId: input.conversationId,
      stopReason: stopped.reason,
      totalRounds: rounds,
      newMessageCount: newMessages.length,
    });

    return {
      rounds,
      usage,
      newMessages,
      ...(earlier.expired && earlier.expired.claimed.length > 0 ? { settledApprovals: earlier.expired.claimed } : {}),
      maxRoundsReached: false,
      stopReason: stopped.reason,
      stopped: marker,
      ...(stored ? {} : { stored: false as const }),
      ...(fileArea ? { attachments: fileGuard.usage() } : {}),
    };
  }
}

/** Put a note for the model on the turn's user message, after what the user said. */
function withNote(messages: ModelMessage[], note: string | null): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!note || !last || last.role !== 'user') return messages;
  return [...messages.slice(0, -1), withUserText(last, note)];
}

/**
 * Put the client's page on the user's message: what it offers, as an index of
 * its actions, and its latest observations. The model reads it as part of what
 * the user said, where it is true for this message only. The index has its own
 * budget, so it never crowds the page's state out (ADR-0245 §2.2).
 */
function withPageState(
  messages: ModelMessage[],
  client: ClientPage | null,
  maxChars: number,
  maxIndexChars: number,
): ModelMessage[] {
  if (!client || client.page.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;

  const observations = observationsText(client.observations, maxChars, { schemas: observationSchemas(client.page) });
  const notShown = client.fit?.observations?.length ? fitNotes(client.fit.observations) : [];
  const pageState = [
    '<page_state>',
    `The user's screen offers these surfaces and actions. Run an action with ${UI_ACT_TOOL}; ${UI_DESCRIBE_TOOL} says what one takes.`,
    indexText(client.page, maxIndexChars),
    `Current values: ${observations}`,
    ...(notShown.length ? [`Not shown: ${notShown.join(' ')}`] : []),
    '</page_state>',
  ].join('\n');

  return [...messages.slice(0, -1), withUserText(last, pageState)];
}

/**
 * Convert our TurnHistoryMessage[] to AI SDK CoreMessage[].
 * The AI SDK handles each provider's message format internally.
 *
 * DEFENSIVE: If an assistant message has tool_calls but a matching tool result
 * is missing from history, we synthesize a placeholder result. This prevents
 * AI_MissingToolResultsError crashes when persistence has gaps (e.g., stopWhen
 * triggered before a tool result was persisted).
 */
function convertHistoryToCoreMessages(
  history: TurnHistoryMessage[],
  currentContent: string,
  /** The history's copy of the turn's own message, whose files the turn gives with their lines. */
  turnMessageAt: number | null = null,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // First pass: collect all tool_call_ids that have results in history
  // AND all tool call IDs from assistant messages (to validate results)
  const answeredToolCallIds = new Set<string>();
  const knownToolCallIds = new Set<string>();
  // A call has one result. A call that waited for the user's approval has two
  // rows in the store — "waiting for approval", then what the approved run
  // returned (continueApproval) — and the model is given the later one, where
  // the first stands: straight after the call.
  const firstResultAt = new Map<string, number>();
  const lastResult = new Map<string, string>();
  history.forEach((msg, idx) => {
    if (msg.role !== 'tool' || !msg.tool_call_id) return;
    if (!firstResultAt.has(msg.tool_call_id)) firstResultAt.set(msg.tool_call_id, idx);
    lastResult.set(msg.tool_call_id, msg.content);
  });
  for (const msg of history) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      answeredToolCallIds.add(msg.tool_call_id);
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        knownToolCallIds.add(tc.id);
      }
    }
  }

  log('info', 'agent:llm', 'History conversion diagnostics', {
    sdkVersion: '2.4.5-diag',
    historyLength: history.length,
    answeredToolCallIds: Array.from(answeredToolCallIds),
    knownToolCallIds: Array.from(knownToolCallIds),
    toolMessages: history.filter(m => m.role === 'tool').map(m => ({
      tool_call_id: m.tool_call_id,
      name: m.name,
      inKnown: knownToolCallIds.has(m.tool_call_id ?? ''),
    })),
  });

  for (let idx = 0; idx < history.length; idx++) {
    const msg = history[idx];
    if (msg.role === 'user') {
      // A message's files are in history as their reference lines, never their content (ADR-0252 §2.11).
      messages.push({ role: 'user', content: idx === turnMessageAt ? msg.content : withReferenceLines(msg.content, msg.attachments ?? undefined) });
    } else if (msg.role === 'assistant') {
      // A stopped turn's last message says so after its text (ADR-0252 §2.3).
      // A message that has only that carries the line as its whole text: an
      // empty text block is refused by a model provider.
      const stoppedLine = msg.stopped ? turnStoppedNote(msg.stopped) : null;
      const said = msg.content && msg.content.trim() ? msg.content : null;
      const text = [said, stoppedLine && !said?.includes(stoppedLine) ? stoppedLine : null].filter(Boolean).join('\n\n');
      if (text || msg.tool_calls?.length) {
        const parts: Array<TextPart | ToolCallPart> = [];

        if (text) {
          parts.push({ type: 'text', text });
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            let toolName: string;
            let args: Record<string, unknown>;

            if (tc.function && typeof tc.function === 'object') {
              toolName = tc.function.name;
              try {
                args = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments as unknown as Record<string, unknown>;
              } catch { args = {}; }
            } else {
              const flat = tc as unknown as { id: string; name: string; arguments: unknown };
              toolName = flat.name;
              try {
                args = typeof flat.arguments === 'string'
                  ? JSON.parse(flat.arguments)
                  : (flat.arguments as Record<string, unknown>) ?? {};
              } catch { args = {}; }
            }

            parts.push({ type: 'tool-call' as const, toolCallId: tc.id, toolName, input: args });
          }
        }
        messages.push({ role: 'assistant' as const, content: parts });

        // DEFENSIVE: synthesize missing tool results for any tool_calls
        // that don't have a matching tool result in history.
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (!answeredToolCallIds.has(tc.id)) {
              const toolName = tc.function?.name ?? (tc as unknown as { name?: string }).name ?? 'unknown';
              log('info', 'agent:llm', 'SYNTHESIZING tool result (missing from history)', {
                toolCallId: tc.id,
                toolName,
                answeredIds: Array.from(answeredToolCallIds),
              });
              messages.push({
                role: 'tool' as const,
                content: [{
                  type: 'tool-result' as const,
                  toolCallId: tc.id,
                  toolName,
                  output: { type: 'text' as const, value: JSON.stringify({ acknowledged: true }) },
                }],
              });
              // Mark as answered so we don't double-synthesize
              answeredToolCallIds.add(tc.id);
            }
          }
        }
      }
    } else if (msg.role === 'tool') {
      // Skip tool results that are corrupted or orphaned:
      // 1. Empty tool_call_id (persistence bug: toolCallId was undefined)
      // 2. tool_call_id that doesn't match ANY known tool call in the conversation
      //    (persistence bug: fallback ID 'tool_${timestamp}' instead of real ID)
      // The defensive synthesis above creates proper results for the real tool calls.
      if (!msg.tool_call_id || !knownToolCallIds.has(msg.tool_call_id)) {
        log('info', 'agent:llm', 'SKIPPING orphaned tool result', {
          tool_call_id: msg.tool_call_id,
          name: msg.name,
          inKnown: msg.tool_call_id ? knownToolCallIds.has(msg.tool_call_id) : false,
        });
        continue;
      }

      log('info', 'agent:llm', 'KEEPING valid tool result', {
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });

      // A later result of the same call was put where the first stood.
      if (firstResultAt.get(msg.tool_call_id) !== idx) continue;

      // Tool result output must use discriminated format: { type: 'text', value: string }
      const outputValue = lastResult.get(msg.tool_call_id) || 'acknowledged';
      messages.push({
        role: 'tool' as const,
        content: [{
          type: 'tool-result' as const,
          toolCallId: msg.tool_call_id,
          toolName: msg.name ?? 'unknown',
          output: { type: 'text' as const, value: outputValue },
        }],
      });
    }
  }

  // Add current user message if not already at the end
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    messages.push({ role: 'user', content: currentContent });
  }

  // Final diagnostics: summary of converted messages
  log('info', 'agent:llm', 'Converted messages summary', {
    totalMessages: messages.length,
    byRole: messages.reduce((acc: Record<string, number>, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    toolResults: messages
      .filter((m): m is ToolModelMessage => m.role === 'tool')
      .map((m) => {
        const first = m.content[0];
        return {
          toolCallId: first && 'toolCallId' in first ? first.toolCallId : undefined,
          toolName: first && 'toolName' in first ? first.toolName : undefined,
        };
      }),
    assistantToolCalls: messages
      .filter((m): m is AssistantModelMessage => m.role === 'assistant')
      .map((m) => ({
        hasToolCalls: Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
        toolCallIds: Array.isArray(m.content)
          ? m.content.filter((p): p is ToolCallPart => p.type === 'tool-call').map((p) => p.toolCallId)
          : [],
      })),
  });

  return messages;
}

/**
 * Convert AI SDK response to our TurnMessage[] format for persistence.
 * Uses manually tracked executedToolResults since step.toolResults may be empty
 * for dynamicTool definitions.
 */
interface ConvertableStep {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; args?: Record<string, unknown>; input?: unknown }>;
}

function convertResponseToTurnMessages(
  result: { steps: ReadonlyArray<ConvertableStep> },
  executedToolResults: Array<{ toolCallId: string; toolName: string; result: string }>,
): TurnMessage[] {
  const turnMessages: TurnMessage[] = [];
  let resultIdx = 0;

  for (const step of result.steps) {
    // Assistant message with text and/or tool calls
    if (step.text || step.toolCalls.length > 0) {
      const msg: TurnMessage = {
        role: 'assistant',
        content: step.text || null,
      };
      if (step.toolCalls.length > 0) {
        msg.toolCalls = step.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          arguments: (tc.args ?? tc.input ?? {}) as Record<string, unknown>,
        }));
      }
      turnMessages.push(msg);

      // Add tool results for the tool calls in this step
      for (let i = 0; i < step.toolCalls.length && resultIdx < executedToolResults.length; i++) {
        const tracked = executedToolResults[resultIdx++];
        turnMessages.push({
          role: 'tool',
          content: tracked.result,
          toolCallId: tracked.toolCallId,
          name: tracked.toolName,
        });
      }
    }
  }

  return turnMessages;
}

