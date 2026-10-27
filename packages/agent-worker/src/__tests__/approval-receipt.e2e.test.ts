/**
 * The approved call carries its receipt to the tool's own API, end to end:
 * the fixture product's realtime server on real Redis with receipt keys, a
 * browser tab that clicks the approval card, the worker on both adapters, and
 * the Desk API, which verifies the receipt with agent-core's own verifier
 * against the keys the realtime server publishes, as a product's API would.
 *
 * - A generated API tool's approved call sends `OUI-Approval-Receipt`; another
 *   call in the same turn does not.
 * - A host tool gets it on `ctx.approval.receipt`, for its declared
 *   `approvalAudience`, or the product's own origin when it names none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVAL_RECEIPT_HEADER, argsHash, verifyApprovalReceipt, type ApprovalReceiptClaims } from '@ouispec/agent-core';
import { loadOpenApiTools } from '../openapi/index.js';
import { deskAgentHeaders, deskEvents, startDeskApi, type DeskApi } from '../testing/index.js';
import type { RegisteredTool, ToolExecutionContext } from '../tools/types.js';
import { FIXTURE_TURN, PRODUCT_API_ORIGIN, RECEIPT_ISSUER, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { FixtureConversation, runFixtureTurn, type HostAdapter } from './support/fixture-turn.js';
import { respondingOpenAI } from './support/replay.js';

let product: FixtureProduct;
let api: DeskApi;
beforeAll(async () => {
  [product, api] = await Promise.all([startFixtureProduct(), startDeskApi()]);
}, 20_000);
afterAll(async () => {
  await Promise.all([product?.stop(), api?.close()]);
});

const receiptHeader = APPROVAL_RECEIPT_HEADER.toLowerCase();

/** The receipt as the tool's API checks it: the published keys, the hash of what it received, its own origin. */
const verify = async (receipt: string, args: Record<string, unknown>, audience: string) =>
  verifyApprovalReceipt(receipt, { jwks: product.receiptJwksUrl, expectedArgsHash: await argsHash(args), audience });

describe.each(['container', 'lambda'] as const)('a generated API tool’s approved call (%s)', (adapter: HostAdapter) => {
  it('reaches the API with a receipt it verifies; the turn’s other call carries none', async () => {
    const tools = loadOpenApiTools(api.document, { baseUrl: api.baseUrl, actAs: deskAgentHeaders, audience: 'agents', events: deskEvents });
    const conversation = new FixtureConversation();
    const order = { symbol: 'ACME', side: 'buy', quantity: adapter === 'container' ? 5 : 7 };
    const callId = `call_receipt_order_${adapter}`;
    const requestsBefore = api.requests.length;

    const m1 = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ id: callId, name: 'placeOrder', args: order }] } : undefined));
    const t1 = await runFixtureTurn(product, { adapter, model: m1.model, turnId: `rc-oa-${adapter}-1`, conversation, tools, payload: { content: 'Buy ACME' } });
    expect(t1.outcome.status).toBe('completed');
    const click = await t1.tab.decide(callId, 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error(`the approval was refused: ${JSON.stringify(click)}`);

    // The continuation runs the approved order, then the model reads the order book in the same turn.
    const m2 = respondingOpenAI((_req, i) =>
      i === 0 ? { toolCalls: [{ id: `call_receipt_list_${adapter}`, name: 'listOrders', args: {} }] } : i === 1 ? { text: 'Bought.' } : undefined,
    );
    const t2 = await runFixtureTurn(product, {
      adapter,
      model: m2.model,
      turnId: `rc-oa-${adapter}-2`,
      tab: t1.tab,
      conversation,
      tools,
      payload: { content: '', approval: { approvalId: callId, decision: 'approve', token: click.token } },
    });
    expect(t2.outcome.status).toBe('completed');

    const sent = api.requests.slice(requestsBefore);
    const placed = sent.filter((r) => r.method === 'POST' && r.path === '/v1/orders');
    const listed = sent.filter((r) => r.method === 'GET' && r.path === '/v1/orders');
    expect(placed).toHaveLength(1);
    expect(listed).toHaveLength(1);
    expect(listed[0].headers).not.toHaveProperty(receiptHeader);

    const receipt = placed[0].headers[receiptHeader];
    expect(typeof receipt).toBe('string');
    const verified = await verify(receipt, order, new URL(api.baseUrl).origin);
    if (!verified.ok) throw new Error(`the API refused the receipt: ${verified.reason} ${verified.error}`);
    expect(verified.claims).toEqual({
      iss: RECEIPT_ISSUER,
      aud: new URL(api.baseUrl).origin,
      approvalId: callId,
      argsHash: await argsHash(order),
      tool: 'placeOrder',
      operationId: 'placeOrder',
      conversationId: FIXTURE_TURN.conversationId,
      userId: FIXTURE_TURN.userId,
      accountId: FIXTURE_TURN.accountId,
      channel: 'ui',
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.any(String),
    } satisfies Record<keyof ApprovalReceiptClaims, unknown>);

    // Another API refuses it, and so does this one for another order.
    expect(await verify(receipt, order, 'https://api.elsewhere.example')).toMatchObject({ ok: false, reason: 'audience' });
    expect(await verify(receipt, { ...order, quantity: 500 }, new URL(api.baseUrl).origin)).toMatchObject({ ok: false, reason: 'args' });
  }, 30_000);
});

