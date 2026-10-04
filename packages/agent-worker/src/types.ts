import type { LanguageModel, ProviderOptions } from './model.js';
import type { RealtimeEmitAdapter } from './emit/types.js';
import type { ToolRegistry } from './tools/types.js';
import type { TurnPolicy } from './turn-policy.js';
import type { ToolPolicy } from './authz/tool-policy.js';
import type { UIActionChannel } from './ui/channel.js';
import type { ApprovalStoreClient } from './approvals/client.js';
import type { ApprovalContinuation } from '@ouispec/agent-core';

/**
 * Configuration for the agent worker.
 * Platforms provide this to run the orchestration loop.
 */
export interface AgentWorkerConfig {
  tools: ToolRegistry;
  emit: RealtimeEmitAdapter;
  /**
   * The host's AgentApiSurface binding, threaded into ToolExecutionContext
   * so schema-generated tools can call executeIntent. Optional.
   */
  apiSurface?: import('@ouispec/agent-core').AgentApiSurface;
  systemPrompt: string | ((context: SystemPromptContext) => string);
  /** The model, from any `ai` library provider (ADR-0227 §2.2). Required. */
  model: LanguageModel;
  /**
   * Provider options that mark a prompt-cache breakpoint, placed after the
   * system prompt (which covers the tools) and at the end of the history.
   * See PROMPT_CACHE_BREAKPOINTS. Omit for a provider that caches on its own.
   */
  promptCacheBreakpoint?: ProviderOptions;
  maxToolRounds?: number;
  maxTokens?: number;
  /**
   * The sampling temperature. Default 0.3. `null` sends none: for a model that
   * does not take one (Claude Sonnet 5.5 on Bedrock refuses a request that
   * names it), the model's own sampling is used.
   */
  temperature?: number | null;
  toolTimeoutMs?: number;
  turnDeadlineMs?: number;
  retries?: number;
  /** Optional turn policy for product-specific step control. */
  turnPolicy?: TurnPolicy;
  /**
   * Per-tool authorization policy. Evaluated before every tool execution.
   * If omitted, the default policy allows all tools.
   * Policy errors are fail-closed (treated as deny).
   */
  toolPolicy?: ToolPolicy;
  /**
   * The approval store (ADR-0228), in the realtime server. A call that needs
   * the user's approval is stored there and the turn stops; without a store,
   * such a call is refused and never runs.
   */
  approvals?: ApprovalStoreClient;
  /**
   * How UI actions reach the client that sent the turn and how its answers
   * come back (ADR-0209). Required when a turn's context carries a client
   * snapshot (`context.oui`).
   */
  ui?: {
    channel: UIActionChannel;
    /** How long a UI tool waits for the client's answer. Default 20 s. */
    resultTimeoutMs?: number;
    /** Largest page-state payload given to the model, in characters. Default 12000 (`DEFAULT_PAGE_STATE_CHARS`). */
    maxObservationChars?: number;
    /** Largest index of the page's actions given to the model, in characters. Default 60000 (`DEFAULT_INDEX_CHARS`). */
    maxIndexChars?: number;
  };
  /**
   * Called with what the turn produced, after its last step and before the
   * client is told the turn is complete. A host stores the turn's messages
   * here, so that a message the person sends the moment the turn completes is
   * answered from a history that holds it: told first and stored after, the
   * next turn read a history without the turn that had just finished, and the
   * model did its work again.
   *
   * It is awaited. If it rejects, the rejection is logged and the turn still
   * completes: a turn that answered is not turned into a failure by its record.
   */
  beforeTurnComplete?: (turn: Pick<AgentTurnResult, 'rounds' | 'usage' | 'newMessages'>) => Promise<void>;
}

export interface SystemPromptContext {
  userId: string;
  accountId: string;
  context?: Record<string, unknown> | null;
}

/**
 * Input for a single agent turn.
 */
export interface AgentTurnInput {
  turnId: string;
  conversationId: string;
  userId: string;
  accountId: string;
  socketRoom: string;
  content: string;
  context?: Record<string, unknown> | null;
  history?: TurnHistoryMessage[];
  userToken?: string;
  /**
   * Set on the turn that follows the user's decision on an approval card: the
   * token to redeem, or that they declined (ADR-0228 §2.2.5). Never in the
   * message text.
   */
  approval?: ApprovalContinuation;
}

/**
 * Rich history message — supports full conversation state including tool calls and results.
 * This is the format integrators prepare from their conversation store.
 */
export type TurnHistoryMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallRef[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface ToolCallRef {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Result from a completed agent turn.
 */
export interface AgentTurnResult {
  rounds: number;
  usage: {
    /** Input tokens summed over every round of the turn — what the turn cost. */
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /**
     * Input tokens on the LARGEST single round — what the context window sees.
     * Compare a context ceiling against this, never against `promptTokens`:
     * the sum grows with round count and reports a context problem that is not
     * there while staying silent about one that is.
     */
    peakPromptTokens: number;
    /** Prefix tokens served from cache. Zero across a multi-round turn means the cache is being missed. */
    cacheReadTokens: number;
    /** Prefix tokens written to cache — expected on the first round of a turn. */
    cacheWriteTokens: number;
  };
  newMessages: TurnMessage[];
  maxRoundsReached: boolean;
  /** Why the turn ended: which bound or condition terminated the loop */
  stopReason: 'present_options' | 'awaiting_approval' | 'step_count' | 'token_budget' | 'deadline' | 'complete' | 'error';
}

export interface TurnMessage {
  role: 'assistant' | 'tool';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  name?: string;
}
