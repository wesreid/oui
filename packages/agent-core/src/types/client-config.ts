/**
 * AgentClientConfig — the minimal configuration a platform provides to integrate
 * the agent SDK. The SDK has zero knowledge of URLs, endpoints, or
 * response shapes. All API interactions are delegated to platform-provided callbacks.
 *
 * The SDK owns: socket connection, room subscriptions, event parsing.
 * The platform provides: API callbacks and realtime auth.
 *
 * UI control is not configured here. The agent acts in the UI through the
 * client's OUI surfaces, which the client sends with each turn and which
 * answer every action themselves (ADR-0209).
 */

import type { AgentProtocolEvent } from '../protocol/index.js';
import type { ViewAnnotationState } from './api-surface.js';
import type { ApprovalContinuation, ApprovalGrant } from '../approvals/types.js';


/**
 * Context sent alongside each message. The SDK collects visible annotations
 * and current route automatically; platforms can add custom metadata.
 */
export interface AgentMessageContext {
  currentPath?: string;
  visibleAnnotations?: ViewAnnotationState[];
  metadata?: Record<string, unknown>;
  /**
   * The user's IANA time zone as their browser reports it ("Europe/Paris").
   * The worker tells the model today's date and the time in this zone, so
   * "today" and "yesterday" are the user's days, not the server's.
   */
  timeZone?: string;
}

/**
 * The socket the SDK drives: connect and disconnect, emit (with an optional
 * acknowledgement callback as the last argument), and listen. A Socket.IO
 * client socket satisfies it, and so does any transport that emits `connect`
 * on every (re)connection and `disconnect` when it drops.
 *
 * It is a superset of oui-spec's `SocketLike`, so the same socket can carry
 * the tab's OUI transport.
 */
export interface SocketLike {
  readonly connected: boolean;
  readonly id?: string;
  connect(): void;
  disconnect(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listeners take whatever the event carries
  emit(event: string, ...args: any[]): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, handler: (...args: any[]) => void): unknown;
}

/**
 * Realtime connection config. The SDK creates and manages its own connection
 * using these parameters — the platform never touches sockets.
 */
export interface AgentRealtimeConfig {
  /** The realtime server's URL (e.g. "wss://realtime.example.com"). */
  url: string;
  /** Returns a fresh auth token for socket authentication. Called on each connect/reconnect. */
  getToken: () => string | Promise<string>;
  /**
   * Makes the socket, unconnected: the SDK calls `connect()` itself. Default:
   * a Socket.IO client that reconnects forever and authenticates with
   * `getToken` on every connection. Supply one for another transport.
   */
  createSocket?: (options: { url: string; getToken: () => string | Promise<string> }) => SocketLike;
}

/**
 * Where the platform files a conversation: a project, a workspace, a folder.
 * A conversation is filed in at most one.
 */
export interface AgentConversationScope {
  id: string;
  name: string;
}

/** One of a conversation's messages that matched a search. */
export interface AgentConversationMatch {
  messageId: string;
  role: 'user' | 'assistant';
  /** The text around the words searched for, on one line. */
  excerpt: string;
  createdAt: string;
}

/** A conversation in the user's history, as the platform lists it. */
export interface AgentConversationSummary {
  conversationId: string;
  /** The conversation's title, when the platform has one. */
  title: string | null;
  /** A short excerpt to name it by when there is no title: usually its first user message. */
  preview?: string | null;
  createdAt: string;
  updatedAt: string;
  /** When it last had a message; lists are ordered by it. Defaults to `updatedAt`. */
  lastActiveAt?: string;
  /** Where it is filed; null when it is filed nowhere. Absent when the platform does not file conversations. */
  scope?: AgentConversationScope | null;
  /** When it was archived; archived conversations are listed only when asked for. */
  archivedAt?: string | null;
  /** When the list was searched: the messages that matched. */
  matches?: AgentConversationMatch[];
}

/** Which conversations to list. */
export interface AgentConversationFilter {
  /** Only those filed in this scope; `null` for those filed nowhere; omitted for all. */
  scopeId?: string | null;
  /** `active` (the default) leaves out archived conversations; `archived` lists only those. */
  status?: 'active' | 'archived' | 'all';
  /** Words the conversation's title or one of its messages contains, all of them. */
  search?: string;
}

/** What changes about several conversations at once. */
export interface AgentConversationChanges {
  /** File them in this scope; `null` files them nowhere. */
  scopeId?: string | null;
  archived?: boolean;
}

/**
 * A message as the platform stored it. An assistant message that called tools
 * carries them in `toolCalls`; each call's result follows as a `tool` message,
 * in the same order (or matched by `toolCallId` when the platform keeps it).
 */
