import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type {
  AgentClientConfig,
  AgentMessageContext,
  ApprovalContinuation,
  ApprovalDecideResult,
  ApprovalDecision,
} from '@ouispec/agent-core';
import { APPROVAL_DECIDE_EVENT, TURN_STOP_EVENT } from '@ouispec/agent-core';
import type { AttachmentRef, TurnStopPayload, TurnStoppedReason, TurnStopResult } from '@ouispec/agent-core';
import { useComposerAttachments, type TakeForSend } from './attachments.js';
import type { AgentProtocolEvent } from '@ouispec/agent-core';
import { ALL_AGENT_SOCKET_EVENTS, parseSocketEvent } from '@ouispec/agent-core';
import type { SocketLike } from '@ouispec/agent-core';
import { browserTimeZone } from './time-zone.js';
import { createSocketIOSocket } from './socketio.js';
import type {
  AgentConversationChanges,
  AgentConversationFilter,
  AgentConversationSummary,
} from '@ouispec/agent-core';
import type {
  AgentApprovalRequest,
  AgentContextValue,
  AgentMessage,
  DebugLogEntry,
  DebugLogLevel,
  DebugLogNamespace,
  AgentDebugState,
  PresentedOptions,
  SendMessageResult,
} from './types.js';
import { ApprovalDecisionContext, approvalRefusalText, type ApprovalDecisionState } from '../approvals/decision.js';
import { annotationRegistry } from '../annotations/singleton.js';
import { storedToAgentMessages } from './stored-messages.js';
import { SDK_PACKAGE, SDK_VERSION } from '../version.js';

const AgentContext = createContext<AgentContextValue | null>(null);

const MAX_DEBUG_LOGS = 500;
const DEFAULT_ACTIVE_CONVERSATION_KEY = 'agent-sdk.activeConversation';
const HISTORY_PAGE_SIZE = 20;
/** How long the card waits for the approval store to answer a click. */
const APPROVAL_DECIDE_TIMEOUT_MS = 10_000;
/** How long the server's answer to a Stop is waited for before the platform's API is asked instead. */
const STOP_ACK_TIMEOUT_MS = 3_000;
/** How long a stop may go unconfirmed by the turn's end before the turn is shown as stopped (ADR-0252 §2.14). */
export const STOP_CONFIRM_TIMEOUT_MS = 10_000;
/** How many ended turns the tab remembers, to ignore what they still send. */
const ENDED_TURNS_REMEMBERED = 20;

/**
 * The tab's remembered active conversation, in `sessionStorage` so a reload
 * returns to it and a new tab starts fresh. Storage can be missing or throw
 * (private windows, blocked site data): then nothing is remembered.
 */
