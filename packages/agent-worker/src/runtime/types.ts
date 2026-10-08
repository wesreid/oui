/**
 * The agent runtime's configuration: what the host supplies, for either host
 * adapter (Lambda + SQS, or a container). Every seam without a `?` is
 * required, and a missing one fails at start-up, naming it.
 *
 * Integrators provide these callbacks so the SDK can interact with their
 * platform without knowing anything about their database schema, API, or
 * realtime infrastructure.
 */
import type { RegisteredTool } from '../tools/types.js';
import type { AgentPersonaConfig } from '../prompt/index.js';
import type { AgentApiSurface } from '@ouispec/agent-core';
import type { TurnMessage, TurnHistoryMessage } from '../types.js';
import type { TurnPolicy } from '../turn-policy.js';
import type { ToolPolicy } from '../authz/tool-policy.js';
import type { UIActionChannel } from '../ui/channel.js';
import type { LanguageModel, ProviderOptions } from '../model.js';
import type { ApprovalStoreClient } from '../approvals/client.js';
import type { ApprovalChannel, ApprovalContinuation, AttachmentRef, TurnStoppedReason, TurnStoppedMarker } from '@ouispec/agent-core';
import type { AttachmentWorkerConfig } from '../attachments/store.js';
import type { AttachmentUsage } from '../attachments/guard.js';
import type { TurnStopClient } from '../stop/turn-stop.js';
import type { ApprovalPreviewHook, ValidateBeforeApproval } from '../approvals/hooks.js';
import type { AgentTurnInfo } from './turn-info.js';
import type { RealtimeEmitAdapter } from '../emit/types.js';

/**
 * Database handle — opaque to the SDK. The integrator's callbacks receive
 * whatever they return from `getDb` so they can use it directly.
 */
export type IntegratorDb = unknown;

/**
 * One turn, as the host's API hands it to the worker: the SQS message body
 * for the Lambda adapter, the request body for the container adapter.
 */
export interface AgentTurnPayload {
  turnId: string;
  conversationId: string;
  userId: string;
  accountId: string;
  socketRoom: string;
  content: string;
  context?: Record<string, unknown> | null;
  callbackUrl?: string;
  userToken?: string;
  /**
   * On the turn that follows the user's decision on an approval card: the
   * token to redeem, or that they declined.
   */
  approval?: ApprovalContinuation;
  /**
   * The turns of this conversation that this turn supersedes:
   * the host asked each to stop when this turn's message arrived. The host's
   * `getHistory` is given them, to wait until each is stored before it reads.
   */
  supersedes?: string[];
  /**
   * The files attached to the turn's message, by reference.
   * The host checked each is ready and is this conversation's before it
   * enqueued the turn; the worker reads them through `attachments.store`.
   */
  attachments?: AttachmentRef[];
  /**
   * Where the person is (ADR-0260 §3.3): `ui` (default) or a conversation
   * channel (`chat`, `sms`, `voice`, `phone`), where an approval is a readback
   * the next message confirms rather than a card.
   */
  channel?: ApprovalChannel;
}

/**
 * History with what goes beside it: `stepContext` is read by the model at the
 * end of every step (an index of work notes, say) and is not part of any
 * message. Put such memory there, not on the newest message: a message is sent
 * the same way every turn only if nothing is added to it for one turn, and a
 * changed message makes the prompt cache write the conversation from there on.
 */
export interface TurnHistory {
  messages: TurnHistoryMessage[];
  stepContext?: string | null;
}

/** What `getHistory` is told of the turn it reads for. */
export interface HistoryRequest {
  turnId: string;
  /** The turns this one supersedes, which must be stored (or given up on) before history is read. */
  supersedes: readonly string[];
  /**
   * Aborts when this turn is itself asked to stop while it waits: a wait for
   * earlier turns should end then, since the turn will store only that it was
   * stopped and reads no history.
   */
  signal: AbortSignal;
}

/**
 * Configuration for the agent runtime, whichever adapter hosts it.
 *
 * The integrator provides the model, the realtime server, the persona or
 * system prompt, tools, and a handful of callbacks. The SDK handles
 * everything else: orchestration, streaming, tool execution, UI actions,
 * error handling, and persistence.
 */