export interface AgentStoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | (string & {});
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> | null;
  toolCallId?: string | null;
  createdAt: string;
}

/** One stored conversation, with its most recent messages in chronological order. */
export interface AgentStoredConversation {
  conversationId: string;
  title: string | null;
  messages: AgentStoredMessage[];
}

/**
 * The complete client configuration. A platform provides this and nothing else.
 * The SDK never makes HTTP requests — all API calls are the platform's responsibility.
 * The SDK owns the socket connection — the platform only provides URL + auth.
 */
export interface AgentClientConfig {
  /**
   * Platform callback to create a new conversation.
   * How this is implemented (REST, GraphQL, gRPC, etc.) is entirely up to the platform.
   * Returns a conversation identifier the SDK uses to track state.
   */
  createConversation: () => Promise<{ conversationId: string }>;

  /**
   * Platform callback to send a message within a conversation.
   * Returns a turnId and socketRoom so the SDK knows where to listen for streaming events.
   *
   * `roomToken` is REQUIRED in practice for turn rooms. The realtime server
   * refuses a token-guarded room without a signed token binding the user to
   * that exact room, and the platform's API mints one per turn
   * (`POST /internal/room-token`). It is typed optional only so integrators on
   * an older realtime server are not broken by this field appearing.
   *
   * Dropping it is silent and total: the socket connects, the turn runs to
   * completion server-side, the emit succeeds — and the client is not in the
   * room, so nothing ever arrives.
   */
  sendMessage: (params: {
    conversationId: string;
    content: string;
    context?: AgentMessageContext;
    attachments?: File[];
    /**
     * Set on the turn the approval card starts after the user's decision
     * (ADR-0228 §2.2.5): the token to redeem, or that they declined. The
     * platform passes it, unchanged, to the worker as the turn payload's
     * `approval`. Never put it in the message text. `content` is then empty:
     * the click is not a message.
     */
    approval?: ApprovalContinuation;
  }) => Promise<{ turnId: string; socketRoom: string; roomToken?: string }>;

  /**
   * Hands the user's approval to this tab's OUI runtime (`runtime.grantApproval`
   * in oui-spec), so the approved UI action runs when the worker dispatches it.
   * The approval card calls it after the user's click is accepted. Required for
   * approvals of UI actions: without it the tab refuses them. A platform whose
   * assistant has no UI actions may leave it out.
   */
  grantApproval?: (grant: ApprovalGrant) => void;

  /**
   * Platform callback listing the user's conversations, most recent first.
   * With `getConversation`, it lets the user return to an earlier conversation.
   */
  listConversations?: (
    params: { limit: number; offset: number } & AgentConversationFilter,
  ) => Promise<{ conversations: AgentConversationSummary[]; total: number }>;

  /**
   * Platform callback renaming a conversation. A string is the user's own name,
   * which the platform never replaces; `null` asks the platform to name it
   * itself, now. Resolves with the conversation as it is after the change.
   */
  renameConversation?: (conversationId: string, title: string | null) => Promise<AgentConversationSummary>;

  /**
   * Platform callback filing or archiving several conversations, all or none.
   * Resolves with them as they are after the change.
   */
  updateConversations?: (
    conversationIds: string[],
    changes: AgentConversationChanges,
  ) => Promise<AgentConversationSummary[]>;

  /** Platform callback deleting several conversations for good, all or none. */
  deleteConversations?: (conversationIds: string[]) => Promise<void>;

  /**
   * Platform callback loading one conversation with its messages. When it is
   * provided, the SDK restores the tab's active conversation after a reload
   * (see `activeConversationKey`) and can switch to a listed one. It rejects
   * when the conversation is gone or not the user's; the SDK then starts fresh.
   */
  getConversation?: (conversationId: string) => Promise<AgentStoredConversation>;

  /**
   * The `sessionStorage` key under which the SDK remembers the tab's active
   * conversation, so a reload returns to it and a new tab starts fresh. Only
   * used when `getConversation` is provided. `false` turns it off.
   * Default: "agent-sdk.activeConversation".
   */
  activeConversationKey?: string | false;

  /**
   * Realtime connection config. The SDK creates and manages its own Socket.IO
   * connection using this URL and auth token provider.
   */
  realtime: AgentRealtimeConfig;

  /**
   * Keyboard shortcut key to toggle the agent panel.
   * The SDK listens for Cmd/Ctrl + this key.
   * Default: "k"
   */
  shortcutKey?: string;

  /**
   * Optional callback for every protocol event received.
   * Useful for analytics, logging, or custom side effects.
   */
  onEvent?: (event: AgentProtocolEvent) => void;
}
