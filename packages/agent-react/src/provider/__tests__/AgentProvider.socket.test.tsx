// @vitest-environment jsdom
/**
 * The socket is a seam (ADR-0227 W7): a host's `createSocket` replaces
 * Socket.IO entirely, and the provider runs a turn over it the same way.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig } from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from './fake-socket.js';

const ioCalls: unknown[] = [];
vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => {
    ioCalls.push(args);
    throw new Error('Socket.IO must not be used when the host supplies createSocket');
  },
}));

const { AgentProvider, useAgent } = await import('../AgentProvider.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}
afterEach(cleanup);

describe('a host-supplied socket', () => {
  it('carries the whole turn: connect, the token-bearing join, streamed text and the end of the turn', async () => {
    let made: FakeSocket | null = null;
    const createSocket = vi.fn(({ url }: { url: string }) => {
      expect(url).toBe('wss://rt.example');
      made = createFakeSocket();
      return made;
    });
    const config: AgentClientConfig = {
      createConversation: async () => ({ conversationId: 'conv-1' }),
      sendMessage: async () => ({ turnId: 'turn-1', socketRoom: 'chat:turn:turn-1', roomToken: 'tok-1' }),
      realtime: { url: 'wss://rt.example', getToken: () => 'jwt', createSocket },
    };
    render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));

    const socket = made as unknown as FakeSocket;
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(ioCalls).toEqual([]);
    expect(socket.connected).toBe(true);
    expect(agent.socket).toBe(socket);

    await act(async () => {
      await agent.sendMessage('open my reports');
    });
    expect(socket.emitted.filter((e) => e.event === 'subscribe').map((e) => e.args[0])).toEqual([
      { rooms: ['chat:turn:turn-1'], tokens: { 'chat:turn:turn-1': 'tok-1' } },
    ]);

    act(() => {
      socket.fire('agent:token', { turnId: 'turn-1', text: 'Your reports are open.' });
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    const reply = agent.messages.filter((m) => m.role === 'assistant').at(-1);
    expect(reply?.content).toBe('Your reports are open.');
    expect(agent.isProcessing).toBe(false);
  });
});
