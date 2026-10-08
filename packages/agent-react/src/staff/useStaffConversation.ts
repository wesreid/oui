/**
 * The staff console's side of a conversation (ADR-0260 §2.7): read it, follow
 * it live, take it over from the agent, write to the customer as yourself,
 * and hand it back.
 *
 * Used inside an `AgentProvider`, whose socket it shares. Every change goes
 * through the platform's own routes (`config.staff`), which check the staff
 * member's permission and store it; the realtime server keeps the hold and
 * tells the conversation's room. The SDK decides no permission itself.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  CONVERSATION_EVENTS,
  readConversationHold,
  readConversationMessage,
  readStaffSpeaker,
  type ConversationHold,
  type StaffSpeaker,
  type TakeoverChange,
} from '@ouispec/agent-core';
import { AgentInternalsContext } from '../provider/internals.js';
import { storedToAgentMessages } from '../provider/stored-messages.js';
import { conversationChangeMessage, staffAgentMessage } from '../provider/conversation-messages.js';
import type { AgentMessage } from '../provider/types.js';

export interface StaffConversationState {
  /** Every message of the conversation, the customer's, the agent's and the staff's, live. */
  messages: AgentMessage[];
  /** Who holds it now; null while the agent answers it. */
  hold: ConversationHold | null;
  /** True when the person viewing holds it, and may write to the customer. */
  heldByMe: boolean;
  /** The person viewing, as they would hold it; null until the conversation has loaded. */
  self: StaffSpeaker | null;
  loading: boolean;
  /** Why the last load or change failed, in the platform's words; null when it did not. */
  error: string | null;
  /** True while a take-over, a hand-back or a message is on its way. */
  busy: boolean;
  /** Take the conversation from the agent. Resolves once the platform holds it for this person. */
  takeOver(): Promise<void>;
  /** Give it back to the agent. */
  handBack(): Promise<void>;
  /** Write to the customer as this person. Only while they hold it. */
  send(content: string): Promise<void>;
  /** Read the conversation again from the platform. */
  reload(): Promise<void>;
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Appends what is not there yet, in time order: the platform's answer and the room's event are one message. */
function merge(existing: AgentMessage[], added: AgentMessage[]): AgentMessage[] {
  const ids = new Set(existing.map((m) => m.id));
  const fresh = added.filter((m) => !ids.has(m.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
}

export function useStaffConversation(conversationId: string | null): StaffConversationState {
  const internals = useContext(AgentInternalsContext);
  if (!internals) throw new Error('useStaffConversation must be used within an AgentProvider');
  const { connected } = internals;
  const internalsRef = useRef(internals);
  internalsRef.current = internals;

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [hold, setHold] = useState<ConversationHold | null>(null);
  const [self, setSelf] = useState<StaffSpeaker | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef<string | null>(conversationId);
  openRef.current = conversationId;

  const seam = () => {
    const staff = internalsRef.current.config().staff;
    if (!staff) throw new Error('This app has no staff console: give AgentProvider a `staff` seam.');
    return staff;
  };

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const conversation = await seam().getConversation(conversationId);
      if (openRef.current !== conversationId) return;
      setMessages(storedToAgentMessages(conversation.messages));
      setHold(conversation.hold ? readConversationHold(conversation.hold) : null);
      setSelf(readStaffSpeaker(conversation.self));
      setError(null);
    } catch (err) {
      if (openRef.current === conversationId) setError(reasonOf(err));
    } finally {
      if (openRef.current === conversationId) setLoading(false);
    }
  }, [conversationId]);

  // A new conversation starts empty, then loads.
  useEffect(() => {
    setMessages([]);
    setHold(null);
    setError(null);
    void load();
  }, [load]);

  // Follow it live in its room: joined now and on every reconnect, left when the console moves on.
  const roomRef = useRef<{ room: string; token?: string } | null>(null);
  useEffect(() => {
    const { config, log } = internalsRef.current;
    const roomOf = config().conversationRoom;
    if (!conversationId || !roomOf) return;
    let cancelled = false;
    void roomOf(conversationId).then(
      ({ room, roomToken }) => {
        if (cancelled) return;
        roomRef.current = { room, ...(roomToken ? { token: roomToken } : {}) };
        const socket = internalsRef.current.socket();
        if (socket?.connected) internalsRef.current.joinRoom(socket, room, roomToken);
      },
      (err: unknown) => log('warn', 'agent:api', `The conversation's room could not be had: ${reasonOf(err)}`, { conversationId }),
    );
    return () => {
      cancelled = true;
      const followed = roomRef.current;
      roomRef.current = null;
      if (followed) internalsRef.current.socket()?.emit('unsubscribe', [followed.room]);
    };
  }, [conversationId]);

  useEffect(() => {
    const socket = internalsRef.current.socket();
    const followed = roomRef.current;
    if (connected && socket && followed) internalsRef.current.joinRoom(socket, followed.room, followed.token);
  }, [connected]);

  useEffect(() => {
    const socket = internalsRef.current.socket();
    if (!socket || !conversationId) return;
    const listeners = Object.values(CONVERSATION_EVENTS).map((event) => {
      const listener = (data: unknown) => {
        const payload = (data ?? {}) as Record<string, unknown>;
        if (payload.conversationId !== conversationId) return;
        if (event === CONVERSATION_EVENTS.MESSAGE) {
          const message = readConversationMessage(payload.message);
          if (message) setMessages((prev) => merge(prev, [staffAgentMessage(message)]));
          return;
        }
        const changed = readConversationHold(payload.hold);
        if (!changed) return;
        const change: TakeoverChange = event === CONVERSATION_EVENTS.TAKEN_OVER ? 'taken_over' : 'handed_back';
        setHold(change === 'taken_over' ? changed : null);
        setMessages((prev) => merge(prev, [conversationChangeMessage(change, changed, typeof payload.at === 'number' ? payload.at : Date.now())]));
      };
      socket.on(event, listener);
      return [event, listener] as const;
    });
    return () => {
      for (const [event, listener] of listeners) socket.off(event, listener);
    };
  }, [conversationId, connected]);

  const run = useCallback(async (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError(reasonOf(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const takeOver = useCallback(
    () =>
      run(async () => {
        if (!conversationId) return;
        const held = readConversationHold(await seam().takeOver(conversationId));
        if (held && openRef.current === conversationId) {
          setHold(held);
          setMessages((prev) => merge(prev, [conversationChangeMessage('taken_over', held, held.since)]));
        }
      }),
    [conversationId, run],
  );

  const handBack = useCallback(
    () =>
      run(async () => {
        if (!conversationId) return;
        await seam().handBack(conversationId);
        if (openRef.current === conversationId) setHold(null);
      }),
    [conversationId, run],
  );

  const send = useCallback(
    (content: string) =>
      run(async () => {
        const text = content.trim();
        if (!conversationId || !text) return;
        const stored = await seam().sendMessage({ conversationId, content: text });
        if (openRef.current !== conversationId) return;
        setMessages((prev) => merge(prev, storedToAgentMessages([stored])));
      }),
    [conversationId, run],
  );

  return {
    messages,
    hold,
    heldByMe: !!hold && !!self && hold.holder.userId === self.userId,
    self,
    loading,
    error,
    busy,
    takeOver,
    handBack,
    send,
    reload: load,
  };
}
