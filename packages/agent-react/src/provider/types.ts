/**
 * Re-export the config type for convenience.
 */
export type { AgentClientConfig } from '@ouispec/agent-core';
import type { AttachmentRef, MessageInput } from '@ouispec/agent-core';
import type { ComposerAttachmentsState, NotSentReason } from './attachments.js';

/** What goes with a message besides its text. */
export interface SendMessageOptions {
  /**
   * The files on the message, by reference. Without them, the message carries
   * the composer's ready files (`attachments` on `useAgent`), after waiting for
   * any still uploading.
   */
  attachments?: AttachmentRef[];
  /**
   * How the person entered the message, when they did not type it (ADR-0259
   * §2.6): `{ mode: 'voice', language }` for one they spoke, with the language
   * the recogniser detected. It reaches `config.sendMessage` as
   * `context.input`, and the message keeps it (`AgentMessage.input`). One that
   * `readMessageInput` does not recognise is not sent.
   */
  input?: MessageInput;
}

/** What `sendMessage` did: the turn it started, or why nothing was sent. */
export interface SendMessageResult {
  /** Empty when nothing was sent. */
  turnId: string;
  notSent?: { reason: NotSentReason; content: string };
}
import type {
  ApprovalRequiredProtocolEvent,
  ConversationHold,
  SocketLike,
  StaffSpeaker,
  TakeoverChange,
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
  /**
   * `staff`: a person on the staff wrote it, or it marks where they took the
   * conversation over or handed it back (`takeover`, ADR-0260 §2.7).
   */
  role: 'user' | 'assistant' | 'tool' | 'staff';
  content: string | null;
  timestamp: number;
  toolCall?: AgentToolCallState;
  isStreaming?: boolean;
  /**
   * Set on the assistant message of a turn that was stopped (ADR-0252): by
   * the person, or by a newer message. What it had said is kept.
   */
  stopped?: TurnStoppedReason;
  /** The files the person attached to this message (ADR-0252 §2.8), by reference. */
  attachments?: AttachmentRef[];
  /** How the person entered this message, when they did not type it: set on one they spoke (ADR-0259 §2.6). */
  input?: MessageInput;
  /** On a `staff` message: who wrote it, or who took the conversation over or handed it back. */
  speaker?: StaffSpeaker;
  /** On a `staff` message with no content: the conversation changed hands here. */
  takeover?: TakeoverChange;
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
      input?: MessageInput;
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
   *
   * The message carries the composer's ready files (`attachments`), after
   * waiting for any still uploading, unless references are given here: as
   * `options.attachments`, or as the second argument itself (an array).
   *
   * A message the person spoke says so with `options.input`
   * (`{ mode: 'voice', language }`, ADR-0259 §2.6). It is sent like a typed
   * one, and supersedes a running turn the same way.
   *
   * It is not sent, and `notSent` says why and hands back `content` for the
   * composer to keep as the draft, when a file on it is refused, when a send
   * already waits for its files, or when the conversation changes or the
   * person gives the send up (Stop) while it waits.
   */
  sendMessage: (content: string, options?: SendMessageOptions | AttachmentRef[]) => Promise<SendMessageResult>;
  /**
   * The files on the message being written (ADR-0252 §2.14): attach, watch
   * each upload, remove. `enabled` is false when the platform takes no files.
   */
  attachments: ComposerAttachmentsState;
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
  /** True while the agent is answering: a turn runs, and no person on the staff holds the conversation. */
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
  /**
   * Who holds the open conversation, when a person on the staff has taken it
   * over (ADR-0260 §2.7): the view shows who is answering. Null while the
   * agent answers. Followed live when the platform gives `conversationRoom`.
   */
  hold: ConversationHold | null;
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
