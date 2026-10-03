/**
 * A generated API tool's irreversible operation runs only on the user's approval
 * of that exact call (ADR-0228 §2.1: "generated API tools (their effect comes from
 * the operation's `x-agent`)"), end to end: the W7 fixture's realtime server on
 * real Redis and a browser tab that clicks the approval card, the worker, and the
 * Desk API, which places the order as the user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SOCKET_EVENTS, type ApprovalRequiredEvent } from '@ouispec/agent-core';
import { loadOpenApiTools } from '../openapi/index.js';
import { deskAgentHeaders, deskEvents, startDeskApi, type DeskApi } from '../testing/index.js';
import { FIXTURE_TURN, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { FixtureConversation, runFixtureTurn } from './support/fixture-turn.js';
import { respondingOpenAI } from './support/replay.js';

let product: FixtureProduct;
let api: DeskApi;
beforeAll(async () => {
  [product, api] = await Promise.all([startFixtureProduct(), startDeskApi()]);
}, 20_000);
afterAll(async () => {
  await Promise.all([product?.stop(), api?.close()]);
});

const order = { symbol: 'ACME', side: 'buy', quantity: 5 };

describe('a generated transaction', () => {
  it('previews from its operation, waits for the click, then places exactly the approved order as the user', async () => {
    const tools = loadOpenApiTools(api.document, { baseUrl: api.baseUrl, actAs: deskAgentHeaders, audience: 'agents', events: deskEvents });
    const conversation = new FixtureConversation();
    const placed = () => api.requests.filter((r) => r.method === 'POST' && r.path === '/v1/orders');

    // ── Turn 1: the model places the order; the turn stops at the preview ──
    const m1 = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ id: 'call_order_1', name: 'placeOrder', args: order }] } : undefined));
    const t1 = await runFixtureTurn(product, {
      adapter: 'container',
      model: m1.model,
      turnId: 'oa-appr-1',
      conversation,
      tools,
      payload: { content: 'Buy 5 ACME' },
    });
    expect(t1.outcome.status).toBe('completed');
    const [preview] = t1.tab
      .turnEvents('oa-appr-1')
      .filter((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED)
      .map((e) => e.data as ApprovalRequiredEvent);
    expect(preview).toMatchObject({
      approvalId: 'call_order_1',
      tool: 'placeOrder',
      effect: 'transaction',
      preview: {
        title: 'Place an order',
        consequence: 'Sends a live order to the exchange.',
        arguments: [
          { name: 'symbol', value: 'ACME' },
          { name: 'side', value: 'buy' },
          { name: 'quantity', value: '5' },
        ],
      },
    });
    expect(placed()).toEqual([]);

    // ── The click, then the continuation turn runs the stored call ─────────
    const click = await t1.tab.decide('call_order_1', 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error(`the approval was refused: ${JSON.stringify(click)}`);
    const m2 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'Bought 5 ACME.' } : undefined));
    const t2 = await runFixtureTurn(product, {
      adapter: 'container',
      model: m2.model,
      turnId: 'oa-appr-2',
      tab: t1.tab,
      conversation,
      tools,
      payload: { content: '', approval: { approvalId: 'call_order_1', decision: 'approve', token: click.token } },
    });
    expect(t2.outcome.status).toBe('completed');

    // The API placed exactly the approved order, once, for the user.
    expect(placed()).toEqual([
      expect.objectContaining({ caller: FIXTURE_TURN.userId, body: order, headers: expect.objectContaining({ 'x-desk-agent': expect.any(String) }) }),
    ]);
    // The model reads the API's answer: the order it placed.
    expect(JSON.parse(t2.persisted[0].messages[0].content!)).toEqual({
      // And that the user approved it and it ran once, for this turn and every later one.
      approval: {
        decided: 'approved',
        by: 'user',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        ran: true,
        summary: 'Approved by the user on the approval card, and run once.',
      },
      id: expect.stringMatching(/^o-\d+$/),
      symbol: 'ACME',
      side: 'buy',
      quantity: 5,
      limitPrice: null,
      status: 'open',
    });
  });

  it('still never runs one without an approval', async () => {
    const [place] = loadOpenApiTools(api.document, { baseUrl: api.baseUrl, actAs: deskAgentHeaders, audience: 'agents', events: deskEvents }).filter(
      (t) => t.name === 'placeOrder',
    );
    const before = api.requests.length;
    const result = await place!.execute(order, { userId: 'ana', accountId: 'desk-1', turnId: 't', conversationId: 'c' });
    expect(result).toMatchObject({ success: false, data: { code: 'APPROVAL_REQUIRED' } });
    expect(api.requests.length).toBe(before);
  });
});