export interface AgentRuntimeConfig<TDb = IntegratorDb> {
  /**
   * The tools the agent can call. Each tool receives its input and a
   * ToolExecutionContext (userId, accountId, userToken, etc.).
   *
   * UI tools are not listed here. They come from the client's surface snapshot
   * on the turn (`context.oui`), and the SDK builds them itself.
   *
   * Tools can be a static array, or a per-turn resolver function.
   * The resolver receives the turn context and returns tools for that specific turn.
   * Use this when tools vary per-user (e.g. OUI surface tools).
   */
  tools:
    | RegisteredTool[]
    | ((ctx: { userId: string; accountId: string; turnId: string }) => Promise<RegisteredTool[]> | RegisteredTool[]);

  /**
   * The host's AgentApiSurface binding. Required when tools are loaded from
   * schema (loadToolsFromSchema) — generated tool execute bodies call
   * `apiSurface.executeIntent(intentId, params)`. Optional for hand-authored
   * tools that don't need host API access.
   *
   * Use `apiSurfaceFactory` instead if the surface needs per-turn context
   * (userId, accountId) — which is the common case.
   */
  apiSurface?: AgentApiSurface;

  /**
   * Factory that creates a per-turn AgentApiSurface with the turn's
   * userId/accountId. Preferred over the static `apiSurface` when the
   * surface needs per-turn context.
   */
  apiSurfaceFactory?: (payload: { userId: string; accountId: string; userToken?: string }) => AgentApiSurface;

  /**
   * The assistant's identity and voice, through the SDK's prompt framework.
   * The shipped prompts carry no identity of their own: it comes only from
   * here. Exactly one of `persona` and `systemPrompt` is required.
   */
  persona?: AgentPersonaConfig;

  /**
   * A system prompt builder, for full control instead of `persona`. Receives
   * the same context the persona would. Exactly one of the two is required.
   */
  systemPrompt?: (context: { userId: string; accountId: string; context?: Record<string, unknown> | null }) => string;

  // ─── Model ───────────────────────────────────────────────────────────

  /** The model, from any `ai` library provider. Required. */
  model: LanguageModel;

  /**
   * Provider options that mark a prompt-cache breakpoint (see
   * PROMPT_CACHE_BREAKPOINTS). Omit for a provider that caches on its own.
   */
  promptCacheBreakpoint?: ProviderOptions;
  /**
   * Provider options sent with every model call of every turn, e.g. the
   * thinking the model returns (`{ amazonBedrock: { additionalModelRequestFields:
   * { thinking: { type: 'adaptive', display: 'summarized' } } } }`). Keep them
   * the same for every turn: a thinking setting that changes between calls
   * invalidates the prompt cache. A summary the model returns streams to the
   * turn's room (`agent:reasoning_delta`); it is never stored with the
   * conversation.
   */
  modelProviderOptions?: ProviderOptions;

  /** Max tool-use rounds per turn. Default: 12 */
  maxRounds?: number;

  /**
   * The most one model response may write, thinking included. Default: 32,000.
   * A model that thinks spends its thinking from this before it says or calls
   * anything, so a low cap can end a step with nothing.
   */
  maxTokens?: number;

  /** Temperature. Default: 0.3. `null` sends none, for a model that does not take one. */
  temperature?: number | null;

  /**
   * Whether the model takes a forced tool choice. Default true. `false` for a
   * model that refuses one (Claude Sonnet 5.5): a step the turn policy forces
   * to a tool is given only that tool and told to call it.
   */
  forcedToolChoice?: boolean;

  /** Per-tool execution timeout in ms. Default: 30000 */
  toolTimeoutMs?: number;

  /** Total turn deadline in ms. Default: 840000 (14 min). Keep it below the host's own limit. */
  turnDeadlineMs?: number;

  /**
   * Time kept back before the deadline for a last step that says what is done
   * and offers to continue. Default 30 s, never more than a
   * quarter of `turnDeadlineMs`.
   */
  handBackReserveMs?: number;

  /** Retries of a transient model error. Default: 3 */
  retries?: number;