function sessionKeyOf(config: AgentClientConfig): string | null {
  if (!config.getConversation || config.activeConversationKey === false) return null;
  return config.activeConversationKey ?? DEFAULT_ACTIVE_CONVERSATION_KEY;
}
function readRemembered(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeRemembered(key: string | null, conversationId: string | null): void {
  if (!key) return;
  try {
    if (conversationId) window.sessionStorage.setItem(key, conversationId);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Nothing is remembered; the conversation still works.
  }
}
/**
 * Whether a conversation still belongs in a list with this filter after a
 * change. Only what the SDK can see is checked: a search is the platform's.
 */
function passesFilter(summary: AgentConversationSummary, filter: AgentConversationFilter): boolean {
  const status = filter.status ?? 'active';
  if (status === 'active' && summary.archivedAt) return false;
  if (status === 'archived' && !summary.archivedAt) return false;
  if (filter.scopeId !== undefined && (summary.scope?.id ?? null) !== filter.scopeId) return false;
  return true;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ALL_DEBUG_NAMESPACES: DebugLogNamespace[] = ['agent:socket', 'agent:protocol', 'agent:state', 'agent:api'];
let debugLogCounter = 0;

function createDebugEntry(
  level: DebugLogLevel,
  ns: DebugLogNamespace,
  message: string,
  data?: unknown,
): DebugLogEntry {
  return {
    id: `dbg_${++debugLogCounter}`,
    timestamp: Date.now(),
    level,
    ns,
    message,
    data,
  };
}

/**
 * AgentProvider — turnkey provider that handles the complete agent lifecycle.
 *
 * The platform provides:
 * - createConversation() / sendMessage() — API callbacks
 * - realtime: { url, getToken } — where and how to connect
 *
 * The SDK owns:
 * - Socket.IO connection lifecycle (connect, reconnect, auth)
 * - Room subscription tied to active turns, kept across reconnects
 * - All event parsing (agent:* protocol)
 * - Streaming state, message history, keyboard shortcuts
 *
 * UI actions are not dispatched here: the client's OUI surface runtime answers
 * them on the same socket (ADR-0209).
 */
export function AgentProvider({ config, children }: { config: AgentClientConfig; children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // The same id, read by callbacks that must not wait for a re-render (a send
  // that follows a restore, a switch during a restore).
  const conversationIdRef = useRef<string | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const pendingLoadRef = useRef<Promise<void> | null>(null);
  const loadSeqRef = useRef(0);
  const [historyConversations, setHistoryConversations] = useState<AgentConversationSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // The listed conversations, read by changes that must not wait for a re-render.
  const historyConversationsRef = useRef<AgentConversationSummary[]>([]);
  const [historyFilter, setHistoryFilter] = useState<AgentConversationFilter>({});
  const historyFilterRef = useRef<AgentConversationFilter>({});
  const [historyRevision, setHistoryRevision] = useState(0);
  const isStreamingRef = useRef(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [presentedOptions, setPresentedOptions] = useState<PresentedOptions | null>(null);
  // The call a turn stopped at for the user's approval (ADR-0228), until they decide.
  const [pendingApproval, setPendingApproval] = useState<AgentApprovalRequest | null>(null);
  const [approvalDeciding, setApprovalDeciding] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // The turn the person asked to stop, from their Stop until its end arrives (ADR-0252 §2.14).
  const [isStopping, setIsStopping] = useState(false);
  const stoppingRef = useRef<{ turnId: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const socketRef = useRef<SocketLike | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // The room of the turn in progress and its token. A reconnect gives the
  // server a new socket that is in no room, so the join is repeated on every
  // connect while a turn is active; without it the turn streams to nobody and
  // the panel waits forever.
  const activeRoomRef = useRef<{ room: string; token?: string } | null>(null);
  const streamBufferRef = useRef<string>('');
  const roundPrefixRef = useRef<string>('');
  const configRef = useRef(config);
  const debugEnabledRef = useRef(debugEnabled);
  configRef.current = config;
  debugEnabledRef.current = debugEnabled;
  isStreamingRef.current = isStreaming;

  const shortcutKey = config.shortcutKey ?? 'k';

  const setActiveConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
    writeRemembered(sessionKeyOf(configRef.current), id);
  }, []);

  const addDebugLog = useCallback((level: DebugLogLevel, ns: DebugLogNamespace, message: string, data?: unknown) => {
    if (!debugEnabledRef.current) return;
    const entry = createDebugEntry(level, ns, message, data);
    setDebugLogs(prev => {
      const next = [...prev, entry];
      return next.length > MAX_DEBUG_LOGS ? next.slice(-MAX_DEBUG_LOGS) : next;
    });
  }, []);

  const clearDebugLogs = useCallback(() => setDebugLogs([]), []);

  // The conversation a message or a file goes to: made on first use, once,
  // however many files and messages ask for it at the same moment.
  const creatingRef = useRef<Promise<string> | null>(null);
  const ensureConversation = useCallback(async (): Promise<string> => {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (!creatingRef.current) {
      creatingRef.current = (async () => {
        addDebugLog('info', 'agent:api', 'Creating conversation...', {});
        const result = await configRef.current.createConversation();
        setActiveConversation(result.conversationId);
        addDebugLog('info', 'agent:api', `Conversation created: ${result.conversationId}`, { conversationId: result.conversationId });
        return result.conversationId;
      })().finally(() => {
        creatingRef.current = null;
      });
    }
    return creatingRef.current;
  }, [addDebugLog, setActiveConversation]);

  // The files on the message being written (ADR-0252 §2.14).
  const messagesRef = useRef<AgentMessage[]>([]);
  messagesRef.current = messages;
  const composer = useComposerAttachments({
    config: () => configRef.current,
    ensureConversation,
    conversationId: () => conversationIdRef.current,
    messages: () => messagesRef.current,
    log: (level, message, data) => addDebugLog(level, 'agent:api', message, data),
  });
  const { takeForSend, clear: clearComposer, ...composerState } = composer;
  const cancelWaitingSendRef = useRef(composer.cancelWaitingSend);
  cancelWaitingSendRef.current = composer.cancelWaitingSend;

  // --- Socket connection lifecycle (SDK-owned; the socket is a seam) ---
  useEffect(() => {
    const { url, getToken, createSocket = createSocketIOSocket } = config.realtime;
    if (!url) return;

    const socket = createSocket({ url, getToken });

    socket.on('connect', () => {
      setConnected(true);
      addDebugLog('info', 'agent:socket', 'Connected', { socketId: socket.id, url });
      const active = activeRoomRef.current;
      if (active) {
        addDebugLog('info', 'agent:socket', `Rejoining turn room after reconnect: ${active.room}`, { room: active.room });
        joinRoom(socket, active.room, active.token);
      }
    });
    socket.on('disconnect', (reason: string) => {
      setConnected(false);
      addDebugLog('warn', 'agent:socket', `Disconnected: ${reason}`, { reason });
    });
    socket.on('connect_error', (err: Error) => {
      addDebugLog('error', 'agent:socket', `Connection error: ${err.message}`, { error: err.message });
    });
    socket.on('reconnect_attempt', (attempt: number) => {
      addDebugLog('info', 'agent:socket', `Reconnecting (attempt ${attempt})`, { attempt });
    });

    socket.connect();
    addDebugLog('info', 'agent:socket', 'Connecting...', { url });
    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [config.realtime.url]);

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === shortcutKey) {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcutKey]);

  // --- Which turn is the tab's ---
  // A turn's end ends the tab's turn only when it is the turn the tab is
  // running. A turn that stops for the person's approval sends its completion
  // a moment after the card appears; a person who approves at once has started
  // the continuation by then. Applied blindly, that late completion switched
  // `isStreaming` off for the whole continuation, and a host that accepts the
  // assistant's requests only while a turn is in progress refused every one of
  // them (dev, 2026-10-03: "the page did not answer", and the approved action
  // never ran).
  //
  // - `turnId`: the turn the tab is running, once its start request has
  //   returned; null when it runs none.
  // - `starting`: a start is in flight, so the tab's turn has no id yet. An
  //   end that arrives now is neither applied nor dropped: it is held
  //   (`heldEndsRef`) and judged against the id once it is known.
  const liveTurnRef = useRef<{ starting: boolean; turnId: string | null }>({ starting: false, turnId: null });
  const turnStartsRef = useRef(0);
  const heldEndsRef = useRef<AgentProtocolEvent[]>([]);
  /**
   * Whether an event of turn `turnId` belongs to the turn the tab is running. While a new turn has
   * no id yet, nothing does: whatever still arrives is the turn before it, which a new message has
   * superseded (ADR-0252 §2.5), and its text and calls are no longer shown as in progress.
   */
  const ofLiveTurn = (turnId: string | undefined): boolean => {
    const { starting, turnId: live } = liveTurnRef.current;
    if (starting) return false;
    if (turnId !== undefined && endedTurnsRef.current.has(turnId)) return false;
    return live === null || turnId === undefined || turnId === live;
  };
  /**
   * The turns the tab has shown as ended. A turn shown as stopped because its stop was never
   * confirmed, or superseded by a new message, may have a worker still streaming: the text, calls
   * and approval cards it sends after that are not shown as in progress again (`ofLiveTurn`). Its
   * end is still read, since an end is safe to apply twice: for a turn that is not the tab's it
   * only finishes that turn's own message, and for no turn at all it changes nothing.
   */
  const endedTurnsRef = useRef<Set<string>>(new Set());
  const rememberEnded = (turnId: string | undefined) => {
    if (!turnId) return;
    const ended = endedTurnsRef.current;
    ended.add(turnId);
    // The last few are all that can still be sending.
    if (ended.size > ENDED_TURNS_REMEMBERED) ended.delete(ended.values().next().value as string);
  };
  /** The assistant message and running calls of a turn that ended by being stopped, as the panel shows them. */
  const markStopped = (prev: AgentMessage[], turnId: string, reason: TurnStoppedReason): AgentMessage[] => {
    const msgId = `msg_${turnId}`;
    const marked = prev.map((m) => {
      if (m.id === msgId) return { ...m, isStreaming: false, stopped: reason };
      if (m.toolCall?.status === 'running') return { ...m, toolCall: { ...m.toolCall, status: 'stopped' as const } };
      return m.isStreaming ? { ...m, isStreaming: false } : m;
    });
    // A turn stopped before it said anything still shows that it was stopped.
    return marked.some((m) => m.id === msgId)
      ? marked
      : [...marked, { id: msgId, role: 'assistant' as const, content: '', timestamp: Date.now(), stopped: reason }];
  };
  /** A stop is no longer waited on: its turn ended, or the tab moved on. */
  const clearStopping = () => {
    if (stoppingRef.current?.timer) clearTimeout(stoppingRef.current.timer);
    stoppingRef.current = null;
    setIsStopping(false);
  };
  /** Whether an end of turn `turnId` is the end of the turn the tab is running. */
  const endsLiveTurn = (turnId: string | undefined): boolean => {
    const live = liveTurnRef.current.turnId;
    return live === null || turnId === undefined || turnId === live;
  };

  // --- Protocol event handler ---
  const handleProtocolEvent = useCallback((event: AgentProtocolEvent) => {
    if ((event.type === 'done' || event.type === 'error') && liveTurnRef.current.starting) {
      // The tab's turn has no id yet: whose end this is cannot be told until it has.
      heldEndsRef.current.push(event);
      return;
    }
    addDebugLog('event', 'agent:protocol', `${event.type}`, event);
    configRef.current.onEvent?.(event);

    switch (event.type) {
      case 'token': {
        if (!event.content) break;
        // Text a superseded turn still sends is not the turn in progress's.
        if (!ofLiveTurn(event.turnId)) break;
        streamBufferRef.current += event.content;
        // Snapshot the accumulated content BEFORE enqueueing the state update.
        // React batches updates and runs the setMessages callback later; if the
        // 'done' event arrives and clears streamBufferRef.current before the
        // batch flushes, the deferred callback would otherwise read '' and wipe
        // the message. Capturing into a local makes the update self-contained.
        const snapshot = streamBufferRef.current;
        setMessages(prev => {
          const msgId = `msg_${event.turnId}`;
          const existingIdx = prev.findIndex(m => m.id === msgId);
          if (existingIdx !== -1) {
            // Update in place — never create a duplicate with the same id.
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx], content: snapshot, isStreaming: true };
            return updated;
          }
          // Defensive: drop any stale streaming messages for this turnId before adding a fresh one.
          const cleaned = prev.filter(m => m.id !== msgId);
          return [...cleaned, {
            id: msgId,
            role: 'assistant' as const,
            content: snapshot,
            timestamp: Date.now(),
            isStreaming: true,
          }];
        });
        break;
      }

      case 'token_clear':
        // A tool_use round ended. Preserve text from previous rounds so the
        // user sees the full multi-round response. Only truly clear if no text
        // has been accumulated yet (first round).
        if (streamBufferRef.current) {
          // Commit the current buffer as a completed round prefix.
          roundPrefixRef.current = streamBufferRef.current;
          // Add a separator — the next round's tokens will append after this.
          streamBufferRef.current = roundPrefixRef.current + '\n\n';
        }
        // Don't update message content — leave the existing text visible.
        break;

      case 'intent_call':
        if (!ofLiveTurn(event.turnId)) break;
        setMessages(prev => [...prev, {
          id: `tool_${event.id}`,
          role: 'tool' as const,
          content: null,
          timestamp: Date.now(),
          toolCall: { id: event.id, name: event.intentId, arguments: event.parameters, status: 'running' as const },
        }]);
        break;

      case 'intent_result':
        // Detect present_options tool results and surface them as interactive UI state.
        if (event.result && typeof event.result === 'object' && (event.result as Record<string, unknown>).__present_options) {
          const payload = event.result as Record<string, unknown>;
          setPresentedOptions({
            prompt: (payload.prompt as string) ?? '',
            options: (payload.options as PresentedOptions['options']) ?? [],
            style: (payload.style as string) ?? undefined,
          });
        }
        setMessages(prev => prev.map(m =>
          m.toolCall?.id === event.callId
            ? { ...m, toolCall: { ...m.toolCall!, status: event.success ? 'complete' as const : 'error' as const, result: event.result } }
            : m
        ));
        break;

      case 'approval_required': {
        // A card for a turn the person has moved on from is not shown: its approval is withdrawn.
        if (!ofLiveTurn(event.turnId)) break;
        // The card renders it; only the user's click on it decides.
        const { type: _type, ...request } = event;
        setPendingApproval(request);
        setApprovalError(null);
        setApprovalDeciding(false);
        break;
      }

      case 'done':
        if (!endsLiveTurn(event.turnId)) {
          // An earlier turn's completion, arriving after the next turn was started: that turn's own
          // message is finished, and nothing of the turn in progress is touched — not its streaming
          // state, its id, its room or its text.
          const earlier = `msg_${event.turnId}`;
          rememberEnded(event.turnId);
          setMessages(prev =>
            prev.map(m =>
              m.id === earlier ? { ...m, isStreaming: false, ...(event.stopReason ? { stopped: event.stopReason } : {}) } : m,
            ),
          );
          addDebugLog('info', 'agent:state', 'An earlier turn completed after the next one started; the turn in progress continues', {
            turnId: event.turnId,
          });
          break;
        }
        if (event.stopReason) {
          // The turn was stopped: what it had said stays, marked. Stopped by a message from another
          // window, the conversation has moved on without this tab, so it is read again.
          const reason = event.stopReason;
          const asked = stoppingRef.current?.turnId === event.turnId;
          rememberEnded(event.turnId);
          streamBufferRef.current = '';
          roundPrefixRef.current = '';
          setMessages(prev => markStopped(prev, event.turnId, reason));
          setIsStreaming(false);
          setCurrentTurnId(null);
          liveTurnRef.current = { starting: false, turnId: null };
          activeRoomRef.current = null;
          if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
          }
          clearStopping();
          setPendingApproval(null);
          addDebugLog('info', 'agent:state', `Turn stopped: ${reason}`, { turnId: event.turnId, reason });
          if (reason === 'superseded' && !asked) supersededElsewhereRef.current?.();
          break;
        }
        clearStopping();
        rememberEnded(event.turnId);
        // Finalize all streaming messages. Drop any assistant streaming bubble
        // that ended up truly empty (e.g. token_clear wiped it and no text was
        // re-emitted). Preserve tool messages (which legitimately have null content).
        streamBufferRef.current = '';
        roundPrefixRef.current = '';
        setMessages(prev => {
          const finalized = prev.map(m =>
            m.isStreaming ? { ...m, isStreaming: false } : m
          );
          return finalized.filter(m => {
            // Only drop assistant bubbles that are empty (null or empty string).
            // Tool messages have null content by design — keep them.
            // A stopped turn's message is kept even when it had said nothing: it says the turn was stopped.
            if (m.role === 'assistant' && (m.content === null || m.content === '') && !m.stopped) {
              return false;
            }
            return true;
          });
        });
        setIsStreaming(false);
        setCurrentTurnId(null);
        liveTurnRef.current = { starting: false, turnId: null };
        activeRoomRef.current = null;
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
        break;

      case 'error':
        if (!endsLiveTurn(event.turnId)) {
          // An earlier turn's failure, arriving after the next turn was started: it is said, and the
          // turn in progress goes on.
          const earlier = `msg_${event.turnId}`;
          setMessages(prev => [
            ...prev.map(m => (m.id === earlier && m.isStreaming ? { ...m, isStreaming: false } : m)),
            { id: `err_${Date.now()}`, role: 'assistant' as const, content: event.message || 'An error occurred.', timestamp: Date.now() },
          ]);
          break;
        }
        streamBufferRef.current = '';
        roundPrefixRef.current = '';
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.isStreaming) {
            return [...prev.slice(0, -1), { ...last, isStreaming: false, content: last.content || 'An error occurred.' }];
          }
          return [...prev, {
            id: `err_${Date.now()}`,
            role: 'assistant' as const,
            content: event.message || 'An error occurred.',
            timestamp: Date.now(),
          }];
        });
        setIsStreaming(false);
        setCurrentTurnId(null);
        liveTurnRef.current = { starting: false, turnId: null };
        activeRoomRef.current = null;
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
        clearStopping();
        break;
    }
  }, []);
  // Set once conversations can be loaded (below): what a turn superseded from another window does.
  const supersededElsewhereRef = useRef<(() => void) | null>(null);

  // --- Join a turn room ---
  // The realtime server requires a signed room token for a turn room and
  // denies the join without one — the socket stays connected, the
  // turn completes server-side, and no event ever arrives. Send the
  // token-bearing form when we have a token, and ACK the result so a denial
  // is visible instead of looking like the agent simply never replied.
  const joinRoom = useCallback((socket: SocketLike, room: string, roomToken?: string) => {
    if (roomToken) {
      socket.emit(
        'subscribe',
        { rooms: [room], tokens: { [room]: roomToken } },
        (res?: { ok: boolean; joined?: string[]; denied?: string[]; error?: string }) => {
          if (res && (!res.ok || res.denied?.includes(room))) {
            addDebugLog('error', 'agent:socket', `Room subscription DENIED: ${room}`, {
              room,
              denied: res.denied,
              error: res.error,
            });
          } else {
            addDebugLog('info', 'agent:socket', `Room joined: ${room}`, { room, joined: res?.joined });
          }
        },
      );
    } else {
      addDebugLog('warn', 'agent:socket', `Subscribing to ${room} WITHOUT a room token`, {
        room,
        hint: 'agent:* rooms require a signed token; the server will deny this join',
      });
      socket.emit('subscribe', [room]);
    }
  }, [addDebugLog]);

  // --- Subscribe to a socket room for agent events ---
  const subscribeToRoom = useCallback((room: string, turnId: string, roomToken?: string) => {
    const socket = socketRef.current;
    if (!socket) {
      addDebugLog('error', 'agent:socket', 'Cannot subscribe — no socket (realtime URL not configured)', { room });
      return () => {};
    }

    addDebugLog('info', 'agent:socket', `Subscribing to room: ${room}`, {
      room,
      turnId,
      hasRoomToken: !!roomToken,
      connected: socket.connected,
    });

    // Joined now if connected; otherwise on the next connect, which the
    // connect handler does for the active room.
    activeRoomRef.current = { room, token: roomToken };
    if (socket.connected) joinRoom(socket, room, roomToken);

    const handlers = new Map<string, (data: unknown) => void>();

    for (const eventName of ALL_AGENT_SOCKET_EVENTS) {
      const handler = (data: unknown) => {
        addDebugLog('socket', 'agent:socket', `← ${eventName}`, { eventName, data });
        const parsed = parseSocketEvent(eventName, data, turnId);
        if (parsed) handleProtocolEvent(parsed);
      };
      handlers.set(eventName, handler);
      socket.on(eventName, handler);
    }

    return () => {
      for (const [eventName, handler] of handlers) {
        socket.off(eventName, handler);
      }
      socket.emit('unsubscribe', [room]);
      addDebugLog('info', 'agent:socket', `Unsubscribed from room: ${room}`, { room });
    };
  }, [handleProtocolEvent, addDebugLog, joinRoom]);

  // Collect context from visible annotations and current route
  const collectContext = useCallback((): AgentMessageContext => {
    const annotations = annotationRegistry.getVisibleAnnotations();
    const timeZone = browserTimeZone();
    return {
      currentPath: typeof window !== 'undefined' ? window.location.pathname : undefined,
      visibleAnnotations: annotations,
      // The user's clock: the worker names today's date in this zone on every turn.
      ...(timeZone ? { timeZone } : {}),
    };
  }, []);

  // --- Start a turn: the user's message, or the continuation after an approval decision ---
  const startTurn = useCallback(async (content: string, attachments?: AttachmentRef[], approval?: ApprovalContinuation) => {
    // A message sent while a conversation loads belongs to that conversation.
    if (pendingLoadRef.current) await pendingLoadRef.current;
    // Read at once when there is one: the message goes out in the same tick it was sent.
    const convId = conversationIdRef.current ?? (await ensureConversation());

    // A click on the approval card continues the turn, but it is not a message.
    if (!approval) {
      const userMsg: AgentMessage = {
        id: `msg_user_${Date.now()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
        ...(attachments?.length ? { attachments } : {}),
      };
      setMessages(prev => [...prev, userMsg]);
      // A new message moves on: a card still waiting belongs to the previous turn.
      setPendingApproval(null);
    }
    // Any choice still on screen belongs to the previous turn.
    setPresentedOptions(null);
    // A message sent while a turn runs supersedes it (ADR-0252 §2.5): the platform stops that turn,
    // and here it is shown as stopped at once. Its room is left when the new turn's is joined, so
    // its own end may never arrive to say so.
    const superseded = approval ? null : liveTurnRef.current.turnId;
    if (superseded) {
      rememberEnded(superseded);
      setMessages(prev => markStopped(prev, superseded, 'superseded'));
      roundPrefixRef.current = '';
      clearStopping();
    }
    setIsStreaming(true);
    // From here the tab's turn is this one, though it has no id until the request returns: the end
    // of any earlier turn no longer ends it.
    const started = ++turnStartsRef.current;
    liveTurnRef.current = { starting: true, turnId: null };
    streamBufferRef.current = '';

    try {
      const context = collectContext();
      addDebugLog('info', 'agent:api', approval ? 'Continuing after an approval decision...' : 'Sending message...', {
        conversationId: convId,
        contentLength: content.length,
        context,
        ...(approval ? { approvalId: approval.approvalId, decision: approval.decision } : {}),
      });
      const { turnId, socketRoom, roomToken } = await configRef.current.sendMessage({
        conversationId: convId,
        content,
        context,
        ...(attachments?.length ? { attachments } : {}),
        ...(approval ? { approval } : {}),
      });

      addDebugLog('info', 'agent:api', `Turn started: ${turnId}`, {
        turnId,
        socketRoom,
        hasRoomToken: !!roomToken,
      });
      addDebugLog('info', 'agent:state', 'Streaming started', { turnId });
      setCurrentTurnId(turnId);
      if (turnStartsRef.current === started) {
        liveTurnRef.current = { starting: false, turnId };
        // The ends that arrived while this turn had no id: each is now this turn's, or an earlier one's.
        for (const held of heldEndsRef.current.splice(0)) handleProtocolEvent(held);
      }

      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      // A turn whose own end was among those held is over already: there is nothing left to listen for.
      if (liveTurnRef.current.turnId === turnId) {
        unsubscribeRef.current = subscribeToRoom(socketRoom, turnId, roomToken);
      }

      return { turnId };
    } catch (err) {
      addDebugLog('error', 'agent:api', `Send failed: ${err instanceof Error ? err.message : String(err)}`, { error: err });
      // Unless a later start has taken over, the tab has no turn now, and an end held meanwhile was
      // the earlier turn's.
      if (turnStartsRef.current === started) {
        liveTurnRef.current = { starting: false, turnId: null };
        for (const held of heldEndsRef.current.splice(0)) handleProtocolEvent(held);
        setIsStreaming(false);
      }
      setMessages(prev => [...prev, {
        id: `err_${Date.now()}`,
        role: 'assistant' as const,
        content: err instanceof Error ? err.message : 'Failed to send message.',
        timestamp: Date.now(),
      }]);
      return { turnId: '' };
    }
  }, [collectContext, subscribeToRoom, addDebugLog, ensureConversation, handleProtocolEvent]);

  // A message carries the composer's ready files, once the uploads still running have finished.
  // Nothing is sent when the files say not to: why, with the text, so the composer keeps the draft.
  const sendMessage = useCallback(
    (content: string, attachments?: AttachmentRef[]): Promise<SendMessageResult> => {
      if (attachments) return startTurn(content, attachments);
      const go = (taken: TakeForSend): Promise<SendMessageResult> | SendMessageResult => {
        if ('refs' in taken) return startTurn(content, taken.refs);
        addDebugLog('info', 'agent:api', `The message was not sent: ${taken.notSent}`, { reason: taken.notSent });
        return { turnId: '', notSent: { reason: taken.notSent, content } };
      };
      const taken = takeForSend();
      return 'then' in taken ? taken.then(go) : Promise.resolve(go(taken));
    },
    [startTurn, takeForSend, addDebugLog],
  );

  // --- The person's Stop (ADR-0252 §2.14) ---
  // Asked over the socket, from the turn's room: the server takes it only from there. The turn's
  // worker hears it, stores what it had, and sends the turn's end with why. If the socket cannot
  // ask, or the end has not arrived in time, the platform's API is asked instead and the turn is
  // shown as stopped: the person pressed Stop, and the panel must not go on saying "working".
  const stopTurn = useCallback(async () => {
    // A send still waiting for its files is given up: nothing was sent, and the draft is kept.
    cancelWaitingSendRef.current();
    const turnId = liveTurnRef.current.turnId;
    if (!turnId || stoppingRef.current) return;
    const entry: { turnId: string; timer: ReturnType<typeof setTimeout> | null } = { turnId, timer: null };
    stoppingRef.current = entry;
    setIsStopping(true);
    addDebugLog('info', 'agent:api', 'Stopping the turn', { turnId });

    let askedThroughApi = false;
    const askApi = async () => {
      const stop = configRef.current.stopTurn;
      if (!stop || askedThroughApi) return;
      askedThroughApi = true;
      try {
        await stop({ turnId, conversationId: conversationIdRef.current });
      } catch (err) {
        addDebugLog('warn', 'agent:api', `The API could not be asked to stop the turn: ${reasonOf(err)}`, { turnId });
      }
    };
    const stillWaiting = () => stoppingRef.current === entry;

    // Not confirmed in time: ask the API (once), and show the turn as stopped.
    entry.timer = setTimeout(() => {
      void (async () => {
        if (!stillWaiting()) return;
        await askApi();
        if (!stillWaiting()) return;
        addDebugLog('warn', 'agent:state', 'The stop was not confirmed in time; the turn is shown as stopped', { turnId });
        handleProtocolEvent({ type: 'done', turnId, stopReason: 'user_stop' });
      })();
    }, STOP_CONFIRM_TIMEOUT_MS);

    const socket = socketRef.current;
    const room = activeRoomRef.current?.room;
    const answer: TurnStopResult =
      socket?.connected && room
        ? await new Promise<TurnStopResult>(resolve => {
            const timer = setTimeout(() => resolve({ ok: false, reason: 'unavailable' }), STOP_ACK_TIMEOUT_MS);
            socket.emit(TURN_STOP_EVENT, { turnId, room } satisfies TurnStopPayload, (result: TurnStopResult) => {
              clearTimeout(timer);
              resolve(result && typeof result === 'object' && 'ok' in result ? result : { ok: false, reason: 'unavailable' });
            });
          })
        : { ok: false, reason: 'unavailable' };
    if (!answer.ok) {
      // The socket could not ask (not connected, or a realtime server from before the event).
      addDebugLog('warn', 'agent:socket', `The stop could not be asked over the socket: ${answer.reason}`, { turnId });
      if (stillWaiting()) await askApi();
    }
  }, [addDebugLog, handleProtocolEvent]);

  /** The turn whose UI requests the tab runs now: none while starting, none once a stop is asked. */
  const acceptedTurnId = useCallback((): string | null => {
    const { starting, turnId } = liveTurnRef.current;
    if (starting || !turnId) return null;
    return stoppingRef.current?.turnId === turnId ? null : turnId;
  }, []);

  // --- The user's decision on an approval card (ADR-0228 §2.2.3) ---
  // Only the card calls this: it is not on the context `useAgent` returns, so
  // nothing an app binds for the assistant can reach it.
  const pendingApprovalRef = useRef<AgentApprovalRequest | null>(null);
  pendingApprovalRef.current = pendingApproval;
  const decideApproval = useCallback(async (decision: ApprovalDecision) => {
    const request = pendingApprovalRef.current;
    const socket = socketRef.current;
    if (!request) return;
    if (!socket) {
      setApprovalError('Not connected: try again once the assistant reconnects.');
      return;
    }
    setApprovalDeciding(true);
    setApprovalError(null);
    addDebugLog('info', 'agent:api', `Approval ${decision}`, { approvalId: request.approvalId, tool: request.tool });
    const result = await new Promise<ApprovalDecideResult>(resolve => {
      const timer = setTimeout(
        () => resolve({ ok: false, reason: 'invalid', error: 'the server did not answer' }),
        APPROVAL_DECIDE_TIMEOUT_MS,
      );
      socket.emit(APPROVAL_DECIDE_EVENT, { approvalId: request.approvalId, decision }, (answer: ApprovalDecideResult) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
    if (!result.ok) {
      addDebugLog('warn', 'agent:api', `Approval refused: ${result.reason}`, { approvalId: request.approvalId, reason: result.reason });
      setApprovalError(approvalRefusalText(result));
      setApprovalDeciding(false);
      return;
    }
    // The grant goes to this tab's OUI runtime before the turn that dispatches the call starts.
    if (result.decision === 'approve') {
      configRef.current.grantApproval?.({ approvalId: result.approvalId, argsHash: result.argsHash, expiresAt: result.expiresAt });
    }
    setPendingApproval(null);
    setApprovalDeciding(false);
    await startTurn(
      '',
      undefined,
      result.decision === 'approve'
        ? { approvalId: result.approvalId, decision: 'approve', token: result.token }
        : { approvalId: result.approvalId, decision: 'decline' },
    );
  }, [startTurn, addDebugLog]);

  const dismissApproval = useCallback(() => {
    setPendingApproval(null);
    setApprovalError(null);
    setApprovalDeciding(false);
  }, []);

  // --- Conversation history ---

  /** Stop listening to the turn in progress, if any. */
  const leaveTurn = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    activeRoomRef.current = null;
    streamBufferRef.current = '';
    roundPrefixRef.current = '';
    setCurrentTurnId(null);
    // No turn is the tab's now; a start still in flight is no longer waited on.
    turnStartsRef.current += 1;
    liveTurnRef.current = { starting: false, turnId: null };
    heldEndsRef.current = [];
    clearStopping();
  }, []);

  /**
   * Show a stored conversation. The latest request wins: a load that finishes
   * after another began is discarded. A restore that fails (the conversation
   * was deleted, or belongs to someone else) forgets it and starts fresh.
   */
  const loadConversation = useCallback((id: string, { restoring }: { restoring: boolean }) => {
    const getConversation = configRef.current.getConversation;
    if (!getConversation) return Promise.resolve();
    const seq = ++loadSeqRef.current;
    setIsLoadingConversation(true);
    addDebugLog('info', 'agent:api', `${restoring ? 'Restoring' : 'Loading'} conversation ${id}`, { conversationId: id });
    const load = (async () => {
      try {
        const stored = await getConversation(id);
        if (seq !== loadSeqRef.current) return;
        setActiveConversation(stored.conversationId);
        setMessages(storedToAgentMessages(stored.messages));
        setPresentedOptions(null);
        setPendingApproval(null);
        setHistoryError(null);
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        addDebugLog('warn', 'agent:api', `Could not load conversation ${id}: ${message}`, { conversationId: id });
        if (restoring) {
          setActiveConversation(null);
        } else {
          setHistoryError('That conversation could not be opened.');
        }
      } finally {
        if (seq === loadSeqRef.current) {
          setIsLoadingConversation(false);
          pendingLoadRef.current = null;
        }
      }
    })();
    pendingLoadRef.current = load;
    return load;
  }, [addDebugLog, setActiveConversation]);

  // A turn of this tab superseded by a message sent from another window: the conversation has
  // moved on there, so it is read again here.
  supersededElsewhereRef.current = () => {
    const id = conversationIdRef.current;
    if (id) void loadConversation(id, { restoring: false });
  };

  // Return to the tab's conversation after a reload.
  useEffect(() => {
    const remembered = readRemembered(sessionKeyOf(configRef.current));
    if (remembered) void loadConversation(remembered, { restoring: true });
  }, [loadConversation]);

  const refreshHistory = useCallback(async (filter?: AgentConversationFilter) => {
    const listConversations = configRef.current.listConversations;
    if (!listConversations) return;
    if (filter) {
      historyFilterRef.current = filter;
      setHistoryFilter(filter);
    }
    const asked = historyFilterRef.current;
    setHistoryLoading(true);
    try {
      const page = await listConversations({ limit: HISTORY_PAGE_SIZE, offset: 0, ...asked });
      // A refresh with another filter started since: its answer wins.
      if (asked !== historyFilterRef.current) return;
      historyConversationsRef.current = page.conversations;
      setHistoryConversations(page.conversations);
      setHistoryTotal(page.total);
      setHistoryError(null);
    } catch (err) {
      addDebugLog('warn', 'agent:api', `Could not list conversations: ${reasonOf(err)}`);
      setHistoryError('Your conversations could not be loaded.');
    } finally {
      setHistoryLoading(false);
    }
  }, [addDebugLog]);

  const queryConversations = useCallback(
    async (params: { limit: number; offset: number } & AgentConversationFilter) => {
      const listConversations = configRef.current.listConversations;
      if (!listConversations) throw new Error('This app cannot list conversations.');
      return listConversations(params);
    },
    [],
  );

  /** Replace the listed conversations after a change, and count the change. */
  const setListed = useCallback((next: AgentConversationSummary[]) => {
    const dropped = historyConversationsRef.current.length - next.length;
    historyConversationsRef.current = next;
    setHistoryConversations(next);
    if (dropped > 0) setHistoryTotal(total => Math.max(0, total - dropped));
    setHistoryRevision(r => r + 1);
  }, []);

  /** Put changed conversations into the listed ones, dropping those the filter no longer lets in. */
  const applyToHistory = useCallback((changed: AgentConversationSummary[]) => {
    const byId = new Map(changed.map(c => [c.conversationId, c]));
    const filter = historyFilterRef.current;
    setListed(historyConversationsRef.current.flatMap(c => {
      const updated = byId.get(c.conversationId);
      if (!updated) return [c];
      return passesFilter(updated, filter) ? [updated] : [];
    }));
  }, [setListed]);

  const renameConversation = useCallback(async (id: string, title: string | null) => {
    const rename = configRef.current.renameConversation;
    if (!rename) throw new Error('This app cannot rename conversations.');
    addDebugLog('info', 'agent:api', `Renaming conversation ${id}`, { conversationId: id, automatic: title === null });
    const updated = await rename(id, title);
    applyToHistory([updated]);
    return updated;
  }, [addDebugLog, applyToHistory]);

  const updateConversations = useCallback(async (ids: string[], changes: AgentConversationChanges) => {
    const update = configRef.current.updateConversations;
    if (!update) throw new Error('This app cannot file or archive conversations.');
    addDebugLog('info', 'agent:api', `Updating ${ids.length} conversation(s)`, { conversationIds: ids, changes });
    const updated = await update(ids, changes);
    applyToHistory(updated);
    return updated;
  }, [addDebugLog, applyToHistory]);

    const switchConversation = useCallback(async (id: string) => {
    if (isStreaming || id === conversationIdRef.current) return;
    leaveTurn();
    // Files on an unsent message belong to the conversation being left.
    clearComposer();
    await loadConversation(id, { restoring: false });
  }, [isStreaming, leaveTurn, loadConversation, clearComposer]);

  /** Leave the open conversation for a new one. Callers check that no turn is answering. */
  const resetToNewConversation = useCallback(() => {
    loadSeqRef.current++;
    pendingLoadRef.current = null;
    setIsLoadingConversation(false);
    leaveTurn();
    setActiveConversation(null);
    setMessages([]);
    clearComposer();
    setPresentedOptions(null);
    setPendingApproval(null);
    addDebugLog('info', 'agent:state', 'New conversation');
  }, [leaveTurn, setActiveConversation, addDebugLog, clearComposer]);

  const startNewConversation = useCallback(() => {
    if (isStreaming) return;
    resetToNewConversation();
  }, [isStreaming, resetToNewConversation]);

  const removeConversations = useCallback(async (ids: string[]) => {
    const remove = configRef.current.deleteConversations;
    if (!remove) throw new Error('This app cannot delete conversations.');
    const open = conversationIdRef.current;
    const removingOpen = open !== null && ids.includes(open);
    if (removingOpen && isStreamingRef.current) {
      throw new Error('That conversation is answering. Wait for it to finish, then delete it.');
    }
    addDebugLog('info', 'agent:api', `Deleting ${ids.length} conversation(s)`, { conversationIds: ids });
    await remove(ids);
    const gone = new Set(ids);
    setListed(historyConversationsRef.current.filter(c => !gone.has(c.conversationId)));
    if (removingOpen && conversationIdRef.current === open) resetToNewConversation();
  }, [addDebugLog, resetToNewConversation, setListed]);

  const sessionRecord = useCallback(() => {
    return {
      exportedAt: new Date().toISOString(),
      sdk: SDK_PACKAGE,
      sdkVersion: SDK_VERSION,
      session: {
        conversationId,
        currentTurnId,
        connected,
        isStreaming,
        messageCount: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp).toISOString(),
          isStreaming: m.isStreaming,
          toolCall: m.toolCall,
        })),
      },
      debug: {
        enabled: debugEnabled,
        logCount: debugLogs.length,
        logs: debugLogs,
      },
      environment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        url: typeof window !== 'undefined' ? window.location.href : 'unknown',
        realtimeUrl: config.realtime.url,
      },
    };
  }, [conversationId, currentTurnId, connected, isStreaming, messages, debugEnabled, debugLogs, config.realtime.url]);

  const exportSession = useCallback(() => {
    const blob = new Blob([JSON.stringify(sessionRecord(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `agent-session-${conversationId ?? 'no-conv'}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [conversationId, sessionRecord]);

  const debugState: AgentDebugState = {
    enabled: debugEnabled,
    setEnabled: setDebugEnabled,
    logs: debugLogs,
    clearLogs: clearDebugLogs,
    namespaces: ALL_DEBUG_NAMESPACES,
    sessionRecord,
    exportSession,
  };

  const selectOption = useCallback((value: string) => {
    setPresentedOptions(null);
    sendMessage(value);
  }, [sendMessage]);

  const dismissOptions = useCallback(() => {
    setPresentedOptions(null);
  }, []);

  const contextValue: AgentContextValue = {
    isOpen,
    toggle: useCallback(() => setIsOpen(p => !p), []),
    open: useCallback(() => setIsOpen(true), []),
    close: useCallback(() => setIsOpen(false), []),
    sendMessage,
    attachments: composerState,
    stopTurn,
    isStopping,
    acceptedTurnId,
    messages,
    isStreaming,
    isProcessing: isStreaming,
    currentTurnId,
    conversationId,
    connected,
    debug: debugState,
    presentedOptions,
    selectOption,
    dismissOptions,
    pendingApproval,
    socket: socketRef.current,
    history: {
      available: Boolean(config.listConversations && config.getConversation),
      manage: {
        rename: Boolean(config.renameConversation),
        update: Boolean(config.updateConversations),
        remove: Boolean(config.deleteConversations),
      },
      conversations: historyConversations,
      total: historyTotal,
      filter: historyFilter,
      loading: historyLoading,
      error: historyError,
      refresh: refreshHistory,
      query: queryConversations,
      rename: renameConversation,
      update: updateConversations,
      remove: removeConversations,
      revision: historyRevision,
    },
    isLoadingConversation,
    switchConversation,
    startNewConversation,
  };

  const approvalDecision: ApprovalDecisionState = {
    pending: pendingApproval,
    deciding: approvalDeciding,
    error: approvalError,
    decide: decideApproval,
    dismiss: dismissApproval,
  };

  return React.createElement(
    AgentContext.Provider,
    { value: contextValue },
    React.createElement(ApprovalDecisionContext.Provider, { value: approvalDecision }, children),
  );
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within an AgentProvider');
  return ctx;
}
