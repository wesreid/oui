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
import type { ApprovalSettlement } from '@ouispec/agent-core';
import { createHttpApprovalStoreClient, type ApprovalStoreClient } from '../approvals/client.js';

type StreamOpts = {
  messages: ModelMessage[];
  prepareStep: (o: { steps: unknown[]; messages: ModelMessage[] }) => Promise<{ messages?: ModelMessage[] }>;
};
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

/**
 * An approval nobody decided. The card expires, disables its buttons and
 * sends nothing, so no turn ever stored how the call ended: on dev
 * (2026-10-04) a later turn still read "waiting for approval… has not run"
 * and the assistant could not say the approval had expired. At the start of a
 * turn the worker asks the store about each call the history still shows as
 * waiting, and only the store's explicit answer settles one.
 */
describe('a call still stored as waiting, at the start of a later turn', () => {
  beforeEach(() => {
    seen = null;
  });

  const waiting: TurnHistoryMessage[] = [
    { role: 'user', content: 'Save a breaking version.' },
    call('call_save_1'),
    { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
    { role: 'assistant', content: 'Waiting for your approval.' },
  ];
  const expired = { decided: 'expired', ran: false, summary: 'The approval expired before it was used. It was not run.' };
  const marker = (text: string | undefined) => (JSON.parse(text ?? '{}') as { approval?: Record<string, unknown> }).approval;
  /** What the turn's first step reads after the conversation: what is true only for this turn. */
  const tailText = async () => {
    const sent = (await seen!.prepareStep({ steps: [], messages: seen!.messages })).messages!;
    const last = sent[sent.length - 1];
    return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  };
  /** A store that answers `settleExpired` as given, and records what it was asked. */
  function settling(
    answer: (approvalId: string) => ApprovalSettlement['outcome'] | Promise<ApprovalSettlement['outcome']>,
    decided?: ApprovalSettlement['decided'],
    withdrawn?: ApprovalSettlement['withdrawn'],
  ) {
    const asked: Array<{ approvalId: string; userId: string; conversationId: string }> = [];
    const store: ApprovalStoreClient = {
      create: async () => {},
      redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
      status: async () => null,
      settleExpired: async (approvalId, owner) => {
        asked.push({ approvalId, ...owner });
        return { approvalId, outcome: await answer(approvalId), ...(decided ? { decided } : {}), ...(withdrawn ? { withdrawn } : {}) };
      },
    };
    return { store, asked };
  }

  it('expired undecided: the model is told it expired and did not run, and the result is stored under the call’s id', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const { store, asked } = settling(() => 'claimed');
    const result = await runAgentTurn({ ...config, approvals: store }, turn(waiting));

    // Asked as this user, for this conversation: the store checks the owner.
    expect(asked).toEqual([{ approvalId: 'call_save_1', userId: 'user-1', conversationId: 'conv' }]);
    // One call, one result: expired, where "waiting" stood.
    expect(callIds()).toEqual(['call_save_1']);
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(expired);
    expect(marker(results()[0].output?.value)).not.toHaveProperty('by');
    expect(JSON.parse(results()[0].output!.value!)).toMatchObject({ success: false, notRun: true });
    expect(marker(results()[0].output?.value)).not.toHaveProperty('expired');
    expect(JSON.parse(results()[0].output!.value!).message).toMatch(/Do not run it again unless the user asks for it again\.$/);
    expect(JSON.stringify(seen!.messages)).not.toContain('awaitingApproval');
    // And said after the conversation, for this turn.
    expect(await tailText()).toMatch(/<approval>An approval asked for earlier in this conversation expired before the user decided it, so that action did not run\./);

    // Stored once, under the call's own id; the host confirms it after persisting.
    const stored = result.newMessages.filter((m) => m.role === 'tool');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ toolCallId: 'call_save_1', name: 'ui_act' });
    expect(marker(stored[0].content ?? undefined)).toMatchObject(expired);
    expect(result.settledApprovals).toEqual(['call_save_1']);

    // A later turn reads both rows back: the expiry, once.
    seen = null;
    await runAgentTurn(
      config,
      turn([...waiting, { role: 'tool', content: stored[0].content!, tool_call_id: 'call_save_1', name: 'ui_act' }, { role: 'assistant', content: 'It expired.' }]),
    );
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(expired);
  });

  it('approved by the user, and never run: says the user approved it, not that nobody decided', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    // The turn that would have run the approved call died; the approval lapsed unused.
    const result = await runAgentTurn({ ...config, approvals: settling(() => 'claimed', 'approved').store }, turn(waiting));

    const approvedExpired = {
      decided: 'approved',
      by: 'user',
      ran: false,
      expired: true,
      summary: 'Approved by the user on the approval card, but the approval expired before it ran. It was not run.',
    };
    expect(results()).toHaveLength(1);
    expect(marker(results()[0].output?.value)).toMatchObject(approvedExpired);
    const given = JSON.parse(results()[0].output!.value!) as { success: boolean; notRun: boolean; message: string };
    expect(given).toMatchObject({ success: false, notRun: true });
    expect(given.message).toMatch(/Ask the user before running it again\.$/);
    // The note's other wording: the user did decide.
    expect(await tailText()).toMatch(/The user approved an action earlier in this conversation, but the approval expired before it ran; it did not run, so ask before running it again\./);
    expect(await tailText()).not.toMatch(/before the user decided/);

    const stored = result.newMessages.filter((m) => m.role === 'tool');
    expect(stored).toHaveLength(1);
    expect(marker(stored[0].content ?? undefined)).toMatchObject(approvedExpired);
    expect(result.settledApprovals).toEqual(['call_save_1']);
  });

  it('withdrawn because the user sent a new message: said as that, never as time running out (ADR-0252 §2.6)', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn({ ...config, approvals: settling(() => 'claimed', undefined, 'superseded').store }, turn(waiting));

    const given = JSON.parse(results()[0].output!.value!) as { success: boolean; notRun: boolean; message: string };
    expect(marker(results()[0].output?.value)).toMatchObject({
      decided: 'expired',
      ran: false,
      withdrawn: 'superseded',
      summary: 'The approval was withdrawn before the user decided it, because the user sent a new message. It was not run.',
    });
    expect(marker(results()[0].output?.value)).not.toHaveProperty('by');
    expect(given).toMatchObject({ success: false, notRun: true });
    expect(given.message).not.toMatch(/expired before/);
    expect(await tailText()).toMatch(/was withdrawn before it ran, because the user sent a new message or stopped that turn; that action did not run\./);
    expect(await tailText()).not.toMatch(/expired before the user decided/);

    // Stored once, under the call's own id, and confirmed like any expiry.
    const stored = result.newMessages.filter((m) => m.role === 'tool');
    expect(stored).toHaveLength(1);
    expect(marker(stored[0].content ?? undefined)).toMatchObject({ withdrawn: 'superseded' });
    expect(result.settledApprovals).toEqual(['call_save_1']);
  });

  it('approved, then withdrawn before it ran: keeps that the user approved it, and why it did not run', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn({ ...config, approvals: settling(() => 'claimed', 'approved', 'stopped').store }, turn(waiting));
    expect(marker(results()[0].output?.value)).toMatchObject({
      decided: 'approved',
      by: 'user',
      ran: false,
      withdrawn: 'stopped',
      summary: 'Approved by the user on the approval card, but withdrawn before it ran because the user stopped the turn that asked for it. It was not run.',
    });
    expect((JSON.parse(results()[0].output!.value!) as { message: string }).message).toMatch(/Ask the user before running it again\.$/);
  });

  it('claimed by another turn: the model is told for this turn, and nothing is stored', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn({ ...config, approvals: settling(() => 'already').store }, turn(waiting));
    expect(marker(results()[0].output?.value)).toMatchObject(expired);
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
    expect(result.settledApprovals).toBeUndefined();
  });

  it('two turns starting together store one result between them', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    // The store's claim is atomic: the first to ask gets it.
    let claims = 0;
    const { store } = settling(() => (claims++ === 0 ? 'claimed' : 'already'));
    const [one, two] = await Promise.all([
      runAgentTurn({ ...config, approvals: store }, { ...turn(waiting), turnId: 'turn-a' }),
      runAgentTurn({ ...config, approvals: store }, { ...turn(waiting), turnId: 'turn-b' }),
    ]);
    const stored = [...one.newMessages, ...two.newMessages].filter((m) => m.role === 'tool');
    expect(stored).toHaveLength(1);
    expect(marker(stored[0].content ?? undefined)).toMatchObject(expired);
    expect([...(one.settledApprovals ?? []), ...(two.settledApprovals ?? [])]).toEqual(['call_save_1']);
  });

  it.each([
    ['still pending and unexpired: the card is live', 'open'],
    ['declined, redeemed, another conversation’s, or asked for before the store kept this memory', 'unknown'],
  ] as const)('leaves it untouched when the store says it is %s', async (_why, outcome) => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn({ ...config, approvals: settling(() => outcome).store }, turn(waiting));
    expect(results().map((r) => r.output?.value)).toEqual([WAITING]);
    expect(await tailText()).not.toContain('<approval>');
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
    expect(result.settledApprovals).toBeUndefined();
  });

  it('leaves a declined call untouched without asking: its stored result is the decline, not "waiting"', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const { store, asked } = settling(() => 'claimed');
    const declined = JSON.stringify({ approval: { decided: 'declined', by: 'user', ran: false }, success: false, notRun: true });
    const result = await runAgentTurn(
      { ...config, approvals: store },
      turn([...waiting, { role: 'tool', content: declined, tool_call_id: 'call_save_1', name: 'ui_act' }, { role: 'assistant', content: 'Not saved.' }]),
    );
    expect(asked).toEqual([]);
    expect(results().map((r) => r.output?.value)).toEqual([declined]);
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
  });

  it('leaves it untouched when the store cannot be reached, or cannot settle at all', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const { store } = settling(() => Promise.reject(new Error('ECONNREFUSED')));
    await runAgentTurn({ ...config, approvals: store }, turn(waiting));
    expect(results().map((r) => r.output?.value)).toEqual([WAITING]);

    // A host's own store from before this method.
    seen = null;
    const { settleExpired: _none, ...older } = store;
    const result = await runAgentTurn({ ...config, approvals: older }, turn(waiting));
    expect(results().map((r) => r.output?.value)).toEqual([WAITING]);
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
  });

  it('asks about nothing when the turn that stopped is not in the history yet', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const { store, asked } = settling(() => 'claimed');
    // The history a message sent just after `turn_complete` can read: without the call and its "waiting" row.
    const result = await runAgentTurn({ ...config, approvals: store }, turn([{ role: 'user', content: 'Save a breaking version.' }]));
    expect(asked).toEqual([]);
    expect(result.newMessages.filter((m) => m.role === 'tool')).toEqual([]);
  });

  it('does not ask about the call whose decision this very turn carries', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const { store, asked } = settling(() => 'claimed');
    await runAgentTurn(
      { ...config, approvals: store },
      {
        turnId: 'turn-decided',
        conversationId: 'conv',
        userId: 'user-1',
        accountId: 'acct',
        socketRoom: 'agent:turn:turn-decided',
        content: '',
        history: waiting,
        context: null,
        approval: { approvalId: 'call_save_1', decision: 'decline' },
      },
    );
    expect(asked).toEqual([]);
  });
});

