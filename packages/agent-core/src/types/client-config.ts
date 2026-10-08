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
import type { TurnStoppedMarker } from '../turns/types.js';
import type { AttachmentLimits, AttachmentRef } from '../attachments/types.js';
import type { MessageInput } from '../message-input/index.js';
import type { ConversationHold, StaffSpeaker, TakeoverChange } from '../takeover/index.js';


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
  /**
   * How the person entered this message, when it was not typed (ADR-0259
   * §2.6): `{ mode: 'voice', language }` for a message they spoke, with the
   * language the recogniser detected. Pass it to the worker unchanged on the
   * turn's `context`, and store it on the user's message (`AgentStoredMessage.input`).
   */
  input?: MessageInput;
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
  /**
   * How the person entered the matched message, when they spoke it (ADR-0259
   * §2.6), as stored on it (`AgentStoredMessage.input`). Absent or null when typed.
   */
  input?: MessageInput | null;
}

/** A conversation in the user's history, as the platform lists it. */
export interface AgentConversationSummary {
  conversationId: string;
  /** The conversation's title, when the platform has one. */
  title: string | null;
  /** A short excerpt to name it by when there is no title: usually its first user message. */
  preview?: string | null;
  /**
   * How the person entered the message `preview` is taken from, when they
   * spoke it (ADR-0259 §2.6), as stored on it (`AgentStoredMessage.input`), so
   * a list can mark a conversation that began by voice. Absent or null when
   * that message was typed, or when there is no preview.
   */
  previewInput?: MessageInput | null;
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
 *
 * A person on the staff who took the conversation over (ADR-0260 §2.5) writes
 * `staff` messages, each with its `speaker`; the take-over and the hand-back
 * are `staff` entries too, with `takeover` and no content.
 */
export interface AgentStoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'staff' | (string & {});
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> | null;
  toolCallId?: string | null;
  createdAt: string;
  /**
   * Set on the last assistant message of a turn that was stopped (ADR-0252).
   * The panel labels the message; a later turn's history says so after its text.
   */
  stopped?: TurnStoppedMarker | null;
  /** The files the person attached to this message (ADR-0252 §2.8), by reference. */
  attachments?: AttachmentRef[] | null;
  /**
   * How the person entered this message, as its turn's `context.input` carried
   * it (ADR-0259 §2.6): set on a message they spoke. Absent or null when typed.
   */
  input?: MessageInput | null;
  /** On a `staff` message or entry: the person on the staff (ADR-0260 §2.5). */
  speaker?: StaffSpeaker | null;
  /** On a `staff` entry with no content: the conversation was taken over here, or handed back. */
  takeover?: TakeoverChange | null;
}

/** One stored conversation, with its most recent messages in chronological order. */
export interface AgentStoredConversation {
  conversationId: string;
  title: string | null;
  messages: AgentStoredMessage[];
  /**
   * Who holds the conversation now (ADR-0260 §2.1), as the realtime server
   * says (`GET /internal/conversations/{id}/hold`); null or absent when the
   * agent answers it.
   */
  hold?: ConversationHold | null;
}

/**
 * A conversation as a person on the staff sees it (ADR-0260 §2.7): every
 * stored message (the customer's, the agent's and the staff's), who holds it
 * now, and who the viewer would be as its holder.
 */
export interface StaffConversation extends AgentStoredConversation {
  hold: ConversationHold | null;
  /** The staff member viewing it, as they would hold it. */
  self: StaffSpeaker;
}

/**
 * The staff console's routes, on the product's API (ADR-0260 §2.2): each
 * checks the staff member's permission itself, then calls the realtime
 * server's conversation routes. The SDK never decides staff permissions.
 */
export interface StaffConsoleSeam {
  /** The conversation as staff see it. Rejects when this staff member may not see it. */
  getConversation(conversationId: string): Promise<StaffConversation>;
  /**
   * Take it over: the product checks the permission, withdraws a waiting
   * approval, stores the take-over entry and holds the conversation. Resolves
   * with the hold; rejects (with why) when someone else holds it or it is refused.
   */
  takeOver(conversationId: string): Promise<ConversationHold>;
  /** Hand it back: the product stores the hand-back entry and releases the hold. */
  handBack(conversationId: string): Promise<void>;
  /** Write to the customer as staff: the product stores the message, then announces it. Resolves with it as stored. */
  sendMessage(params: { conversationId: string; content: string }): Promise<AgentStoredMessage>;
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
    /**
     * The page's context for the turn. Pass it to the worker as the turn
     * payload's `context`. A message the person spoke carries `input` here
     * (ADR-0259 §2.6), which the platform also stores on the user's message.
     */
    context?: AgentMessageContext;
    /**
     * The files attached to this message, already uploaded through
     * `attachments.upload` (ADR-0252 §2.8): the platform sends their ids.
     * No file's bytes go with a message.
     */
    attachments?: AttachmentRef[];
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
   * Asks the platform's API to stop a turn (ADR-0252 §2.14). The Stop control
   * asks over the socket first; this is used when the socket cannot be reached
   * or the stop is not confirmed in time. The platform checks that the turn is
   * the user's, and records the same stop the socket would have. Optional: a
   * platform without it stops only over the socket.
   */
  stopTurn?: (params: { turnId: string; conversationId: string | null }) => Promise<void>;

  /**
   * The platform's file area (ADR-0252 §2.8, §3). With it, the person can
   * attach files to a message: each is uploaded when it is attached, and the
   * message carries references. Without it, nothing can be attached.
   */
  attachments?: AttachmentClientSeam;

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
   * The conversation's room, and the token to join it (ADR-0260 §2.4): the
   * product's API mints it for the customer whose conversation it is, or for a
   * staff member it lets watch it. With it, the customer's tab follows a
   * take-over, a person's messages and a hand-back as they happen, and the
   * staff console follows the conversation live. Without it, neither does.
   */
  conversationRoom?: (conversationId: string) => Promise<{ room: string; roomToken?: string }>;

  /**
   * The staff console's routes (ADR-0260 §2.7), for `useStaffConversation`:
   * take a conversation over, write as staff, hand it back. A customer-facing
   * app leaves it out.
   */
  staff?: StaffConsoleSeam;

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

/**
 * How a tab puts files in the platform's file area and takes them out
 * (ADR-0252 §3). The SDK holds the composer's state; the platform owns the
 * requests, the storage and every check.
 */
export interface AttachmentClientSeam {
  /** The platform's limits, so a file is refused before it is uploaded. Defaults to `DEFAULT_ATTACHMENT_LIMITS`. */
  limits?: AttachmentLimits | (() => Promise<AttachmentLimits>);
  /**
   * Upload one file to the conversation's file area and resolve its reference
   * once the platform has checked it and it can be used. Rejects with an
   * `Error` whose message says why it was refused, which the composer shows.
   */
  upload(
    file: File,
    options: { conversationId: string; signal: AbortSignal; onProgress?: (fraction: number) => void },
  ): Promise<AttachmentRef>;
  /** Remove a file from the conversation's file area. */
  remove?(ref: AttachmentRef, options: { conversationId: string }): Promise<void>;
}
