// @vitest-environment jsdom
/**
 * A turn's end ends the tab's turn only when it is the turn the tab is running.
 *
 * On dev (2026-10-03) a person approved a card the instant it appeared. The
 * turn that had stopped for the approval sent its `agent:turn_complete` 0.3 s
 * after the click, when the continuation had already been started. The
 * provider applied it blindly: `isStreaming` went false for the whole
 * continuation, and the host, which accepts the assistant's requests only
 * while a turn is in progress, refused every one ("[OUI] Refused a request the
 * client does not accept: oui.describe"). The approved action never ran.
 */
import React, { useContext } from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig } from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from './fake-socket.js';

vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('Socket.IO must not be used when the host supplies createSocket');
  },
}));

const { AgentProvider, useAgent } = await import('../AgentProvider.js');
const { ApprovalDecisionContext } = await import('../../approvals/decision.js');

let agent: ReturnType<typeof useAgent>;
let approval: NonNullable<React.ContextType<typeof ApprovalDecisionContext>>;
function Probe() {
  agent = useAgent();
  approval = useContext(ApprovalDecisionContext)!;
  return null;
}
afterEach(cleanup);

/** A promise the test settles when it chooses: a start request still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Started = { turnId: string; socketRoom: string; roomToken: string };
const started = (n: number): Started => ({ turnId: `turn-${n}`, socketRoom: `agent:turn:turn-${n}`, roomToken: `tok-${n}` });

/** A provider whose every start after the first waits for the test to answer it. */
function mount() {
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
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'jwt',
      createSocket: () => {
        socket = createFakeSocket();
        // The realtime server's answer to a decision on the approval card.
        const emit = socket.emit.bind(socket);
        socket.emit = (event: string, ...args: unknown[]) => {
          emit(event, ...args);
          const ack = args[args.length - 1];
          if (event === 'approval:decide' && typeof ack === 'function') {
            const { approvalId, decision } = args[0] as { approvalId: string; decision: 'approve' | 'decline' };
            (ack as (answer: unknown) => void)(
              decision === 'approve'
                ? { ok: true, decision, approvalId, token: 'signed-token', argsHash: 'hash', expiresAt: Date.now() + 60_000 }
                : { ok: true, decision, approvalId },
            );
          }
        };
        return socket;
      },
    },
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
  return { socket, sendMessage, starts };
}

/** Whether the provider still listens for a turn's events: the room's handlers are on the socket. */
const listening = (socket: FakeSocket) => (socket.handlers.get('agent:turn_complete') ?? []).length;
const unsubscribed = (socket: FakeSocket) => socket.emitted.filter((e) => e.event === 'unsubscribe').flatMap((e) => e.args[0] as string[]);