describe('a host tool’s approved call', () => {
  /** A host tool that records the approval each call runs on. */
  function hostTool(name: string, approvalAudience?: string) {
    const seen: Array<ToolExecutionContext['approval'] | undefined> = [];
    const tool: RegisteredTool = {
      name,
      title: `Run ${name}`,
      description: 'Books a slot with the dealer.',
      effect: 'transaction',
      ...(approvalAudience ? { approvalAudience } : {}),
      inputSchema: { type: 'object', properties: { slot: { type: 'string', title: 'Slot' } }, required: ['slot'] },
      async execute(_input, ctx) {
        seen.push(ctx.approval);
        return { success: true, data: { booked: true } };
      },
    };
    return { tool, seen };
  }

  async function approveAndRun(tool: RegisteredTool, args: Record<string, unknown>, tag: string) {
    const conversation = new FixtureConversation();
    const callId = `call_receipt_${tag}`;
    const m1 = respondingOpenAI((_r, i) => (i === 0 ? { toolCalls: [{ id: callId, name: tool.name, args }] } : undefined));
    const t1 = await runFixtureTurn(product, { adapter: 'container', model: m1.model, turnId: `rc-host-${tag}-1`, conversation, tools: [tool], payload: { content: 'Book it' } });
    const click = await t1.tab.decide(callId, 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error('not approved');
    const m2 = respondingOpenAI((_r, i) => (i === 0 ? { text: 'Booked.' } : undefined));
    await runFixtureTurn(product, {
      adapter: 'container',
      model: m2.model,
      turnId: `rc-host-${tag}-2`,
      tab: t1.tab,
      conversation,
      tools: [tool],
      payload: { content: '', approval: { approvalId: callId, decision: 'approve', token: click.token } },
    });
    return callId;
  }

  it('gets the receipt on ctx.approval, for the audience the tool declares', async () => {
    const { tool, seen } = hostTool('bookings_hold', 'https://bookings.dealer.example/');
    const args = { slot: '2026-10-28T15:30:00-04:00' };
    const callId = await approveAndRun(tool, args, 'declared');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ approvalId: callId, argsHash: await argsHash(args), receipt: expect.any(String) });
    const verified = await verify(seen[0]!.receipt!, args, 'https://bookings.dealer.example');
    expect(verified).toMatchObject({ ok: true, claims: { aud: 'https://bookings.dealer.example', tool: 'bookings_hold', approvalId: callId } });
    if (verified.ok) expect(verified.claims).not.toHaveProperty('operationId');
  }, 30_000);

  it('gets one for the product’s own origin when it names no audience', async () => {
    const { tool, seen } = hostTool('crm_note');
    const args = { slot: 'tomorrow' };
    await approveAndRun(tool, args, 'default');
    expect(await verify(seen[0]!.receipt!, args, PRODUCT_API_ORIGIN)).toMatchObject({ ok: true, claims: { aud: PRODUCT_API_ORIGIN } });
  }, 30_000);

  it('is not asked for when its declared audience is not an origin, and never runs', async () => {
    const { tool, seen } = hostTool('bookings_bad', 'https://bookings.dealer.example/v1');
    const conversation = new FixtureConversation();
    const m = respondingOpenAI((_r, i) => (i === 0 ? { toolCalls: [{ id: 'call_receipt_bad', name: 'bookings_bad', args: { slot: 'x' } }] } : i === 1 ? { text: 'I could not.' } : undefined));
    const t = await runFixtureTurn(product, { adapter: 'container', model: m.model, turnId: 'rc-host-bad-1', conversation, tools: [tool], payload: { content: 'Book it' } });
    expect(t.outcome.status).toBe('completed');
    expect(seen).toEqual([]);
    expect(JSON.stringify(t.persisted)).toMatch(/approvalAudience .*is not an origin/);
  }, 30_000);
});
