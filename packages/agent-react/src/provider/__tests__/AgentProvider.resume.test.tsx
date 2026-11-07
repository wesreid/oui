// @vitest-environment jsdom
/**
 * Resuming after work, in the provider.
 *
 * On dev (2026-11-06) the assistant started a minute-long image job, reported it still running, and ended its turn;
 * the job finished and nothing told it. With `config.settledWork` wired to the tab's OUI runtime, the provider starts
 * a turn by itself once such work ends after the turn that started it, so the assistant reports the outcome in the
 * same chat: through `sendMessage`, with no message, the requests named in `resume`, and the page as it is now.
 */
import React, { useContext } from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESUME_GATHER_MS, RESUME_MAX_IN_A_ROW, type AgentClientConfig, type AgentStoredConversation, type SettledWork } from '@ouispec/agent-core';
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const started = (n: number) => ({ turnId: `turn-${n}`, socketRoom: `agent:turn:turn-${n}`, roomToken: `tok-${n}` });

/** A provider whose tab's OUI runtime is a test double: `settle` is the runtime saying work has ended. */
function mount(options: { conversations?: Record<string, AgentStoredConversation> } = {}) {
  let socket!: FakeSocket;
  const listeners = new Set<(work: SettledWork) => void>();
  let created = 0;
  const sendMessage = vi.fn(async (_params: Parameters<AgentClientConfig['sendMessage']>[0]) => started(sendMessage.mock.calls.length));
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: `conv-${++created}` }),
    sendMessage,
    settledWork: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ...(options.conversations
      ? {
          getConversation: async (id: string) => options.conversations![id],
          listConversations: async () => ({ conversations: [], total: 0 }),
        }
      : {}),
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'jwt',
      createSocket: () => (socket = createFakeSocket()),
    },
  };
  const view = render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
  /** The host renders again with its config written inline: a new config, and a new source object, every time. */
  const renderInline = () =>
    view.rerender(
      React.createElement(
        AgentProvider,
        { config: { ...config, settledWork: { subscribe: (listener: (work: SettledWork) => void) => config.settledWork!.subscribe(listener) } } },
        React.createElement(Probe),
      ),
    );
  // Every decision is logged: the tests read why nothing was resumed.
  act(() => agent.debug.setEnabled(true));
  // From here, the gathering window runs on the test's clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const settle = (requestId: string, turnId: string, success = true) =>
    act(() => {
      for (const l of [...listeners]) l({ requestId, turnId, surfaceId: 'room:image-studio', actionId: 'image_studio_variants', success, at: Date.now() });
    });
  const gather = (ms = RESUME_GATHER_MS) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  return { socket: () => socket, sendMessage, settle, gather, listeners, renderInline };
}

/** The person's message, and the turn it starts ending as `end` says. */
async function turn(m: ReturnType<typeof mount>, text: string, end: Record<string, unknown> = {}) {
  await act(async () => {
    await agent.sendMessage(text);
  });
  const turnId = agent.currentTurnId!;
  act(() => {
    m.socket().fire('agent:turn_complete', { turnId, ...end });
  });
  return turnId;
}

const resumes = (m: ReturnType<typeof mount>) => m.sendMessage.mock.calls.map((c) => c[0]).filter((p) => p.resume);
/** Why the provider did not resume, as its debug log says, in order. */
const notResumed = () => agent.debug.logs.map((l) => l.message).filter((msg) => msg.startsWith('Not resuming after work'));

