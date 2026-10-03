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
import type { ApprovalContinuation } from '@ouispec/agent-core';

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
  getHistory: (conversationId: string, db: TDb) => Promise<TurnHistoryMessage[]>;

  /**
   * Persists the new messages generated during this turn.
   * Called after the turn completes successfully.
   */
  persistMessages: (input: {
    turnId: string;
    conversationId: string;
    messages: TurnMessage[];
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: record turn start in your database. Receives the db handle.
   * Default: no-op (the SDK still emits `agent:turn_started` to realtime).
   */
  recordTurnStart?: (input: {
    turnId: string;
    conversationId: string;
    userId: string;
    accountId: string;
    model: string;
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: record turn completion. Default: no-op.
   */
  recordTurnComplete?: (input: {
    turnId: string;
    conversationId: string;
    rounds: number;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    db: TDb;
  }) => Promise<void>;

  /**
   * Optional: record turn failure. Default: no-op.
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
