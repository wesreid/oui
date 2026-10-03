// @vitest-environment jsdom
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig } from '@ouispec/agent-core';
import type { FakeSocket } from './fake-socket.js';

// ─── A fake Socket.IO client ─────────────────────────────────────────────────

let socket: FakeSocket;

vi.mock('socket.io-client', async () => {
  const { createFakeSocket } = await import('./fake-socket.js');
  return {
    io: () => {
      socket = createFakeSocket();
      return socket;
    },
  };
});

// Imported after the mock so the provider sees the fake.
const { AgentProvider, useAgent } = await import('../AgentProvider.js');

// ─── Harness ─────────────────────────────────────────────────────────────────

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}

/** What each turn was sent with. */
const sent: Array<{ content: string; context?: { timeZone?: string; currentPath?: string } }> = [];

function config(): AgentClientConfig {
  return {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage: async (request) => {
      sent.push(request as (typeof sent)[number]);
      return { turnId: 'turn-1', socketRoom: 'agent:turn:turn-1', roomToken: 'tok-1' };
    },
    realtime: { url: 'wss://rt', getToken: () => 'jwt' },
  };
}

const subscribes = () => socket.emitted.filter((e) => e.event === 'subscribe');

beforeEach(() => {
  render(
    React.createElement(AgentProvider, { config: config() }, React.createElement(Probe)),
  );
});
afterEach(cleanup);

describe('AgentProvider turn rooms', () => {
  it('joins the turn room with its token', async () => {
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(subscribes()).toHaveLength(1);
    expect(subscribes()[0].args[0]).toEqual({ rooms: ['agent:turn:turn-1'], tokens: { 'agent:turn:turn-1': 'tok-1' } });
  });

  it('rejoins the turn room after a reconnect, so the turn does not stream to nobody', async () => {
    await act(async () => {
      await agent.sendMessage('hello');
    });
    act(() => {
      socket.connected = false;
      socket.fire('disconnect', 'transport close');
      socket.connected = true;
      socket.fire('connect');
    });
    expect(subscribes()).toHaveLength(2);
    expect(subscribes()[1].args[0]).toEqual({ rooms: ['agent:turn:turn-1'], tokens: { 'agent:turn:turn-1': 'tok-1' } });
  });

  it('stops rejoining once the turn is done', async () => {
    await act(async () => {
      await agent.sendMessage('hello');
    });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    act(() => {
      socket.fire('disconnect', 'transport close');
      socket.fire('connect');
    });
    expect(subscribes()).toHaveLength(1);
  });

  it('joins on connect when the turn started while the socket was down', async () => {
    socket.connected = false;
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(subscribes()).toHaveLength(0);
    act(() => {
      socket.connected = true;
      socket.fire('connect');
    });
    expect(subscribes()).toHaveLength(1);
  });

  it('clears options still on screen when the user sends a new message', async () => {
    await act(async () => {
      await agent.sendMessage('hello');
    });
    act(() => {
      socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'u1', name: 'present_options', input: {} });
      socket.fire('agent:tool_call_complete', {
        turnId: 'turn-1',
        toolUseId: 'u1',
        name: 'present_options',
        success: true,
        result: { __present_options: true, prompt: 'Pick', options: [{ label: 'A', value: 'a' }] },
      });
    });
    expect(agent.presentedOptions?.prompt).toBe('Pick');
    await act(async () => {
      await agent.sendMessage('something else');
    });
    expect(agent.presentedOptions).toBeNull();
  });
});

describe('AgentProvider turn context', () => {
  it('sends the user’s time zone with every turn, as their browser resolves it', async () => {
    sent.length = 0;
    const resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Pacific/Auckland' } as Intl.ResolvedDateTimeFormatOptions);
    try {
      await act(async () => {
        await agent.sendMessage('what day is it?');
      });
    } finally {
      resolved.mockRestore();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].context?.timeZone).toBe('Pacific/Auckland');
  });
});
