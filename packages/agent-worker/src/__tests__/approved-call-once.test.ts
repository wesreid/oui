/**
 * An approved call is ONE call to the model, on every later turn too.
 *
 * A call that waited for the user's approval has two rows in a host's store:
 * "waiting for approval", then what the approved run returned, both under the
 * call's own id. Shown the approved run as a second call ("…-approved"), the
 * assistant warned the user of a duplicate save that had not happened (dev,
 * 2026-10-03). The message history the model is given holds the call once,
 * with the approved run's result where "waiting" stood.
 *
 * The continuation turn itself is covered end to end in
 * approval-turn.e2e.test.ts; this covers the turns after it, which read the
 * rows back from the store, and a store written before this change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { createToolRegistry } from '../tools/types.js';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage } from '../types.js';
import type { ApprovalStoreClient } from '../approvals/client.js';

type StreamOpts = { messages: ModelMessage[] };
let seen: StreamOpts | null = null;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seen = opts;
    return {
      textStream: (async function* () {
        yield 'Saved.';
      })(),
      steps: Promise.resolve([{ text: 'Saved.', toolCalls: [], usage: { inputTokens: 10 } }]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Saved.' }] }),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const config: AgentWorkerConfig = {
  tools: createToolRegistry([]),
  emit: { emit: vi.fn(async () => {}) },
  model: 'test-model',
  systemPrompt: 'You are the assistant.',
};

const WAITING = JSON.stringify({ success: false, awaitingApproval: true, approvalId: 'call_save_1', message: 'Waiting for the user to approve "Save a breaking version" on the approval card. It has not run.' });
const SAVED = JSON.stringify({ result: { version: 4 } });

const call = (id: string): TurnHistoryMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'ui_act', arguments: JSON.stringify({ action: 'version_save_breaking', input: { name: 'breaking' } }) } }],
});

const turn = (history: TurnHistoryMessage[]): AgentTurnInput => ({
  turnId: 'turn-after',
  conversationId: 'conv',
  userId: 'user-1',
  accountId: 'acct',
  socketRoom: 'agent:turn:turn-after',
  content: 'How many versions are there now?',
  history: [...history, { role: 'user', content: 'How many versions are there now?' }],
  context: null,
});

type Part = { type: string; toolCallId?: string; output?: { value?: string } };
const parts = (role: 'assistant' | 'tool') =>
  seen!.messages.filter((m) => m.role === role).flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]) : []));
const callIds = () => parts('assistant').filter((p) => p.type === 'tool-call').map((p) => p.toolCallId);
const results = () => parts('tool').filter((p) => p.type === 'tool-result');

describe('the history the model is given holds an approved call once', () => {
  beforeEach(() => {
    seen = null;
  });

  it('gives the approved run’s result as the result of the call, where "waiting for approval" stood', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Waiting for your approval.' },
        // The continuation turn: the user's click, then the approved run's result under the same call id.
        { role: 'user', content: '' },
        { role: 'tool', content: SAVED, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Saved version 4.' },
      ]),
    );

    expect(callIds()).toEqual(['call_save_1']);
    expect(results().map((r) => r.toolCallId)).toEqual(['call_save_1']);
    expect(results()[0].output?.value).toBe(SAVED);
    expect(JSON.stringify(seen!.messages)).not.toContain('awaitingApproval');
    // The result follows its call directly, as a provider requires.
    const at = seen!.messages.findIndex((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Part[]).some((p) => p.type === 'tool-call'));
    expect(seen!.messages[at + 1].role).toBe('tool');
  });

  it('leaves a call that is still waiting as it is', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Waiting for your approval.' },
      ]),
    );
    expect(results().map((r) => r.output?.value)).toEqual([WAITING]);
  });

  it('reads a store written before this change as it was written: two calls, each with its own result', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'user', content: '' },
        call('call_save_1-approved'),
        { role: 'tool', content: SAVED, tool_call_id: 'call_save_1-approved', name: 'ui_act' },
      ]),
    );
    expect(callIds()).toEqual(['call_save_1', 'call_save_1-approved']);
    expect(results().map((r) => r.output?.value)).toEqual([WAITING, SAVED]);
  });
});

/**
 * How a call that waited for approval ended is in its stored result, so no
 * state is ambiguous on a later turn: approved and run once, declined, or
 * expired. With only the plain result in place of "waiting for approval", the
 * assistant on the next turn could not tell that the person had approved
 * anything, and took back having said so (dev, 2026-10-03).
 */