describe('the HTTP store client, asked to settle', () => {
  const client = () => createHttpApprovalStoreClient({ url: 'http://realtime.internal', apiKey: 'k' });
  const answering = (status: number, body: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  const owner = { userId: 'user-1', conversationId: 'conv' };

  it('reads a realtime server without the route as "unknown", so nothing is settled', async () => {
    const fetchMock = answering(404, { error: 'Not found' });
    try {
      expect(await client().settleExpired!('call_save_1', owner)).toEqual({ approvalId: 'call_save_1', outcome: 'unknown' });
      await expect(client().confirmExpirySettled!('call_save_1', owner)).resolves.toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('asks with the owner, and confirms with the flag', async () => {
    const fetchMock = answering(200, { approvalId: 'call_save_1', outcome: 'claimed', expiresAt: 1_791_073_000_000 });
    try {
      expect(await client().settleExpired!('call_save_1', owner)).toEqual({ approvalId: 'call_save_1', outcome: 'claimed', expiresAt: 1_791_073_000_000 });
      await client().confirmExpirySettled!('call_save_1', owner);
      const bodies = fetchMock.mock.calls.map(([url, init]) => [String(url), JSON.parse(String((init as RequestInit).body))]);
      expect(bodies).toEqual([
        ['http://realtime.internal/internal/approvals/call_save_1/settle', owner],
        ['http://realtime.internal/internal/approvals/call_save_1/settle', { ...owner, confirm: true }],
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('withdraws with the reason, and reads an older server, which only settles, as not having withdrawn', async () => {
    const fetchMock = answering(200, { approvalId: 'call_save_1', outcome: 'withdrawn' });
    try {
      expect(await client().withdraw!('call_save_1', owner, 'stopped')).toEqual({ approvalId: 'call_save_1', outcome: 'withdrawn' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://realtime.internal/internal/approvals/call_save_1/settle');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ...owner, expire: 'stopped' });
    } finally {
      fetchMock.mockRestore();
    }
    // A server from before this ignores `expire` and answers as a settle: the approval is still live.
    const older = answering(200, { approvalId: 'call_save_1', outcome: 'open' });
    try {
      expect(await client().withdraw!('call_save_1', owner, 'stopped')).toEqual({ approvalId: 'call_save_1', outcome: 'unknown' });
    } finally {
      older.mockRestore();
    }
  });

  it('rejects when the store fails, so the worker leaves the call as it is', async () => {
    const fetchMock = answering(500, { error: 'boom' });
    try {
      await expect(client().settleExpired!('call_save_1', owner)).rejects.toThrow(/could not settle/);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