  /**
   * Optional turn policy for product-specific step control.
   * Controls turn classification and per-step tool selection constraints.
   * If not provided, the default policy applies no constraints.
   */
  turnPolicy?: TurnPolicy;

  /**
   * Per-tool authorization policy. Evaluated before every tool execution.
   * If omitted, the default policy allows all tools.
   * Policy errors are fail-closed (treated as deny).
   */
  toolPolicy?: ToolPolicy;

  // ─── Realtime ─────────────────────────────────────────────────────────

  /**
   * The realtime server (agent-sdk-realtime) and its internal key, one per
   * environment, from the host's secret store. Required. Turn events go to
   * `POST {url}/api/emit`.
   */
  realtime: {
    url: string;
    apiKey: string;
    /**
     * How turn events reach the client. Defaults to the realtime server's
     * `POST {url}/api/emit`. An eval harness, or a host that emits through
     * its own channel, supplies its own.
     */
    emit?: RealtimeEmitAdapter;
  };

  /**
   * How UI actions reach the client and how its answers come back. Defaults
   * to the realtime server: requests are emitted to the turn's room and
   * answers collected from `GET /internal/oui/action-results/{requestId}`.
   */
  uiActions?: {
    channel?: UIActionChannel;
    /** How long a UI tool waits for the client's answer. Default 20 s. */
    resultTimeoutMs?: number;
    /**
     * The longest a UI tool waits, in the call, for the outcome of work its
     * action started (a GPU job, an export). Work that ends within it is
     * reported done; work that does not is reported still running, and the
     * turn ends: its outcome is in the page state the next turn reads.
     * Default 20 s (`DEFAULT_JOB_WAIT_MS`).
     */
    jobWaitMs?: number;
    /** Largest page-state payload given to the model, in characters. Default 12000 (`DEFAULT_PAGE_STATE_CHARS`). */
    maxObservationChars?: number;
    /** How much of one action's result the model is given, in characters of JSON. Default 24000 (`DEFAULT_ANSWER_DATA_CHARS`). */
    maxAnswerDataChars?: number;
    /** Longest the page's index is in the model's context, in characters, before its furthest surfaces are listed by action id only. Default 60000 (`DEFAULT_INDEX_CHARS`). */
    maxIndexChars?: number;
  };

  /** Approvals: where they are kept, and the host's say before one is asked for (approvals/hooks.ts). */
  approvals?: {
    /**
     * The approval store. Defaults to the realtime server's
     * (`/internal/approvals`), where it lives beside the UI action results.
     */
    store?: ApprovalStoreClient;
    /**
     * Writes the approval's display copy in place of the one built from the
     * action's declaration: what is stored with it, sent to the room and read
     * back (`readback`), and what a voice speaks (`spokenReadback`). For
     * redaction, and the person's language (`ctx.locale`). The call that runs,
     * and its args hash, stay the model's. A throw, or something that is not a
     * preview, means the approval cannot be asked for: the call is not run.
     */
    preview?: ApprovalPreviewHook;
    /**
     * Checks a call that needs approval before it is read back. `{ ok: false,
     * error }` refuses it: nothing is stored or shown, and the model gets
     * `error` as the call's result, so it can correct the call. A throw
     * refuses it too.
     */
    validateBeforeApproval?: ValidateBeforeApproval;
  };

  /**
   * Called with every turn before it runs, on every channel (`info.channel`:
   * the Lambda and container adapters, the live-call handler, or a host
   * calling `runner.run`). Return the payload to run, changed or not: redact
   * the person's words before the model reads them (`content`), shape the
   * context. Return null to refuse the turn: nothing runs, nothing is
   * recorded or sent to the room, and the outcome is `refused` with
   * `refusedBy: 'beforeTurn'` (a live call answers `error` `TURN_DECLINED`).
   * Tell your own client why. The turn's id, conversation, user, account and
   * room cannot be changed here. A throw fails the turn.
   */
  beforeTurn?: (payload: AgentTurnPayload, info: AgentTurnInfo) => AgentTurnPayload | null | Promise<AgentTurnPayload | null>;

