/**
 * The agent runtime's configuration: what the host supplies, for either host
 * adapter (Lambda + SQS, or a container). Every seam without a `?` is
 * required, and a missing one fails at start-up, naming it (ADR-0227 §2.2).
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
import type { ApprovalContinuation, AttachmentRef, TurnStoppedReason, TurnStoppedMarker } from '@ouispec/agent-core';
import type { AttachmentWorkerConfig } from '../attachments/store.js';
import type { AttachmentUsage } from '../attachments/guard.js';
import type { TurnStopClient } from '../stop/turn-stop.js';

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
   * token to redeem, or that they declined (ADR-0228 §2.2.5).
   */
  approval?: ApprovalContinuation;
  /**
   * The turns of this conversation that this turn supersedes (ADR-0252 §2.5):
   * the host asked each to stop when this turn's message arrived. The host's
   * `getHistory` is given them, to wait until each is stored before it reads.
   */
  supersedes?: string[];
  /**
   * The files attached to the turn's message, by reference (ADR-0252 §2.8).
   * The host checked each is ready and is this conversation's before it
   * enqueued the turn; the worker reads them through `attachments.store`.
   */
  attachments?: AttachmentRef[];
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
   * on the turn (`context.oui`, ADR-0209), and the SDK builds them itself.
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

  /** The model, from any `ai` library provider (ADR-0227 §2.2, D5). Required. */
  model: LanguageModel;

  /**
   * Provider options that mark a prompt-cache breakpoint (see
   * PROMPT_CACHE_BREAKPOINTS). Omit for a provider that caches on its own.
   */
  promptCacheBreakpoint?: ProviderOptions;

  /** Max tool-use rounds per turn. Default: 12 */
  maxRounds?: number;

  /** Max tokens per model response. Default: 4096 */
  maxTokens?: number;

  /** Temperature. Default: 0.3. `null` sends none, for a model that does not take one. */
  temperature?: number | null;

  /** Per-tool execution timeout in ms. Default: 30000 */
  toolTimeoutMs?: number;

  /** Total turn deadline in ms. Default: 840000 (14 min). Keep it below the host's own limit. */
  turnDeadlineMs?: number;

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
    /** Longest the page's index is in the model's context, in characters, before its furthest surfaces are listed by action id only. Default 60000 (`DEFAULT_INDEX_CHARS`, ADR-0245). */
    maxIndexChars?: number;
  };

  /**
   * The approval store (ADR-0228). Defaults to the realtime server's
   * (`/internal/approvals`), where it lives beside the UI action results.
   */
  approvals?: {
    store?: ApprovalStoreClient;
  };

  /**
   * Stopping a turn (ADR-0252). The stop request is kept by the realtime
   * server, and the turn asks for it there unless `client` says otherwise.
   */
  stops?: {
    client?: TurnStopClient;
    /** How long after a stop an answer already on its way is still waited for. Default 2 s. */
    graceMs?: number;
  };

  /**
   * The host's file area (ADR-0252 §3): with it, a turn's files are given to
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
   * Return prior user/assistant/tool messages in chronological order.
   *
   * The SDK handles appending the current user message — don't include it.
   */
  getHistory: (conversationId: string, db: TDb, turn: HistoryRequest) => Promise<TurnHistoryMessage[]>;

  /**
   * Persists the new messages generated during this turn. Called once, before
   * the client is told the turn ended, whether it ended by itself or was
   * stopped (`stopped` is then set, and the last assistant message carries the
   * same marker: ADR-0252 §2.3).
   *
   * A host that lets a newer turn give up on this one (ADR-0252 §2.5) answers
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
   * an old turn finds (ADR-0252 §2.5). The turn then does nothing: no model
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
    /** Set when the turn was stopped rather than ending by itself (ADR-0252). */
    stopReason?: TurnStoppedReason;
    /** What the turn gave the model of its files: a host keeps `estimatedTokens` for the conversation's cap. */
    attachments?: AttachmentUsage;
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: record turn failure. Default: no-op.
   *
   * `error.code` is `TURN_DEADLINE_EXCEEDED` for a turn that ran out of time
   * and whose stop path could not store what it had (ADR-0252 §6.4). When the
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
