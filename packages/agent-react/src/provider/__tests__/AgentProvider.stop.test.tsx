// @vitest-environment jsdom
/**
 * Stop and barge-in in the tab (ADR-0252 §2.2, §2.5, §2.14).
 *
 * - Stop asks over the socket, from the turn's room. The turn's end arrives
 *   with why, and what the turn had said stays, marked.
 * - A message sent while a turn runs supersedes it: the tab's turn is the new
 *   one at once, and nothing the old turn still sends is shown as in progress.
 * - The tab says which turn's UI requests it runs: none while a new turn has
 *   no id yet, none once a stop is asked. That is what refuses a request a
 *   stopped or superseded turn sends late.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { turnStoppedNote, type AgentClientConfig, type AgentStoredConversation } from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from './fake-socket.js';

vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('Socket.IO must not be used when the host supplies createSocket');
  },
}));

const { AgentProvider, useAgent, STOP_CONFIRM_TIMEOUT_MS } = await import('../AgentProvider.js');
const { storedToAgentMessages } = await import('../stored-messages.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Started = { turnId: string; socketRoom: string; roomToken: string };
const started = (n: number): Started => ({ turnId: `turn-${n}`, socketRoom: `agent:turn:turn-${n}`, roomToken: `tok-${n}` });

/**
 * A provider whose every start after the first waits for the test, and whose
 * socket answers a Stop as `stopAnswer` says (or not at all).
 */
function mount(options: { stopAnswer?: unknown | 'silent'; stopTurn?: AgentClientConfig['stopTurn']; getConversation?: AgentClientConfig['getConversation'] } = {}) {
  let socket!: FakeSocket;
  const starts: Array<ReturnType<typeof deferred<Started>>> = [];
  const sendMessage = vi.fn(async () => {
    if (sendMessage.mock.calls.length === 1) return started(1);
    const start = deferred<Started>();
    starts.push(start);
    return start.promise;
  });
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage,
    ...(options.stopTurn ? { stopTurn: options.stopTurn } : {}),
    ...(options.getConversation ? { getConversation: options.getConversation, listConversations: async () => ({ conversations: [], total: 0 }) } : {}),
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'jwt',
      createSocket: () => {
        socket = createFakeSocket();
        const emit = socket.emit.bind(socket);
        socket.emit = (event: string, ...args: unknown[]) => {
          emit(event, ...args);
          const ack = args[args.length - 1];
          if (event === 'agent:turn_stop' && typeof ack === 'function' && options.stopAnswer !== 'silent') {
            (ack as (answer: unknown) => void)(options.stopAnswer ?? { ok: true, stop: 'requested' });
          }
        };
        return socket;
      },
    },
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
  return { socket, sendMessage, starts };
}

const stops = (socket: FakeSocket) => socket.emitted.filter((e) => e.event === 'agent:turn_stop').map((e) => e.args[0]);
const said = () => agent.messages.filter((m) => m.role === 'assistant');

async function running() {
  const mounted = mount();
  return start(mounted);
}
async function start<T extends ReturnType<typeof mount>>(mounted: T): Promise<T> {
  await act(async () => {
    await agent.sendMessage('Rename the draft, then tidy the notes');
  });
  act(() => {
    mounted.socket.fire('agent:token', { turnId: 'turn-1', text: 'I renamed the draft. Next I will ' });
  });
  return mounted;
}

