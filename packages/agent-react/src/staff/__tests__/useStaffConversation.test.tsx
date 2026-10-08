// @vitest-environment jsdom
/**
 * The staff console (ADR-0260 §2.7): it reads the conversation through the
 * platform, follows it live in its room, takes it over, writes to the
 * customer as the person, and hands it back. Every change goes through the
 * platform's routes; the hook decides no permission itself.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_EVENTS,
  type AgentClientConfig,
  type AgentStoredMessage,
  type ConversationHold,
  type StaffConsoleSeam,
  type StaffSpeaker,
} from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from '../../provider/__tests__/fake-socket.js';

vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('Socket.IO must not be used when the host supplies createSocket');
  },
}));

const { AgentProvider } = await import('../../provider/AgentProvider.js');
const { useStaffConversation } = await import('../useStaffConversation.js');

const jordan: StaffSpeaker = { userId: 'staff-17', displayName: 'Jordan', role: 'Toyota of Quillhaven sales' };
const casey: StaffSpeaker = { userId: 'staff-23', displayName: 'Casey', role: 'Service' };
const ROOM = 'deos:conversation:conv-1';

let staff: ReturnType<typeof useStaffConversation>;
function Console({ conversationId }: { conversationId: string }) {
  staff = useStaffConversation(conversationId);
  return null;
}
afterEach(() => cleanup());

function mount(seam: Partial<StaffConsoleSeam> = {}) {
  let socket!: FakeSocket;
  const stored: AgentStoredMessage[] = [
    { id: 'm-1', role: 'user', content: 'Can I get a discount on T2417?', createdAt: '2026-10-08T14:59:00.000Z' },
    { id: 'm-2', role: 'assistant', content: "I'll get someone from sales.", createdAt: '2026-10-08T14:59:01.000Z' },
  ];
  let held: ConversationHold | null = null;
  const calls: string[] = [];
  const staffSeam: StaffConsoleSeam = {
    getConversation: async (conversationId) => ({ conversationId, title: null, messages: stored, hold: held, self: jordan }),
    takeOver: async (conversationId) => {
      calls.push(`takeOver ${conversationId}`);
      held = { conversationId, holder: jordan, since: 1_791_000_000_000 };
      return held;
    },
    handBack: async (conversationId) => {
      calls.push(`handBack ${conversationId}`);
      held = null;
    },
    sendMessage: async ({ conversationId, content }) => {
      calls.push(`send ${conversationId} ${content}`);
      return { id: 'm-staff-1', role: 'staff', content, speaker: jordan, createdAt: '2026-10-08T15:00:05.000Z' };
    },
    ...seam,
  };
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'unused' }),
    sendMessage: async () => ({ turnId: 't', socketRoom: 'r' }),
    conversationRoom: async (conversationId) => ({ room: `deos:conversation:${conversationId}`, roomToken: 'staff-room-token' }),
    staff: staffSeam,
    realtime: { url: 'wss://rt.example', getToken: () => 'staff-session', createSocket: () => (socket = createFakeSocket()) },
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Console, { conversationId: 'conv-1' })));
  return { socket: () => socket, calls };
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe('useStaffConversation', () => {
  it('reads the conversation, follows it live, takes it over, writes as the person, and hands it back', async () => {
    const mounted = mount();
    await settle();
    const socket = mounted.socket();
    expect(staff.loading).toBe(false);
    expect(staff.self).toEqual(jordan);
    expect(staff.hold).toBeNull();
    expect(staff.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(socket.emitted.filter((e) => e.event === 'subscribe').map((e) => e.args[0])).toContainEqual({
      rooms: [ROOM],
      tokens: { [ROOM]: 'staff-room-token' },
    });

    // The customer writes while the agent answers: the console sees it.
    act(() =>
      socket.fire(CONVERSATION_EVENTS.MESSAGE, {
        conversationId: 'conv-1',
        message: { id: 'm-3', role: 'user', content: 'Hello?', createdAt: '2026-10-08T14:59:30.000Z' },
        at: 1,
      }),
    );
    expect(staff.messages.at(-1)).toMatchObject({ id: 'm-3', role: 'user', content: 'Hello?' });

    await act(async () => {
      await staff.takeOver();
    });
    expect(mounted.calls).toEqual(['takeOver conv-1']);
    expect(staff.hold?.holder).toEqual(jordan);
    expect(staff.heldByMe).toBe(true);
    // The room's own announcement of it is the same change: shown once.
    act(() => socket.fire(CONVERSATION_EVENTS.TAKEN_OVER, { conversationId: 'conv-1', hold: staff.hold, at: 1_791_000_000_000 }));
    expect(staff.messages.filter((m) => m.takeover === 'taken_over')).toHaveLength(1);

    await act(async () => {
      await staff.send('  Jordan here: I can take $500 off today.  ');
    });
    expect(mounted.calls.at(-1)).toBe('send conv-1 Jordan here: I can take $500 off today.');
    act(() =>
      socket.fire(CONVERSATION_EVENTS.MESSAGE, {
        conversationId: 'conv-1',
        message: { id: 'm-staff-1', role: 'staff', content: 'Jordan here: I can take $500 off today.', createdAt: '2026-10-08T15:00:05.000Z', speaker: jordan },
        at: 2,
      }),
    );
    expect(staff.messages.filter((m) => m.id === 'm-staff-1')).toEqual([
      expect.objectContaining({ role: 'staff', speaker: jordan, content: 'Jordan here: I can take $500 off today.' }),
    ]);

    await act(async () => {
      await staff.handBack();
    });
    expect(mounted.calls.at(-1)).toBe('handBack conv-1');
    expect(staff.hold).toBeNull();
    expect(staff.heldByMe).toBe(false);
  });

  it('shows who else holds it, and says why the platform refused a take-over', async () => {
    mount({
      takeOver: async () => {
        throw new Error('Casey is already answering this conversation.');
      },
    });
    await settle();
    await act(async () => {
      await expect(staff.takeOver()).rejects.toThrow('Casey is already answering this conversation.');
    });
    expect(staff.error).toBe('Casey is already answering this conversation.');
    expect(staff.busy).toBe(false);
  });

  it('follows a take-over by someone else, and does not let them be mistaken for the viewer', async () => {
    const mounted = mount();
    await settle();
    act(() =>
      mounted.socket().fire(CONVERSATION_EVENTS.TAKEN_OVER, {
        conversationId: 'conv-1',
        hold: { conversationId: 'conv-1', holder: casey, since: 5 },
        at: 5,
      }),
    );
    expect(staff.hold?.holder).toEqual(casey);
    expect(staff.heldByMe).toBe(false);
  });

  it('needs the provider, and the platform’s staff seam', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(React.createElement(Console, { conversationId: 'conv-1' }))).toThrow(/within an AgentProvider/);
    spy.mockRestore();
    cleanup();

    const config: AgentClientConfig = {
      createConversation: async () => ({ conversationId: 'x' }),
      sendMessage: async () => ({ turnId: 't', socketRoom: 'r' }),
      realtime: { url: 'wss://rt.example', getToken: () => 't', createSocket: () => createFakeSocket() },
    };
    render(React.createElement(AgentProvider, { config }, React.createElement(Console, { conversationId: 'conv-1' })));
    await settle();
    expect(staff.error).toMatch(/no staff console/);
  });
});