describe('the end of a turn that is not the one in progress', () => {
  it('does not end the continuation: approval required, approved at once, then the stopped turn’s completion', async () => {
    const { socket, sendMessage, starts } = mount();
    await act(async () => {
      await agent.sendMessage('Save a breaking version');
    });
    expect(agent.isStreaming).toBe(true);

    // The turn stops for the person's approval; its completion has not arrived yet.
    act(() => {
      socket.fire('agent:approval_required', {
        turnId: 'turn-1',
        conversationId: 'conv-1',
        approvalId: 'call_save_1',
        tool: 'version_save_breaking',
        preview: { title: 'Save a breaking version' },
      });
    });
    expect(approval.pending?.approvalId).toBe('call_save_1');

    // The person approves at once: the continuation's start is now in flight.
    let deciding!: Promise<void>;
    act(() => {
      deciding = approval.decide('approve');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toMatchObject({ content: '', approval: { approvalId: 'call_save_1', decision: 'approve', token: 'signed-token' } });
    expect(agent.isStreaming).toBe(true);

    // The stopped turn's completion arrives 0.3 s after the click.
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.isStreaming).toBe(true);

    // The start returns: the tab's turn is the continuation.
    await act(async () => {
      starts[0].resolve(started(2));
      await deciding;
    });
    expect(agent.isStreaming).toBe(true);
    expect(agent.currentTurnId).toBe('turn-2');
    // It listens in the continuation's room, which the earlier turn's end did not close.
    expect(listening(socket)).toBe(1);
    expect(unsubscribed(socket)).toEqual(['agent:turn:turn-1']);
    expect(socket.emitted.filter((e) => e.event === 'subscribe').at(-1)!.args[0]).toEqual({
      rooms: ['agent:turn:turn-2'],
      tokens: { 'agent:turn:turn-2': 'tok-2' },
    });

    // A request that arrives now is one a host gating on `isStreaming` accepts: the turn is in progress.
    const accept = () => agent.isStreaming;
    expect(accept()).toBe(true);

    // The continuation's own text and completion are its own.
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-2', text: 'Saved version 4.' });
    });
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Saved version 4.' });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-2' });
    });
    expect(agent.isStreaming).toBe(false);
    expect(agent.currentTurnId).toBeNull();
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Saved version 4.', isStreaming: false });
  });

  it('does not end the next turn either when the earlier turn fails late, and says the failure', async () => {
    const { socket, starts } = mount();
    await act(async () => {
      await agent.sendMessage('first');
    });
    let sending!: Promise<unknown>;
    act(() => {
      sending = agent.sendMessage('second');
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The earlier turn's error arrives while the next turn's start is in flight.
    act(() => {
      socket.fire('agent:turn_error', { turnId: 'turn-1', error: { code: 'TURN_ERROR', message: 'The first turn failed' } });
    });
    expect(agent.isStreaming).toBe(true);

    await act(async () => {
      starts[0].resolve(started(2));
      await sending;
    });
    expect(agent.isStreaming).toBe(true);
    expect(agent.currentTurnId).toBe('turn-2');
    expect(listening(socket)).toBe(1);
    // The failure is said, once.
    expect(agent.messages.filter((m) => m.content === 'The first turn failed')).toHaveLength(1);
    // And the second turn's text is not lost to it.
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-2', text: 'Second answer.' });
      socket.fire('agent:turn_complete', { turnId: 'turn-2' });
    });
    expect(agent.messages.at(-1)).toMatchObject({ content: 'Second answer.', isStreaming: false });
    expect(agent.isStreaming).toBe(false);
  });

  it('judges an end held during a start by its turn id: the new turn’s own end, heard early, ends it', async () => {
    const { socket, starts } = mount();
    await act(async () => {
      await agent.sendMessage('first');
    });
    let sending!: Promise<unknown>;
    act(() => {
      sending = agent.sendMessage('second');
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Both ends arrive before the start returns: the earlier turn's, and (a very short turn) the new turn's own.
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
      socket.fire('agent:turn_complete', { turnId: 'turn-2' });
    });
    // Neither is applied nor dropped while the tab's turn has no id.
    expect(agent.isStreaming).toBe(true);

    await act(async () => {
      starts[0].resolve(started(2));
      await sending;
    });
    // Judged now: turn-1's end was not this turn's; turn-2's was, so the turn has ended.
    expect(agent.isStreaming).toBe(false);
    expect(agent.currentTurnId).toBeNull();
    // And it does not go on listening in a room whose turn is over.
    expect(listening(socket)).toBe(0);
    expect(socket.emitted.filter((e) => e.event === 'subscribe')).toHaveLength(1);
  });

  it('ends the turn when the start fails, and an end held meanwhile is the earlier turn’s', async () => {
    const { socket, starts } = mount();
    await act(async () => {
      await agent.sendMessage('first');
    });
    let sending!: Promise<unknown>;
    act(() => {
      sending = agent.sendMessage('second');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.isStreaming).toBe(true);
    await act(async () => {
      starts[0].reject(new Error('The request failed'));
      await sending;
    });
    expect(agent.isStreaming).toBe(false);
    expect(agent.currentTurnId).toBeNull();
    // The earlier turn's room is left, as its completion asks.
    expect(listening(socket)).toBe(0);
    expect(agent.messages.at(-1)).toMatchObject({ content: 'The request failed' });
  });
});

describe('the end of the turn in progress', () => {
  it('ends it after a reconnect, which rejoins the turn’s room', async () => {
    const { socket } = mount();
    await act(async () => {
      await agent.sendMessage('first');
    });
    act(() => {
      socket.fire('agent:token', { turnId: 'turn-1', text: 'Working…' });
    });
    // The connection drops and comes back mid-turn.
    act(() => {
      socket.disconnect();
      socket.fire('disconnect', 'transport close');
    });
    act(() => {
      socket.connect();
    });
    expect(socket.emitted.filter((e) => e.event === 'subscribe').at(-1)!.args[0]).toEqual({
      rooms: ['agent:turn:turn-1'],
      tokens: { 'agent:turn:turn-1': 'tok-1' },
    });
    expect(agent.isStreaming).toBe(true);

    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    expect(agent.isStreaming).toBe(false);
    expect(agent.currentTurnId).toBeNull();
    expect(listening(socket)).toBe(0);
  });

  it('is not ended by another turn’s completion heard in its room', async () => {
    const { socket } = mount();
    await act(async () => {
      await agent.sendMessage('first');
    });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'some-other-turn' });
    });
    expect(agent.isStreaming).toBe(true);
    expect(agent.currentTurnId).toBe('turn-1');
    expect(listening(socket)).toBe(1);
  });
});
