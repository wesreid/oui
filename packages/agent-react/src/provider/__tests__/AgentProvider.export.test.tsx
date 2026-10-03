// @vitest-environment jsdom
/**
 * A session's export can be replayed (ADR-0244 §2.7): every call the
 * assistant made is in it with the arguments it was made with — a call that
 * ran, a call that was refused, and a call reloaded from a stored
 * conversation — and it names the package and the version that wrote it.
 *
 * The export of the 2026-10-02 vector studio session held `{ id, name,
 * status, result }` for 168 calls and no arguments, so what the assistant had
 * asked for could only be guessed from what came back.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig, AgentStoredMessage } from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from './fake-socket.js';
import { storedToAgentMessages } from '../stored-messages.js';

vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('the test supplies its socket');
  },
}));

const { AgentProvider, useAgent } = await import('../AgentProvider.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}
afterEach(cleanup);

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as { name: string; version: string };

interface Exported {
  sdk: string;
  sdkVersion: string;
  session: { messages: { role: string; toolCall?: { id: string; name: string; arguments?: unknown; status: string; result?: unknown } }[] };
}

describe('the session export', () => {
  it('holds each call with its arguments and its outcome, a refused one included, and says what wrote it', async () => {
    let made: FakeSocket | null = null;
    const config: AgentClientConfig = {
      createConversation: async () => ({ conversationId: 'conv-1' }),
      sendMessage: async () => ({ turnId: 'turn-1', socketRoom: 'chat:turn:turn-1', roomToken: 'tok-1' }),
      realtime: { url: 'wss://rt.example', getToken: () => 'jwt', createSocket: () => (made = createFakeSocket()) },
    };
    render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
    const socket = made as unknown as FakeSocket;
    await act(async () => {
      await agent.sendMessage('centre the anchor on Anim 11');
    });

    const keyframe = { layer_id: 'vector-bbdcb803', property: 'motion.anchorPoint', time: 0, value: [0.5, 0.5] };
    act(() => {
      socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'u1', name: 'vector_studio_set_keyframe', input: keyframe });
      socket.fire('agent:tool_call_complete', {
        turnId: 'turn-1',
        toolUseId: 'u1',
        name: 'vector_studio_set_keyframe',
        result: { result: { keys: ['motion.anchorPoint'], time: 0 } },
        success: true,
      });
      // A call the worker refused before it ran: it arrives started and failed, with what was asked.
      socket.fire('agent:tool_call_started', { turnId: 'turn-1', toolUseId: 'u2', name: 'vector_studio_select', input: { ids: 'Anim 11' } });
      socket.fire('agent:tool_call_complete', {
        turnId: 'turn-1',
        toolUseId: 'u2',
        name: 'vector_studio_select',
        result: { error: 'Invalid input for "vector_studio_select": ids must be an array', refused: true },
        success: false,
      });
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });

    // Through JSON, as the downloaded file holds it.
    const exported = JSON.parse(JSON.stringify(agent.debug.sessionRecord())) as Exported;
    expect(exported.sdk).toBe(pkg.name);
    expect(exported.sdkVersion).toBe(pkg.version);
    const calls = exported.session.messages.filter(m => m.role === 'tool').map(m => m.toolCall!);
    expect(calls).toEqual([
      {
        id: 'u1',
        name: 'vector_studio_set_keyframe',
        arguments: keyframe,
        status: 'complete',
        result: { result: { keys: ['motion.anchorPoint'], time: 0 } },
      },
      {
        id: 'u2',
        name: 'vector_studio_select',
        arguments: { ids: 'Anim 11' },
        status: 'error',
        result: { error: 'Invalid input for "vector_studio_select": ids must be an array', refused: true },
      },
    ]);
  });

  it('keeps a stored conversation’s arguments when it is opened again', () => {
    const stored: AgentStoredMessage[] = [
      { id: 'm1', role: 'user', content: 'rename it', createdAt: '2026-10-02T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: null,
        createdAt: '2026-10-02T10:00:01Z',
        toolCalls: [{ id: 'c1', name: 'vector_studio_rename', arguments: { id: 'vector-bbdcb803', name: 'TRAIDR Anim 11' } }],
      },
      { id: 'm3', role: 'tool', toolCallId: 'c1', content: '{"id":"vector-bbdcb803","name":"TRAIDR Anim 11"}', createdAt: '2026-10-02T10:00:02Z' },
    ];
    const [, call] = storedToAgentMessages(stored);
    expect(call.toolCall).toEqual({
      id: 'c1',
      name: 'vector_studio_rename',
      arguments: { id: 'vector-bbdcb803', name: 'TRAIDR Anim 11' },
      status: 'complete',
      result: { id: 'vector-bbdcb803', name: 'TRAIDR Anim 11' },
    });
  });

  it('shows a UI action run through ui_act as that action, as the live stream named it (ADR-0245)', () => {
    const stored: AgentStoredMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: null,
        createdAt: '2026-10-02T10:00:01Z',
        toolCalls: [
          { id: 'c1', name: 'ui_act', arguments: { action: 'vector_studio_rename', input: { id: 'vector-1', name: 'Wordmark' } } },
          { id: 'c2', name: 'ui_act', arguments: { action: 'editor_undo' } },
          { id: 'c3', name: 'ui_describe', arguments: { actions: ['editor_undo'] } },
        ],
      },
      { id: 'm2', role: 'tool', toolCallId: 'c1', content: '{"result":{"renamed":true}}', createdAt: '2026-10-02T10:00:02Z' },
    ];
    expect(storedToAgentMessages(stored).map((m) => m.toolCall)).toEqual([
      { id: 'c1', name: 'vector_studio_rename', arguments: { id: 'vector-1', name: 'Wordmark' }, status: 'complete', result: { result: { renamed: true } } },
      { id: 'c2', name: 'editor_undo', status: 'complete' },
      { id: 'c3', name: 'ui_describe', arguments: { actions: ['editor_undo'] }, status: 'complete' },
    ]);
  });
});
