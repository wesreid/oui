/**
 * The worker's approval pieces on their own (ADR-0228): what a declaration
 * requires, the card's words, the turn after a decision, the turn payload,
 * and failing closed when there is no store. The whole flow runs end to end in
 * approval-turn.e2e.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ApprovalRedeemResult, ApprovalStatus } from '@ouispec/agent-core';
import { approvalRequirement, APPROVAL_TOOL_NOTE } from '../approvals/requirement.js';
import { buildApprovalPreview } from '../approvals/preview.js';
import { approvalMarker, markedResult, notRunResult, resolveContinuation } from '../approvals/continuation.js';
import { createHttpApprovalStoreClient, type ApprovalStoreClient } from '../approvals/client.js';
import { payloadRefusal } from '../runtime/turn-runner.js';
import { buildUITools } from '../ui/ui-tools.js';
import { runAgentTurn } from '../orchestrator.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import { getToolStrategyRules, getUIControlRules } from '../prompt/index.js';
import { respondingOpenAI } from './support/replay.js';
import { pageOf } from './support/page.js';

const tool = (over: Partial<RegisteredTool> = {}): RegisteredTool => ({
  name: 'orders_place',
  description: 'Places an order on the exchange.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ success: true }),
  ...over,
});

describe('what a declaration requires', () => {
  it('a transaction always, a destructive write, and nothing else', () => {
    expect(approvalRequirement(tool({ effect: { kind: 'transaction' } }))).toMatchObject({ required: true, effectName: 'transaction', destructive: false });
    expect(approvalRequirement(tool({ effect: { kind: 'mutate', operation: 'deleteAsset' }, destructive: true }))).toMatchObject({
      required: true,
      effectName: 'mutate',
    });
    // An undeclared effect counts as a write.
    expect(approvalRequirement(tool({ destructive: true }))).toMatchObject({ required: true, effectName: 'write' });
    expect(approvalRequirement(tool({ effect: 'view', destructive: true })).required).toBe(false);
    expect(approvalRequirement(tool({ effect: 'edit' })).required).toBe(false);
    expect(approvalRequirement(tool()).required).toBe(false);
  });

  it('lasts 5 minutes, or what the transaction declares, never more than 30', () => {
    expect(approvalRequirement(tool({ effect: { kind: 'transaction' } })).ttlMs).toBe(5 * 60_000);
    expect(approvalRequirement(tool({ effect: { kind: 'transaction', approvalMinutes: 12 } })).ttlMs).toBe(12 * 60_000);
    expect(approvalRequirement(tool({ effect: { kind: 'transaction', approvalMinutes: 90 } })).ttlMs).toBe(30 * 60_000);
  });
});

describe("the approval card's words", () => {
  const order = tool({
    title: 'Place an order',
    inputSchema: {
      type: 'object',
      properties: {
        side: { type: 'string', title: 'Side', oneOf: [{ const: 'buy', title: 'Buy' }, { const: 'sell', title: 'Sell' }] },
        symbol: { type: 'string', title: 'Symbol' },
        quantity: { type: 'integer', title: 'Quantity' },
        limitPrice: { type: 'number' },
        accounts: { type: 'array', items: { type: 'string' }, title: 'Accounts' },
      },
    },
  });

  it('come from the declaration: its title, what it does, its labels, in its order', () => {
    const preview = buildApprovalPreview(order, { quantity: 100, symbol: 'ACME', side: 'buy', limitPrice: 12.5, accounts: ['a1', 'a2'], note: { x: 1 } });
    expect(preview).toEqual({
      title: 'Place an order',
      consequence: 'Places an order on the exchange.',
      arguments: [
        { name: 'side', label: 'Side', value: 'Buy' },
        { name: 'symbol', label: 'Symbol', value: 'ACME' },
        { name: 'quantity', label: 'Quantity', value: '100' },
        { name: 'limitPrice', label: 'limitPrice', value: '12.5' },
        { name: 'accounts', label: 'Accounts', value: 'a1, a2' },
        { name: 'note', label: 'note', value: '{"x":1}' },
      ],
      readback:
        'Place an order: Side Buy, Symbol ACME, Quantity 100, limitPrice 12.5, Accounts a1, a2, note {"x":1}. Places an order on the exchange.',
    });
  });

  it('name the tool when it has no title, and say nothing twice', () => {
    expect(buildApprovalPreview(tool({ description: 'orders_place' }), {})).toEqual({ title: 'orders_place', arguments: [], readback: 'orders_place.' });
  });
});

describe('a UI action as a tool', () => {
  const channel = { dispatch: vi.fn(), awaitResult: vi.fn() };
  const deps = { channel, resultTimeoutMs: 1000, currentPage: () => [], onResult: () => {} };

  it('carries its title, effect and destructiveness from the declaration, and no "confirm first" sentence', () => {
    const { tools } = buildUITools(
      pageOf([
        {
          id: 'assets',
          name: 'Assets',
          description: 'x',
          actions: [
            { id: 'assets_delete', description: 'Deletes an asset for good.', confirm: true, input: { type: 'object', properties: {} } },
            { id: 'assets_publish', title: 'Publish', description: 'Publishes it.', effect: { kind: 'transaction' }, input: { type: 'object' } } as never,
          ],
        },
      ]),
      deps,
    );
    const [del, publish] = tools;
    expect(del).toMatchObject({ destructive: true, title: 'Deletes an asset for good.', consequence: 'Deletes an asset for good.' });
    expect(publish).toMatchObject({ title: 'Publish', consequence: 'Publishes it.', effect: { kind: 'transaction' } });
    for (const t of tools) {
      expect(t.description).not.toMatch(/Confirm with the user/);
      expect(approvalRequirement(t).required).toBe(true);
    }
  });

  it('the prompts and confirm_action no longer ask for a yes in chat for such a call', () => {
    for (const text of [getUIControlRules(), getToolStrategyRules()]) {
      expect(text).not.toMatch(/Confirm with the user|ALWAYS ask for user confirmation before permanent deletions/);
      expect(text).toContain('approval card');
    }
    expect(APPROVAL_TOOL_NOTE).toMatch(/never treat a typed yes as approval/);
    const confirm = loadBuiltinTools().find((t) => t.name === 'confirm_action')!;
    expect(confirm.description).toMatch(/Never use it for a tool marked "Needs the user's approval"/);
  });
});

describe('the turn after a decision', () => {
  const turn = { userId: 'ana', conversationId: 'c1' };
  const store = (over: Partial<ApprovalStoreClient>): ApprovalStoreClient => ({
    create: async () => {},
    redeem: async (): Promise<ApprovalRedeemResult> => ({ ok: false, reason: 'used', error: 'x' }),
    status: async (): Promise<ApprovalStatus | null> => null,
    ...over,
  });

  it('runs the redeemed call, and nothing when the store refuses or cannot be reached', async () => {
    const call = { approvalId: 'a', toolCallId: 'a', conversationId: 'c1', turnId: 't', userId: 'ana', tool: 'x', args: {}, argsHash: 'h', effect: 'transaction', destructive: false, channel: 'ui' as const };
    expect(await resolveContinuation(store({ redeem: async () => ({ ok: true, call }) }), { approvalId: 'a', decision: 'approve', token: 't' }, turn)).toEqual({ kind: 'run', call });
    for (const [reason, words] of [['expired', 'expired'], ['used', 'already been used'], ['forbidden', 'another user'], ['invalid', 'not valid'], ['mismatch', 'not for that call']] as const) {
      const out = await resolveContinuation(store({ redeem: async () => ({ ok: false, reason, error: '' }) }), { approvalId: 'a', decision: 'approve', token: 't' }, turn);
      expect(out.kind === 'note' && out.note).toMatch(new RegExp(`did not run: .*${words}`));
    }
    const down = await resolveContinuation(store({ redeem: async () => Promise.reject(new Error('ECONNREFUSED')) }), { approvalId: 'a', decision: 'approve', token: 't' }, turn);
    expect(down).toEqual({ kind: 'note', note: expect.stringMatching(/did not run: the approval could not be checked/) });
    expect(await resolveContinuation(undefined, { approvalId: 'a', decision: 'approve', token: 't' }, turn)).toMatchObject({ kind: 'note' });
  });

  it('tells the model the user declined only when the store says so', async () => {
    const declined = await resolveContinuation(
      store({ status: async () => ({ approvalId: 'a', status: 'declined', tool: 'x', title: 'Place an order' }) }),
      { approvalId: 'a', decision: 'decline' },
      turn,
    );
    // A decline settles the call: its stored result will say so.
    expect(declined).toEqual({
      kind: 'note',
      settled: 'declined',
      note: expect.stringMatching(/The user declined "Place an order" .* did not run/),
    });
    const claimed = await resolveContinuation(store({}), { approvalId: 'a', decision: 'decline' }, turn);
    expect(claimed).toEqual({
      kind: 'note',
      settled: 'declined',
      note: expect.stringMatching(/did not approve the action, so it did not run/),
    });
  });

  it('settles a call whose approval expired, and no other refusal', async () => {
    const refused = (reason: 'expired' | 'used' | 'invalid' | 'unknown') =>
      resolveContinuation(store({ redeem: async () => ({ ok: false, reason, error: reason }) }), { approvalId: 'a', decision: 'approve', token: 't' }, turn);
    expect(await refused('expired')).toMatchObject({ kind: 'note', settled: 'expired', note: expect.stringMatching(/expired/) });
    // An approval already used ran its call: that result stands. The others say nothing of the call.
    for (const reason of ['used', 'invalid', 'unknown'] as const) expect(await refused(reason)).not.toHaveProperty('settled');
  });
});

describe('what a stored result says of its approval', () => {
  const at = new Date('2026-10-03T14:08:24.000Z');

  it('approved and run once, said first in the result', () => {
    const marker = approvalMarker('approved', true, at);
    expect(marker).toEqual({
      decided: 'approved',
      by: 'user',
      at: '2026-10-03T14:08:24.000Z',
      ran: true,
      summary: 'Approved by the user on the approval card, and run once.',
    });
    const marked = markedResult(JSON.stringify({ result: { version: 4 } }), marker);
    expect(JSON.parse(marked)).toEqual({ approval: marker, result: { version: 4 } });
    expect(marked.indexOf('"approval"')).toBe(1);
  });

  it('approved and refused when it ran', () => {
    expect(approvalMarker('approved', false, at)).toMatchObject({
      decided: 'approved',
      by: 'user',
      ran: false,
      summary: 'Approved by the user on the approval card, but it did not run.',
    });
  });

  it('keeps a result that is not an object beside the marker', () => {
    const marker = approvalMarker('approved', true, at);
    expect(JSON.parse(markedResult('Bought 5 ACME.', marker))).toEqual({ approval: marker, result: 'Bought 5 ACME.' });
    expect(JSON.parse(markedResult('[1,2]', marker))).toEqual({ approval: marker, result: [1, 2] });
  });

  it('declined, and expired: not run, and nobody decided an expiry', () => {
    const declined = JSON.parse(notRunResult(approvalMarker('declined', false, at)));
    expect(declined).toEqual({
      approval: { decided: 'declined', by: 'user', at: at.toISOString(), ran: false, summary: 'Declined by the user on the approval card. It was not run.' },
      success: false,
      notRun: true,
      message: 'Declined by the user on the approval card. It was not run. Do not run it again unless the user asks for it again.',
    });
    const expired = JSON.parse(notRunResult(approvalMarker('expired', false, at)));
    expect(expired.approval).toEqual({ decided: 'expired', at: at.toISOString(), ran: false, summary: 'The approval expired before it was used. It was not run.' });
    expect(expired).toMatchObject({ success: false, notRun: true });
  });
});

describe('the turn payload', () => {
  const base = { turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: '' };
  it('accepts a token to redeem or a decline, and refuses anything else', () => {
    expect(payloadRefusal({ ...base, approval: { approvalId: 'x', decision: 'approve', token: 'tok' } })).toBeNull();
    expect(payloadRefusal({ ...base, approval: { approvalId: 'x', decision: 'decline' } })).toBeNull();
    expect(payloadRefusal({ ...base, approval: { approvalId: 'x', decision: 'approve' } })).toMatch(/token/);
    expect(payloadRefusal({ ...base, approval: { approvalId: 'x', decision: 'yes' } })).toMatch(/decision/);
    expect(payloadRefusal({ ...base, approval: { decision: 'decline' } })).toMatch(/approvalId/);
  });
});

describe('the HTTP store client', () => {
  it('rejects when the store did not keep an approval, so the call never waits on it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 409 }));
    try {
      const client = createHttpApprovalStoreClient({ url: 'http://store.test', apiKey: 'k' });
      await expect(client.create({ approvalId: 'a' } as never)).rejects.toThrow(/did not keep approval a: HTTP 409 nope/);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ reason: 'used', error: 'used up' }), { status: 410 }));
      expect(await client.redeem('tok', { userId: 'u', conversationId: 'c' })).toEqual({ ok: false, reason: 'used', error: 'used up' });
      fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
      await expect(client.redeem('tok', { userId: 'u', conversationId: 'c' })).rejects.toThrow(/HTTP 503/);
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
      expect(await client.status('a', 'u')).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('without an approval store', () => {
  it('refuses a call that needs approval, never runs it, and the turn goes on so the model can say so', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const destroy = tool({ name: 'folder_delete', title: 'Delete a folder', destructive: true, execute });
    const m = respondingOpenAI((_r, i) =>
      i === 0 ? { toolCalls: [{ id: 'c1', name: 'folder_delete', args: {} }] } : i === 1 ? { text: 'I could not delete it.' } : undefined,
    );
    const events: string[] = [];
    const result = await runAgentTurn(
      {
        tools: createToolRegistry([destroy]),
        emit: { emit: async (_room, event) => void events.push(event) },
        systemPrompt: 'test',
        model: m.model,
      },
      { turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'delete it' },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events).not.toContain('agent:approval_required');
    expect(m.requests).toHaveLength(2);
    expect(JSON.stringify(m.requests[1])).toContain('which could not be asked for');
    expect(result.stopReason).toBe('complete');
  });
});