describe('the stored result says how the approval ended', () => {
  beforeEach(() => {
    seen = null;
  });

  const waiting: TurnHistoryMessage[] = [
    { role: 'user', content: 'Save a breaking version.' },
    call('call_save_1'),
    { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
    { role: 'assistant', content: 'Waiting for your approval.' },
  ];
  const store = (over: Partial<ApprovalStoreClient>): ApprovalStoreClient => ({
    create: async () => {},
    redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
    status: async () => null,
    ...over,
  });
  /** The continuation turn after a decision: no message, the decision beside it. */
  const continuation = (approval: AgentTurnInput['approval']): AgentTurnInput => ({
    turnId: 'turn-decided',
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:turn-decided',
    content: '',
    history: waiting,
    context: null,
    approval,
  });
  const marker = (text: string | undefined) => (JSON.parse(text ?? '{}') as { approval?: Record<string, unknown> }).approval;

  it('declined: in the continuation turn, in what is stored, and on a later turn read back from the store', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      { ...config, approvals: store({ status: async () => ({ approvalId: 'call_save_1', status: 'declined', tool: 'x', title: 'Save a breaking version' }) }) },
      continuation({ approvalId: 'call_save_1', decision: 'decline' }),
    );
    const declined = { decided: 'declined', by: 'user', ran: false, summary: 'Declined by the user on the approval card. It was not run.' };

    // The continuation turn: one call, and its result is the decline, where "waiting" stood.
    expect(callIds()).toEqual(['call_save_1']);
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(declined);
    expect(JSON.stringify(seen!.messages)).not.toContain('awaitingApproval');

    // Stored under the call's own id.
    const stored = result.newMessages.find((m) => m.role === 'tool');
    expect(stored).toMatchObject({ role: 'tool', toolCallId: 'call_save_1', name: 'ui_act' });
    expect(marker(stored!.content ?? undefined)).toMatchObject(declined);

    // A later turn reads both rows back: the model is given the decline, once.
    seen = null;
    await runAgentTurn(
      config,
      turn([...waiting, { role: 'tool', content: stored!.content!, tool_call_id: 'call_save_1', name: 'ui_act' }, { role: 'assistant', content: 'Not saved.' }]),
    );
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(declined);
    expect(results()[0].output?.value).toContain('Do not run it again unless the user asks');
  });

  it('expired: nobody decided it, and it was not run', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      { ...config, approvals: store({ redeem: async () => ({ ok: false, reason: 'expired', error: 'expired' }) }) },
      continuation({ approvalId: 'call_save_1', decision: 'approve', token: 'tok' }),
    );
    const expired = { decided: 'expired', ran: false, summary: 'The approval expired before it was used. It was not run.' };
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(expired);
    expect(marker(results()[0].output?.value)).not.toHaveProperty('by');
    const stored = result.newMessages.find((m) => m.role === 'tool');
    expect(stored).toMatchObject({ toolCallId: 'call_save_1' });
    expect(marker(stored!.content ?? undefined)).toMatchObject(expired);
  });

  it('an approval already used leaves the call’s result as it is: that run’s result stands', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const ran = JSON.stringify({ approval: { decided: 'approved', by: 'user', ran: true }, result: { version: 4 } });
    const result = await runAgentTurn(
      { ...config, approvals: store({}) },
      {
        ...continuation({ approvalId: 'call_save_1', decision: 'approve', token: 'tok' }),
        history: [...waiting, { role: 'tool', content: ran, tool_call_id: 'call_save_1', name: 'ui_act' }],
      },
    );
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
    expect(results().map((r) => r.output?.value)).toEqual([ran]);
  });
});