describe('resuming after work that finished after its turn ended', () => {
  it('starts a turn by itself: no message, the requests in resume, and the page as a message carries it', async () => {
    const m = mount();
    const t1 = await turn(m, 'Put Ruth on three backgrounds');
    expect(agent.isStreaming).toBe(false);
    const before = agent.messages.length;
    const messageParams = m.sendMessage.mock.calls[0][0];

    m.settle('call_variants', t1);
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
    await m.gather();

    expect(m.sendMessage).toHaveBeenCalledTimes(2);
    const params = m.sendMessage.mock.calls[1][0];
    expect(params).toMatchObject({ conversationId: 'conv-1', content: '', resume: { requestIds: ['call_variants'] } });
    expect(params).not.toHaveProperty('approval');
    // The same context a message carries, from which the host sends the page as it is now.
    expect(Object.keys(params.context ?? {}).sort()).toEqual(Object.keys(messageParams.context ?? {}).sort());
    expect(params.context).toMatchObject({ currentPath: messageParams.context?.currentPath });
    // Nobody wrote anything: no message of the person's is shown.
    expect(agent.messages.filter((msg) => msg.role === 'user')).toHaveLength(1);
    expect(agent.messages.length).toBe(before);
    expect(agent.isStreaming).toBe(true);
    expect(agent.currentTurnId).toBe('turn-2');

    // The resumed turn answers in the same chat.
    act(() => {
      m.socket().fire('agent:token', { turnId: 'turn-2', text: 'The three versions are ready.' });
      m.socket().fire('agent:turn_complete', { turnId: 'turn-2' });
    });
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The three versions are ready.' });
  });

  it('resumes after a turn handed back for time, and after one that failed', async () => {
    const m = mount();
    const t1 = await turn(m, 'Make variants', { endReason: 'time_limit' });
    m.settle('call_1', t1);
    await m.gather();
    expect(resumes(m)).toEqual([expect.objectContaining({ resume: { requestIds: ['call_1'] } })]);
    act(() => {
      m.socket().fire('agent:turn_error', { turnId: 'turn-2', error: { message: 'The model failed' } });
    });
    expect(agent.isStreaming).toBe(false);
    m.settle('call_2', 'turn-2', false);
    await m.gather();
    expect(resumes(m).at(-1)).toMatchObject({ resume: { requestIds: ['call_2'] } });
  });

  it('reports work that ends close together in one turn', async () => {
    const m = mount();
    const t1 = await turn(m, 'Export both');
    m.settle('call_a', t1);
    await m.gather(RESUME_GATHER_MS - 200);
    m.settle('call_b', t1);
    await m.gather(RESUME_GATHER_MS - 1);
    expect(resumes(m)).toEqual([]);
    await m.gather(1);
    expect(resumes(m)).toEqual([expect.objectContaining({ resume: { requestIds: ['call_a', 'call_b'] } })]);
  });

  it('does not resume while a turn runs: that turn carries the outcome', async () => {
    const m = mount();
    const t1 = await turn(m, 'Make variants');
    await act(async () => {
      await agent.sendMessage('And rename the layer');
    });
    expect(agent.isStreaming).toBe(true);
    m.settle('call_1', t1);
    await m.gather();
    // Nor when work that ended during the turn is gathered and the turn is still running.
    m.settle('call_2', 'turn-2');
    await m.gather();
    expect(resumes(m)).toEqual([]);
    expect(notResumed()).toEqual([
      expect.stringMatching(/a turn is running or starting/),
      expect.stringMatching(/the turn that started it has not ended/),
    ]);
  });

  it('does not resume after the person stopped the turn, nor after their newer message superseded it', async () => {
    const m = mount();
    const t1 = await turn(m, 'Make variants', { stopReason: 'user_stop' });
    m.settle('call_1', t1);
    await m.gather();

    // A message sent while turn 2 runs supersedes it.
    await act(async () => {
      await agent.sendMessage('Make more variants');
    });
    await act(async () => {
      await agent.sendMessage('No, just two');
    });
    act(() => {
      m.socket().fire('agent:turn_complete', { turnId: 'turn-3' });
    });
    m.settle('call_2', 'turn-2');
    await m.gather();
    expect(resumes(m)).toEqual([]);
    expect(notResumed()).toEqual([expect.stringMatching(/the person stopped/), expect.stringMatching(/newer message superseded/)]);
  });

  it('does not resume while an approval card waits on the person', async () => {
    const m = mount();
    await act(async () => {
      await agent.sendMessage('Send the report');
    });
    act(() => {
      m.socket().fire('agent:approval_required', {
        turnId: 'turn-1',
        conversationId: 'conv-1',
        approvalId: 'call_send',
        tool: 'reports_send',
        preview: { title: 'Send a report' },
      });
      m.socket().fire('agent:turn_complete', { turnId: 'turn-1', endReason: 'complete' });
    });
    expect(approval.pending?.approvalId).toBe('call_send');
    m.settle('call_export', 'turn-1');
    await m.gather();
    expect(resumes(m)).toEqual([]);
    expect(notResumed()).toEqual([expect.stringMatching(/approval card waits/)]);
  });

  it('does not resume for work of a conversation the person left, or of a turn this tab did not run', async () => {
    const stored = (id: string): AgentStoredConversation => ({ conversationId: id, messages: [] }) as unknown as AgentStoredConversation;
    const m = mount({ conversations: { 'conv-9': stored('conv-9') } });
    const t1 = await turn(m, 'Make variants');
    await act(async () => {
      await agent.switchConversation('conv-9');
    });
    expect(agent.conversationId).toBe('conv-9');
    m.settle('call_1', t1);
    await m.gather();

    // A new conversation forgets the last one's turns too.
    const t2 = await turn(m, 'Make variants here');
    act(() => {
      agent.startNewConversation();
    });
    m.settle('call_2', t2);
    // And another tab's turn (a call's, say) is not this tab's to resume.
    m.settle('call_3', 'turn-of-another-tab');
    await m.gather();
    expect(resumes(m)).toEqual([]);
    expect(notResumed()).toEqual([
      expect.stringMatching(/not started by a turn this tab ran in the open conversation/),
      expect.stringMatching(/not started by a turn this tab ran in the open conversation/),
      expect.stringMatching(/not started by a turn this tab ran in the open conversation/),
    ]);
  });

  it(`resumes at most ${RESUME_MAX_IN_A_ROW} turns in a row, and again once the person writes`, async () => {
    const m = mount();
    let last = await turn(m, 'Render all the drafts');
    for (let n = 0; n < RESUME_MAX_IN_A_ROW + 1; n++) {
      // Each resumed turn starts more work, which ends after it.
      m.settle(`call_${n}`, last);
      await m.gather();
      if (agent.isStreaming) {
        last = agent.currentTurnId!;
        act(() => {
          m.socket().fire('agent:turn_complete', { turnId: last });
        });
      }
    }
    expect(resumes(m)).toHaveLength(RESUME_MAX_IN_A_ROW);
    expect(notResumed()).toEqual([expect.stringMatching(/3 turns were already resumed in a row/)]);

    const after = await turn(m, 'Thanks, one more');
    m.settle('call_after', after);
    await m.gather();
    expect(resumes(m)).toHaveLength(RESUME_MAX_IN_A_ROW + 1);
    expect(resumes(m).at(-1)).toMatchObject({ content: '', resume: { requestIds: ['call_after'] } });
  });

  it('keeps what it gathered when the host renders again with its config inline', async () => {
    const m = mount();
    const t1 = await turn(m, 'Make variants');
    m.settle('call_1', t1);
    act(() => m.renderInline());
    await m.gather(RESUME_GATHER_MS / 2);
    act(() => m.renderInline());
    expect(m.listeners.size).toBe(1);
    await m.gather(RESUME_GATHER_MS / 2);
    expect(resumes(m)).toEqual([expect.objectContaining({ resume: { requestIds: ['call_1'] } })]);
  });

  it('stops listening when the provider unmounts', async () => {
    const m = mount();
    await turn(m, 'Make variants');
    expect(m.listeners.size).toBe(1);
    cleanup();
    expect(m.listeners.size).toBe(0);
  });
});
