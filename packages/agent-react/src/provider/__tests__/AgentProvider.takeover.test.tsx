// @vitest-environment jsdom
/**
 * The customer's view of a conversation a person on the staff takes over
 * (ADR-0260 §2.7): it follows the conversation's room, shows who is
 * answering, shows the person's messages under their name, and keeps the
 * customer typing; a turn the worker declines while the conversation is held
 * adds nothing, and the hand-back returns the conversation to the agent. A
 * restored conversation shows the same.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_EVENTS,
  type AgentClientConfig,
  type AgentStoredConversation,
  type ConversationHold,
  type StaffSpeaker,
} from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from './fake-socket.js';

vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('Socket.IO must not be used when the host supplies createSocket');
  },
}));

const { AgentProvider, useAgent } = await import('../AgentProvider.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}
afterEach(() => cleanup());

const jordan: StaffSpeaker = { userId: 'staff-17', displayName: 'Jordan', role: 'Toyota of Quillhaven sales' };
const hold: ConversationHold = { conversationId: 'conv-1', holder: jordan, since: 1_791_000_000_000 };
const ROOM = 'deos:conversation:conv-1';

function mount(options: { getConversation?: AgentClientConfig['getConversation']; remembered?: string } = {}) {
  let socket!: FakeSocket;
  let turns = 0;
  const sendMessage = vi.fn(async () => {
    turns += 1;
    return { turnId: `turn-${turns}`, socketRoom: `agent:turn:turn-${turns}`, roomToken: `tok-${turns}` };
  });
  const conversationRoom = vi.fn(async (conversationId: string) => ({ room: `deos:conversation:${conversationId}`, roomToken: `room-tok-${conversationId}` }));
  if (options.remembered) window.sessionStorage.setItem('agent-sdk.activeConversation', options.remembered);
  else window.sessionStorage.clear();
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage,
    conversationRoom,
    ...(options.getConversation ? { getConversation: options.getConversation } : {}),
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'visitor-session',
      createSocket: () => (socket = createFakeSocket()),
    },
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
  return { socket: () => socket, sendMessage, conversationRoom };
}

const joins = (socket: FakeSocket) =>
  socket.emitted.filter((e) => e.event === 'subscribe').map((e) => e.args[0] as { rooms: string[]; tokens: Record<string, string> });
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

describe('the customer’s view of a take-over', () => {
  it('follows its conversation’s room, shows who answers and the person’s messages, and the hand-back', async () => {
    const mounted = mount();
    await act(async () => {
      await agent.sendMessage('Can I get a discount on T2417?');
    });
    await settle();
    const socket = mounted.socket();
    expect(mounted.conversationRoom).toHaveBeenCalledWith('conv-1');
    expect(joins(socket)).toContainEqual({ rooms: [ROOM], tokens: { [ROOM]: 'room-tok-conv-1' } });
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-1', text: "I'll get someone from sales." });
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });

    act(() => socket.fire(CONVERSATION_EVENTS.TAKEN_OVER, { conversationId: 'conv-1', hold, at: hold.since }));
    expect(agent.hold).toEqual(hold);
    const message = { id: 'm-9', role: 'staff', content: 'Jordan here: $500 off today.', createdAt: '2026-10-08T15:00:00.000Z', speaker: jordan };
    act(() => {
      socket.fire(CONVERSATION_EVENTS.MESSAGE, { conversationId: 'conv-1', message, at: 2 });
      // The same message again, the customer's own echoed for the staff, and another conversation's: none adds anything.
      socket.fire(CONVERSATION_EVENTS.MESSAGE, { conversationId: 'conv-1', message, at: 3 });
      socket.fire(CONVERSATION_EVENTS.MESSAGE, {
        conversationId: 'conv-1',
        message: { id: 'm-1', role: 'user', content: 'Can I get a discount on T2417?', createdAt: '2026-10-08T14:59:00.000Z' },
        at: 4,
      });
      socket.fire(CONVERSATION_EVENTS.MESSAGE, { conversationId: 'conv-other', message: { ...message, id: 'm-other' }, at: 5 });
    });
    const staff = agent.messages.filter((m) => m.role === 'staff');
    expect(staff).toEqual([
      expect.objectContaining({ role: 'staff', content: null, takeover: 'taken_over', speaker: jordan }),
      expect.objectContaining({ id: 'm-9', role: 'staff', content: 'Jordan here: $500 off today.', speaker: jordan }),
    ]);

    // The customer keeps typing; the turn the worker declines while Jordan holds it is not the agent answering, and adds nothing.
    await act(async () => {
      await agent.sendMessage('Great, thanks Jordan');
    });
    expect(agent.isProcessing).toBe(false);
    act(() => socket.fire('agent:turn_complete', { turnId: 'turn-2', stopReason: 'taken_over' }));
    expect(agent.isStreaming).toBe(false);
    expect(agent.messages.filter((m) => m.role === 'assistant')).toEqual([expect.objectContaining({ content: "I'll get someone from sales." })]);

    act(() => socket.fire(CONVERSATION_EVENTS.HANDED_BACK, { conversationId: 'conv-1', hold, by: 'holder', at: hold.since + 60_000 }));
    expect(agent.hold).toBeNull();
    expect(agent.messages.at(-1)).toMatchObject({ role: 'staff', takeover: 'handed_back', speaker: jordan });

    // A reconnect rejoins the conversation's room, as it does a turn's.
    const before = joins(socket).length;
    act(() => {
      socket.connected = false;
      socket.connect();
    });
    expect(joins(socket).slice(before)).toContainEqual({ rooms: [ROOM], tokens: { [ROOM]: 'room-tok-conv-1' } });
  });

  it('marks a turn the take-over cut short, and withdraws a card the person now answering did not ask for', async () => {
    const mounted = mount();
    await act(async () => {
      await agent.sendMessage('Book me Saturday');
    });
    const socket = mounted.socket();
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-1', text: 'Let me check Saturday' });
      socket.fire('agent:approval_required', {
        turnId: 'turn-1',
        conversationId: 'conv-1',
        approvalId: 'call-1',
        tool: 'book_service',
        effect: 'transaction',
        destructive: false,
        preview: { title: 'Book a service visit', arguments: [], readback: 'Book a service visit.' },
        expiresAt: Date.now() + 60_000,
        timestamp: Date.now(),
      });
    });
    expect(agent.pendingApproval).not.toBeNull();
    act(() => socket.fire(CONVERSATION_EVENTS.TAKEN_OVER, { conversationId: 'conv-1', hold, at: 1 }));
    expect(agent.pendingApproval).toBeNull();
    act(() => socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'taken_over' }));
    expect(agent.messages.find((m) => m.role === 'assistant')).toMatchObject({ content: 'Let me check Saturday', stopped: 'taken_over' });
  });

  it('a restored conversation shows who holds it and the person’s messages and entries, from what the platform stored', async () => {
    const stored: AgentStoredConversation = {
      conversationId: 'conv-1',
      title: null,
      hold,
      messages: [
        { id: 's-1', role: 'user', content: 'Can I get a discount?', createdAt: '2026-10-08T14:59:00.000Z' },
        { id: 's-2', role: 'staff', content: null, takeover: 'taken_over', speaker: jordan, createdAt: '2026-10-08T15:00:00.000Z' },
        { id: 's-3', role: 'staff', content: 'Jordan here: $500 off.', speaker: jordan, createdAt: '2026-10-08T15:00:01.000Z' },
        // An entry that names no one is not shown.
        { id: 's-4', role: 'staff', content: 'nobody', createdAt: '2026-10-08T15:00:02.000Z' },
      ],
    };
    mount({ getConversation: async () => stored, remembered: 'conv-1' });
    await settle();
    expect(agent.conversationId).toBe('conv-1');
    expect(agent.hold).toEqual(hold);
    expect(agent.messages.map((m) => [m.role, m.content, m.takeover ?? null, m.speaker?.displayName ?? null])).toEqual([
      ['user', 'Can I get a discount?', null, null],
      ['staff', null, 'taken_over', 'Jordan'],
      ['staff', 'Jordan here: $500 off.', null, 'Jordan'],
    ]);
  });
});