describe('Stop', () => {
  it('asks from the turn’s room, and shows the turn as stopped when its end arrives, with what it had said', async () => {
    const { socket } = await running();
    expect(agent.isStopping).toBe(false);
    expect(agent.acceptedTurnId()).toBe('turn-1');

    await act(async () => {
      await agent.stopTurn();
    });
    expect(stops(socket)).toEqual([{ turnId: 'turn-1', room: 'agent:turn:turn-1' }]);
    expect(agent.isStopping).toBe(true);
    // Still streaming until the worker has stored the turn and said so.
    expect(agent.isStreaming).toBe(true);
    // From the moment Stop is pressed, the tab runs no more of this turn's UI requests.
    expect(agent.acceptedTurnId()).toBeNull();

    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'user_stop' });
    });
    expect(agent.isStreaming).toBe(false);
    expect(agent.isStopping).toBe(false);
    expect(agent.currentTurnId).toBeNull();
    expect(said()).toEqual([expect.objectContaining({ content: 'I renamed the draft. Next I will ', stopped: 'user_stop', isStreaming: false })]);
  });

  it('pressed twice asks once, and does nothing when no turn runs', async () => {
    const idle = mount();
    await act(async () => {
      await agent.stopTurn();
    });
    expect(stops(idle.socket)).toEqual([]);
    expect(agent.isStopping).toBe(false);
    cleanup();

    const { socket } = await running();
    await act(async () => {
      await Promise.all([agent.stopTurn(), agent.stopTurn()]);
    });
    expect(stops(socket)).toHaveLength(1);
  });

  it('marks a call that was still running as stopped, and keeps a turn that had said nothing', async () => {
    const mounted = mount();
    await act(async () => {
      await agent.sendMessage('Rename the draft');
    });
    act(() => {
      mounted.socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'call-1', name: 'draft_rename', input: {} });
    });
    await act(async () => {
      await agent.stopTurn();
    });
    act(() => {
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'user_stop' });
    });
    expect(agent.messages.find((m) => m.toolCall)?.toolCall?.status).toBe('stopped');
    // It said nothing: one message still says the turn was stopped.
    expect(said()).toEqual([expect.objectContaining({ content: '', stopped: 'user_stop' })]);

    // And the next turn's own end does not sweep that message away as an empty bubble.
    await act(async () => {
      const next = agent.sendMessage('Try again');
      mounted.starts[0].resolve(started(2));
      await next;
    });
    act(() => {
      mounted.socket.fire('agent:token', { turnId: 'turn-2', text: 'Renamed.' });
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-2' });
    });
    expect(said().map((m) => [m.content, m.stopped])).toEqual([
      ['', 'user_stop'],
      ['Renamed.', undefined],
    ]);
  });

  it('asks the platform’s API when the socket cannot: refused there, or a server from before the event', async () => {
    const stopTurn = vi.fn(async () => {});
    const mounted = await start(mount({ stopAnswer: { ok: false, error: 'event not declared' }, stopTurn }));
    await act(async () => {
      await agent.stopTurn();
    });
    expect(stops(mounted.socket)).toHaveLength(1);
    expect(stopTurn).toHaveBeenCalledExactlyOnceWith({ turnId: 'turn-1', conversationId: 'conv-1' });
    expect(agent.isStopping).toBe(true);
  });

  it('not confirmed in time: asks the API once and shows the turn as stopped, so the panel does not go on working', async () => {
    vi.useFakeTimers();
    const stopTurn = vi.fn(async () => {});
    const mounted = await start(mount({ stopTurn }));
    await act(async () => {
      await agent.stopTurn();
    });
    // The socket took it; the worker never confirmed.
    expect(stopTurn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STOP_CONFIRM_TIMEOUT_MS + 10);
    });
    expect(stopTurn).toHaveBeenCalledExactlyOnceWith({ turnId: 'turn-1', conversationId: 'conv-1' });
    expect(agent.isStreaming).toBe(false);
    expect(agent.isStopping).toBe(false);
    expect(said()[0]).toMatchObject({ stopped: 'user_stop' });

    // Its worker is still running: what it goes on sending is not shown as in progress again.
    act(() => {
      mounted.socket.fire('agent:token', { turnId: 'turn-1', text: 'tidy the notes' });
      mounted.socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'call-late', name: 'notes_tidy', input: {} });
      mounted.socket.fire('agent:approval_required', { turnId: 'turn-1', conversationId: 'conv-1', approvalId: 'call-late', tool: 'notes_tidy', preview: { title: 'Tidy' } });
    });
    expect(said()).toEqual([expect.objectContaining({ content: 'I renamed the draft. Next I will ', stopped: 'user_stop', isStreaming: false })]);
    expect(agent.messages.some((m) => m.toolCall)).toBe(false);
    expect(agent.pendingApproval).toBeNull();
    expect(agent.isStreaming).toBe(false);

    // The worker's own announcement, arriving after all, changes nothing; nor does a second one.
    act(() => {
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'user_stop' });
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(said()).toEqual([expect.objectContaining({ content: 'I renamed the draft. Next I will ', stopped: 'user_stop' })]);
  });

  it('a second end for one turn is harmless: it does not end the turn that followed', async () => {
    const mounted = await running();
    act(() => {
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    await act(async () => {
      const next = agent.sendMessage('And the notes');
      mounted.starts[0].resolve(started(2));
      await next;
    });
    act(() => {
      mounted.socket.fire('agent:token', { turnId: 'turn-2', text: 'Tidying' });
      // Delivered twice.
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.isStreaming).toBe(true);
    expect(agent.currentTurnId).toBe('turn-2');
    expect(said().at(-1)).toMatchObject({ content: 'Tidying', isStreaming: true });
  });

  it('a stop that lost to the turn’s own end is forgotten: the turn simply completed', async () => {
    const { socket } = await running();
    await act(async () => {
      await agent.stopTurn();
    });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.isStopping).toBe(false);
    expect(agent.isStreaming).toBe(false);
    expect(said()[0].stopped).toBeUndefined();
  });
});