  /**
   * Decides what of each turn event leaves the runtime (emit/filter.ts):
   * return the payload to send, changed or not (it is a copy), or null to
   * send nothing. It runs before the room, before a host observing the turn,
   * and so before the live-call handler speaks anything. Synchronous, so the
   * turn's events keep their order. A throw, or a return that is neither a
   * payload nor null, drops the event and logs it. UI action requests to the
   * user's own tab are not turn events and do not pass through it.
   */
  filterEvent?: (event: string, data: Record<string, unknown>, turn: AgentTurnInfo) => Record<string, unknown> | null;

  /**
   * Stopping a turn. The stop request is kept by the realtime
   * server, and the turn asks for it there unless `client` says otherwise.
   */
  stops?: {
    client?: TurnStopClient;
    /** How long after a stop an answer already on its way is still waited for. Default 2 s. */
    graceMs?: number;
  };

  /**
   * The host's file area: with it, a turn's files are given to
   * the model, and the attachment tools reach the conversation's files.
   */
  attachments?: AttachmentWorkerConfig;

  // ─── Integrator Callbacks ────────────────────────────────────────────

  /**
   * Returns a database client/handle. Called once per invocation.
   * The returned value is passed to `getHistory` and `persistMessages`.
   *
   * Example: `async () => prisma`
   */
  getDb: () => Promise<TDb>;

  /**
   * Loads conversation history for context. Called once per turn.
   * Return prior user/assistant/tool messages in chronological order, and the
   * `staff` entries of a person who took the conversation over (ADR-0260 §2.5).
   *
   * The SDK handles appending the current user message — don't include it.
   */
  getHistory: (conversationId: string, db: TDb, turn: HistoryRequest) => Promise<TurnHistoryMessage[] | TurnHistory>;

  /**
   * Persists the new messages generated during this turn. Called once, before
   * the client is told the turn ended, whether it ended by itself or was
   * stopped (`stopped` is then set, and the last assistant message carries the
   * same marker).
   *
   * A host that lets a newer turn give up on this one answers
   * `{ stored: false }` when it found the turn already given up on and stored
   * nothing. The turn is still announced, and nothing that depends on its
   * messages being stored (an expired approval's confirmation) is done.
   */
  persistMessages: (input: {
    turnId: string;
    conversationId: string;
    messages: TurnMessage[];
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    stopped?: TurnStoppedMarker;
    db: TDb;
  }) => Promise<void | { stored: false }>;

  /**
   * Optional: record turn start in your database. Receives the db handle.
   * Default: no-op (the SDK still emits `agent:turn_started` to realtime).
   *
   * A host that keeps a row per turn claims it here. Answering
   * `{ run: false, reason }` says the turn must not run: its row shows it
   * already ended or was given up on, which is what a queue's redelivery of
   * an old turn finds. The turn then does nothing: no model
   * call, no UI action, no event to the client.
   */
  recordTurnStart?: (input: {
    turnId: string;
    conversationId: string;
    userId: string;
    accountId: string;
    model: string;
    db: TDb;
  }) => Promise<void | { run: false; reason: string }>;

  /**
   * Optional: record turn completion. Default: no-op.
   */
  recordTurnComplete?: (input: {
    turnId: string;
    conversationId: string;
    rounds: number;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** Set when the turn was stopped rather than ending by itself. */
    stopReason?: TurnStoppedReason;
    /** What the turn gave the model of its files: a host keeps `estimatedTokens` for the conversation's cap. */
    attachments?: AttachmentUsage;
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: record turn failure. Default: no-op.
   *
   * `error.code` is `TURN_DEADLINE_EXCEEDED` for a turn that ran out of time
   * and whose stop path could not store what it had. When the
   * store did not finish in time it may still finish after this is called, so
   * record the failure only over a turn that is still running (a conditional
   * update from `running`): a turn whose messages did get stored keeps that.
   */
  recordTurnFailure?: (input: {
    turnId: string;
    conversationId: string;
    error: { code: string; message: string; recoverable: boolean };
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: custom logger. Default: structured console logger.
   */
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
    debug: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/** The Lambda adapter's configuration: the runtime's, unchanged. */
export type LambdaAgentConfig<TDb = IntegratorDb> = AgentRuntimeConfig<TDb>;
