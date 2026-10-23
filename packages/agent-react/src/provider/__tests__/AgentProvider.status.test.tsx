// @vitest-environment jsdom
/**
 * The assistant's status and its thinking, as a view reads them: one value
 * for a panel's header, a pill or a title bar (`useAgentStatus`), and the
 * thinking blocks of the conversation's turns (`reasoning`).
 *
 * On dev (2026-10-23) a long Vector Studio turn showed only the typing dots
 * while the canvas changed: nothing said the assistant was planning, or which
 * action it was taking.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig } from '@ouispec/agent-core';
import type { FakeSocket } from './fake-socket.js';

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


const { AgentProvider, useAgent, useAgentStatus } = await import('../AgentProvider.js');

let agent: ReturnType<typeof useAgent>;
let status: ReturnType<typeof useAgentStatus>;
function Probe() {
  agent = useAgent();
  status = useAgentStatus();
  return null;
}

let turn = 0;
let failNextSend = false;
function config(): AgentClientConfig {
  return {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage: async () => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('The platform is down');
      }
      turn += 1;
      return { turnId: `turn-${turn}`, socketRoom: `agent:turn:turn-${turn}`, roomToken: 'tok' };
    },
    realtime: { url: 'wss://rt', getToken: () => 'jwt' },
    toolLabels: { vector_studio_draw_paths: 'Draw paths' },
  };
}

const fire = (event: string, data: Record<string, unknown>) => act(() => socket.fire(event, data));
const send = (text: string) =>
  act(async () => {
    await agent.sendMessage(text);
  });
const call = (id: string, name: string, turnId = `turn-${turn}`) => {
  fire('agent:tool_call_started', { turnId, toolUseId: id, name, input: {} });
  fire('agent:tool_call_complete', { turnId, toolUseId: id, name, success: true, result: { ok: true } });
};

beforeEach(() => {
  turn = 0;
  failNextSend = false;
  render(React.createElement(AgentProvider, { config: config() }, React.createElement(Probe)));
});
afterEach(cleanup);

describe('useAgentStatus', () => {
  it('is idle before anything happens', () => {
    expect(status).toMatchObject({ state: 'idle', activity: null, planning: false, turnId: null });
  });

  it('says the assistant is planning while its model thinks, then names each step it takes', async () => {
    await send('Build three logos');
    expect(status).toMatchObject({ state: 'working', turnId: 'turn-1', activity: null, planning: false });

    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    expect(status).toMatchObject({ state: 'working', planning: true, activity: 'Planning…' });

    fire('agent:reasoning_ended', { turnId: 'turn-1', reasoningId: 'r1' });
    call('c1', 'vector_studio_draw_paths');
    call('c2', 'vector_studio_draw_paths');
    expect(status).toMatchObject({ state: 'working', planning: false, activity: 'Draw paths · 2' });

    call('c3', 'vector_studio_set_keyframe');
    expect(status.activity).toBe('Set keyframe');
  });

  it('stops saying it plans once a call or text arrives, though the end of its thinking has not', async () => {
    await send('Build it');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'c1', name: 'vector_studio_draw_paths', input: {} });
    expect(status).toMatchObject({ planning: false, activity: 'Draw paths' });

    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r2' });
    expect(status.planning).toBe(true);
    fire('agent:token', { turnId: 'turn-1', text: 'Done with the badge.' });
    expect(status).toMatchObject({ planning: false, activity: null });
  });

  it('shows nothing of a turn the person has moved on from', async () => {
    await send('first');
    await send('second');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'late' });
    expect(status).toMatchObject({ state: 'working', turnId: 'turn-2', planning: false });
    expect(agent.reasoning).toEqual([]);
  });

  it('is done when the turn answers, until the person has seen it', async () => {
    await send('Build it');
    fire('agent:turn_complete', { turnId: 'turn-1', endReason: 'complete' });
    expect(status).toMatchObject({ state: 'done', turnId: 'turn-1' });

    act(() => status.clearDone());
    expect(status.state).toBe('idle');
  });

  it('is done until the next message, which starts working again', async () => {
    await send('Build it');
    fire('agent:turn_complete', { turnId: 'turn-1' });
    expect(status.state).toBe('done');
    await send('Now animate it');
    expect(status).toMatchObject({ state: 'working', turnId: 'turn-2' });
  });

  it('waits on the person while a choice is on screen', async () => {
    await send('Build it');
    fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'o1', name: 'present_options', input: {} });
    fire('agent:tool_call_complete', {
      turnId: 'turn-1',
      toolUseId: 'o1',
      name: 'present_options',
      success: true,
      result: { __present_options: true, prompt: 'Which one?', options: [{ label: 'A', value: 'a' }] },
    });
    fire('agent:turn_complete', { turnId: 'turn-1', endReason: 'present_options' });
    expect(status.state).toBe('needs-you');
  });

  it('is a problem when the turn fails, and clearDone does not hide it', async () => {
    await send('Build it');
    fire('agent:turn_error', { turnId: 'turn-1', error: { code: 'X', message: 'The model is unavailable' } });
    expect(status).toMatchObject({ state: 'problem', error: 'The model is unavailable' });
    act(() => status.clearDone());
    expect(status.state).toBe('problem');
    await send('Try again');
    expect(status.state).toBe('working');
  });

  it('is a problem when the turn was cut off at the output limit, used every step, or ran out of time', async () => {
    for (const ending of [{ endReason: 'output_limit' }, { endReason: 'step_count' }, { stopReason: 'deadline' }]) {
      await send('Build it');
      fire('agent:turn_complete', { turnId: `turn-${turn}`, ...ending });
      expect(status.state, JSON.stringify(ending)).toBe('problem');
    }
  });

  it('says nothing after a stop the person asked for', async () => {
    await send('Build it');
    fire('agent:turn_complete', { turnId: 'turn-1', stopReason: 'user_stop' });
    expect(status.state).toBe('idle');
  });

  it('is a problem when the message could not be sent', async () => {
    failNextSend = true;
    await send('Build it');
    expect(status).toMatchObject({ state: 'problem', error: 'The platform is down', turnId: null });
  });

  it('starts over with a new conversation', async () => {
    await send('Build it');
    fire('agent:turn_complete', { turnId: 'turn-1' });
    act(() => agent.startNewConversation());
    expect(status.state).toBe('idle');
  });
});

describe('reasoning', () => {
  it("keeps each thinking block of the conversation's turns, with its summary as it streamed", async () => {
    await send('Build it');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    fire('agent:reasoning_delta', { turnId: 'turn-1', reasoningId: 'r1', text: 'Laying out ' });
    fire('agent:reasoning_delta', { turnId: 'turn-1', reasoningId: 'r1', text: 'the badge.' });
    expect(agent.reasoning).toEqual([{ id: 'r1', turnId: 'turn-1', text: 'Laying out the badge.', startedAt: expect.any(Number) }]);
    fire('agent:reasoning_ended', { turnId: 'turn-1', reasoningId: 'r1' });
    expect(agent.reasoning[0].endedAt).toEqual(expect.any(Number));

    fire('agent:turn_complete', { turnId: 'turn-1' });
    await send('Again');
    fire('agent:reasoning_started', { turnId: 'turn-2', reasoningId: 'r2' });
    expect(agent.reasoning.map((r) => [r.id, r.turnId])).toEqual([
      ['r1', 'turn-1'],
      ['r2', 'turn-2'],
    ]);
  });

  it('ends a block still open when its turn ends', async () => {
    await send('Build it');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    fire('agent:turn_complete', { turnId: 'turn-1' });
    expect(agent.reasoning[0].endedAt).toEqual(expect.any(Number));
  });

  it('goes with the session when it is exported', async () => {
    await send('Build it');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    fire('agent:reasoning_delta', { turnId: 'turn-1', reasoningId: 'r1', text: 'Laying out the badge.' });
    expect(agent.debug.sessionRecord().session.reasoning).toEqual([
      { id: 'r1', turnId: 'turn-1', text: 'Laying out the badge.', startedAt: expect.any(String) },
    ]);
  });

  it('is cleared with the conversation', async () => {
    await send('Build it');
    fire('agent:reasoning_started', { turnId: 'turn-1', reasoningId: 'r1' });
    fire('agent:turn_complete', { turnId: 'turn-1' });
    act(() => agent.startNewConversation());
    expect(agent.reasoning).toEqual([]);
  });
});