describe('barge-in: a message sent while a turn runs', () => {
  it('makes the new turn the tab’s at once: the old one is shown as stopped, and what it still sends is not shown as in progress', async () => {
    const { socket, starts, sendMessage } = await running();

    let sending!: Promise<{ turnId: string }>;
    act(() => {
      sending = agent.sendMessage('Actually, delete it');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // Shown as stopped before the platform has answered: its room is left when the new one is
    // joined, so its own end may never arrive to say so.
    expect(said()).toEqual([expect.objectContaining({ content: 'I renamed the draft. Next I will ', stopped: 'superseded', isStreaming: false })]);
    expect(agent.isStreaming).toBe(true);
    // The new turn has no id yet: no turn's UI requests are run.
    expect(agent.acceptedTurnId()).toBeNull();

    // The old turn is still sending.
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-1', text: 'tidy the notes' });
      socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'call-late', name: 'notes_tidy', input: {} });
      socket.fire('agent:approval_required', { turnId: 'turn-1', conversationId: 'conv-1', approvalId: 'call-x', tool: 'notes_delete', preview: { title: 'Delete' } });
    });
    expect(said()[0].content).toBe('I renamed the draft. Next I will ');
    expect(agent.messages.some((m) => m.toolCall?.id === 'call-late')).toBe(false);
    expect(agent.pendingApproval).toBeNull();

    await act(async () => {
      starts[0].resolve(started(2));
      await sending;
    });
    expect(agent.currentTurnId).toBe('turn-2');
    expect(agent.acceptedTurnId()).toBe('turn-2');

    // The old turn's end, with why, if it still arrives: the turn in progress goes on.
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'superseded' });
      socket.fire('agent:token', { turnId: 'turn-2', text: 'Deleted.' });
    });
    expect(agent.isStreaming).toBe(true);
    expect(said().map((m) => [m.content, m.stopped])).toEqual([
      ['I renamed the draft. Next I will ', 'superseded'],
      ['Deleted.', undefined],
    ]);
  });

  it('puts away an approval card that was waiting: the person moved on', async () => {
    const { socket, starts } = await running();
    act(() => {
      socket.fire('agent:approval_required', { turnId: 'turn-1', conversationId: 'conv-1', approvalId: 'call-1', tool: 'publish', preview: { title: 'Publish' } });
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.pendingApproval?.approvalId).toBe('call-1');
    await act(async () => {
      const next = agent.sendMessage('Never mind, rename it instead');
      starts[0].resolve(started(2));
      await next;
    });
    expect(agent.pendingApproval).toBeNull();
  });
});

describe('a turn superseded from another window', () => {
  it('is shown as stopped, and the conversation is read again', async () => {
    const stored: AgentStoredConversation = {
      conversationId: 'conv-1',
      title: null,
      messages: [
        { id: 'm1', role: 'user', content: 'Rename the draft', createdAt: '2026-10-05T10:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'I renamed the draft. Next I will ', createdAt: '2026-10-05T10:00:01.000Z', stopped: { reason: 'superseded', at: 1 } },
        { id: 'm3', role: 'user', content: 'Delete it (from the other window)', createdAt: '2026-10-05T10:00:02.000Z' },
      ],
    };
    const getConversation = vi.fn(async () => stored);
    const mounted = await start(mount({ getConversation }));
    getConversation.mockClear();

    await act(async () => {
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'superseded' });
      await Promise.resolve();
    });
    expect(agent.isStreaming).toBe(false);
    expect(getConversation).toHaveBeenCalledExactlyOnceWith('conv-1');
    expect(agent.messages.map((m) => [m.role, m.content, m.stopped])).toEqual([
      ['user', 'Rename the draft', undefined],
      ['assistant', 'I renamed the draft. Next I will ', 'superseded'],
      ['user', 'Delete it (from the other window)', undefined],
    ]);
  });

  it('does not read the conversation again for the person’s own Stop', async () => {
    const getConversation = vi.fn(async () => ({ conversationId: 'conv-1', title: null, messages: [] }));
    const mounted = await start(mount({ getConversation }));
    getConversation.mockClear();
    await act(async () => {
      await agent.stopTurn();
    });
    act(() => {
      mounted.socket.fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'user_stop' });
    });
    expect(getConversation).not.toHaveBeenCalled();
  });
});

describe('a stored stopped turn', () => {
  it('shows its mark, and a turn that had said nothing as stopped with no text', () => {
    const marker = { reason: 'user_stop', at: 1 } as const;
    expect(
      storedToAgentMessages([
        { id: 'a', role: 'assistant', content: 'Half an answer', createdAt: '2026-10-05T10:00:00.000Z', stopped: marker },
        { id: 'b', role: 'assistant', content: turnStoppedNote(marker), createdAt: '2026-10-05T10:01:00.000Z', stopped: marker },
        { id: 'c', role: 'assistant', content: 'A whole answer', createdAt: '2026-10-05T10:02:00.000Z' },
      ]).map((m) => [m.content, m.stopped]),
    ).toEqual([
      ['Half an answer', 'user_stop'],
      ['', 'user_stop'],
      ['A whole answer', undefined],
    ]);
  });
});
