/**
 * Re-export the config type for convenience.
 */
export type { AgentClientConfig } from '@ouispec/agent-core';
import type {
  ApprovalRequiredProtocolEvent,
  SocketLike,
  AgentConversationChanges,
  AgentConversationFilter,
  AgentConversationSummary,
  TurnStoppedReason,
} from '@ouispec/agent-core';

export interface AgentToolCallState {
  id: string;
  name: string;
  /** What the assistant called it with: a session's record can be replayed from it (ADR-0244 §2.7). */
  arguments?: Record<string, unknown>;
  /** `stopped`: the turn was stopped before this call's result arrived here. */
  status: 'running' | 'complete' | 'error' | 'stopped';
  result?: unknown;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  timestamp: number;
  toolCall?: AgentToolCallState;
  isStreaming?: boolean;
  /**
   * Set on the assistant message of a turn that was stopped (ADR-0252): by
   * the person, or by a newer message. What it had said is kept.
   */
  stopped?: TurnStoppedReason;
}

export type DebugLogLevel = 'info' | 'warn' | 'error' | 'event' | 'socket';

/**
 * Debug log namespaces — mirrors server-side for consistent filtering.
 *
 *   agent:socket      — socket connect/disconnect/reconnect
 *   agent:protocol    — parsed protocol events (token, done, error, intent_call, etc.)
 *   agent:state       — provider state transitions (streaming, conversationId, etc.)
 *   agent:api         — API calls (createConversation, sendMessage)
 */
export type DebugLogNamespace =
  | 'agent:socket'
  | 'agent:protocol'
  | 'agent:state'
  | 'agent:api';

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  level: DebugLogLevel;
  ns: DebugLogNamespace;
  message: string;
  data?: unknown;
}

export interface AgentDebugState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  logs: DebugLogEntry[];
  clearLogs: () => void;
  namespaces: DebugLogNamespace[];
  /**
   * The session as its export holds it: every message, each call the
   * assistant made with its arguments and outcome, the debug logs, the
   * connection state, and the package and version that wrote it. What a host
   * attaches to a bug report, and what `exportSession` downloads.
   */
  sessionRecord: () => AgentSessionRecord;
  /**
   * Export the full agent session state as a downloadable JSON file.
   * Includes messages, debug logs, connection state, and metadata.
   * Useful for sharing with engineering when debugging agent behavior.
   */
  exportSession: () => void;
}

/** A session as it is exported (ADR-0244 §2.7). */
export interface AgentSessionRecord {
  exportedAt: string;
  /** The package that wrote it, and its version. */
  sdk: string;
  sdkVersion: string;
  session: {
    conversationId: string | null;
    currentTurnId: string | null;
    connected: boolean;
    isStreaming: boolean;
    messageCount: number;
    messages: Array<{
      id: string;
      role: AgentMessage['role'];
      content: string | null;
      timestamp: string;
      isStreaming?: boolean;
      toolCall?: AgentToolCallState;
    }>;
  };
  debug: { enabled: boolean; logCount: number; logs: DebugLogEntry[] };
  environment: { userAgent: string; url: string; realtimeUrl: string };
}

/**
 * A call a turn stopped at for the user's approval (ADR-0228): what the
 * approval card shows. Its words come from the action's declaration.
 */
export type AgentApprovalRequest = Omit<ApprovalRequiredProtocolEvent, 'type'>;

export interface PresentedOptions {
  prompt: string;
  options: Array<{ label: string; value: string; description?: string }>;
  style?: string;
}

/**
 * The user's earlier conversations. Available when the platform provides both
 * `listConversations` and `getConversation`.
 */
export interface AgentHistoryState {
  available: boolean;
  /**
   * What the platform lets the user do to a listed conversation: rename it
   * (`renameConversation`), file or archive it (`updateConversations`), delete
   * it (`deleteConversations`).
   */
  manage: { rename: boolean; update: boolean; remove: boolean };
  /** The most recent conversations that pass `filter`, newest first, as last fetched by `refresh`. */
  conversations: AgentConversationSummary[];
  total: number;
  /** Which conversations `conversations` holds. */
  filter: AgentConversationFilter;
  loading: boolean;
  /** Why the last list or load failed, for the user; null when it did not. */
  error: string | null;
  /** Fetch the most recent conversations; with a filter, the ones it names, from now on. */
  refresh: (filter?: AgentConversationFilter) => Promise<void>;
  /**
   * List a page of conversations for a view of its own (a search, a page of
   * results), leaving `conversations` as it is. Rejects when the platform
   * cannot list them.
   */
  query: (
    params: { limit: number; offset: number } & AgentConversationFilter,
  ) => Promise<{ conversations: AgentConversationSummary[]; total: number }>;
  /**
   * Rename a conversation: a string is the user's own name; `null` asks the
   * platform to name it. Rejects with the platform's reason.
   */
  rename: (conversationId: string, title: string | null) => Promise<AgentConversationSummary>;
  /** File or archive conversations, all or none. Rejects with the platform's reason. */
  update: (conversationIds: string[], changes: AgentConversationChanges) => Promise<AgentConversationSummary[]>;
  /**
   * Delete conversations for good, all or none. Deleting the open one starts a
   * new one; it is refused while that one is answering.
   */
  remove: (conversationIds: string[]) => Promise<void>;
  /**
   * Counts every change made through `rename`, `update` and `remove`, so a view
   * that lists with `query` knows to fetch again.
   */
  revision: number;
}

export interface AgentContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  /**
   * Sends the person's message. While a turn is running this is a barge-in
   * (ADR-0252 §2.5): the platform stops the running turn and this message
   * runs next. The tab's turn is the new one from this call on.
   */
  sendMessage: (content: string, attachments?: File[]) => Promise<{ turnId: string }>;
  /**
   * Stops the turn in progress (ADR-0252 §2.14). What it had produced is
   * kept. Does nothing when no turn is running or a stop is already asked.
   */
  stopTurn: () => Promise<void>;
  /** True from the person's Stop until the turn's end arrives. */
  isStopping: boolean;
  /**
   * The turn whose UI requests this tab runs now, or null: read when a request
   * arrives, not at render. Null while no turn runs, while a new turn has no
   * id yet, and from the moment a stop is asked, so a request a stopped or
   * superseded turn sends late is refused. Give it to the tab's OUI runtime:
   * `accept: acceptCurrentTurn(agent.acceptedTurnId)`.
   */
  acceptedTurnId: () => string | null;
  messages: AgentMessage[];
  isStreaming: boolean;
  currentTurnId: string | null;
  conversationId: string | null;
  connected: boolean;
  debug: AgentDebugState;
  isProcessing: boolean;
  presentedOptions: PresentedOptions | null;
  selectOption: (value: string) => void;
  dismissOptions: () => void;
  /**
   * The call the last turn stopped at for the user's approval, until they
   * decide on the approval card. Read-only: only `ApprovalCard` decides.
   */
  pendingApproval: AgentApprovalRequest | null;
  /** The provider's socket, for the tab's OUI transport. Null when not connected. */
  socket: SocketLike | null;
  /** The user's earlier conversations. */
  history: AgentHistoryState;
  /** True while a conversation's messages are loading (a restore after reload, or a switch). */
  isLoadingConversation: boolean;
  /**
   * Show an earlier conversation and continue it. Does nothing while a turn is
   * streaming or when the platform cannot load conversations.
   */
  switchConversation: (conversationId: string) => Promise<void>;
  /** Start over: the next message creates a new conversation. Does nothing while a turn is streaming. */
  startNewConversation: () => void;
}
