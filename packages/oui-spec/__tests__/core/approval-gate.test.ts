/**
 * An irreversible action runs only on an approval the user gave, bound to the
 * request (the browser half of the agent runtime's approval flow).
 *
 * An action whose effect is `transaction`, or one marked `confirm`
 * (destructive), runs only when the request carries `approval` matching a
 * grant this tab received from the user's own approval (their click, or a
 * grant it claimed when they approved by voice): unused, unexpired, and for
 * exactly these params. Anything else is refused and answered
 * `APPROVAL_REQUIRED`, even during a turn the `accept` gate admits; a request
 * carrying an approval this tab was never given is another tab's, refused on
 * its receipt and never answered. A replayed grant is refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime } from '../../src/core/surface-runtime.js';
import { defineSurface } from '../../src/core/define-surface.js';
import { argsHash, requiresApproval } from '../../src/spec/approval.js';
import type { OUIActionRequest, OUIActionResult } from '../../src/spec/types.js';
import { createMockSocket, wait } from '../helpers/mock-socket.js';

const FAST = { quietMs: 10, timeoutMs: 300 };

function trading(placed: Array<Record<string, unknown>>, deleted: string[] = []) {
  return defineSurface({
    id: 'orders',
    name: 'Orders',
    description: 'Place and cancel orders',
    actions: [
      {
        id: 'orders_place',
        title: 'Place an order',
        description: 'Sends an order to the exchange.',
        effect: 'transaction',
        input: { type: 'object', properties: { symbol: { type: 'string' }, quantity: { type: 'number' } }, required: ['symbol', 'quantity'] },
        handler: async (params) => {
          placed.push(params);
          return { success: true, data: { placed: true } };
        },
      },
      {
        id: 'orders_delete_draft',
        description: 'Deletes a draft for good.',
        confirm: true,
        input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: async (params) => {
          deleted.push(params.id as string);
          return { success: true };
        },
      },
      {
        id: 'orders_filter',
        description: 'Filters the list.',
        effect: 'view',
        input: { type: 'object', properties: { q: { type: 'string' } } },
        handler: async () => ({ success: true }),
      },
    ],
  });
}

const order = { symbol: 'ACME', quantity: 100 };
let n = 0;
const req = (actionId: string, params: Record<string, unknown>, approval?: OUIActionRequest['approval']): OUIActionRequest => ({
  requestId: `r${++n}`,
  surfaceId: 'orders',
  actionId,
  params,
  timestamp: Date.now(),
  ...(approval ? { approval } : {}),
});

describe('requiresApproval', () => {
  it('is a transaction always, and a destructive write; never a read', () => {
    expect(requiresApproval('transaction')).toBe(true);
    expect(requiresApproval('transaction', false)).toBe(true);
    expect(requiresApproval(undefined, true)).toBe(true);
    expect(requiresApproval('mutate', true)).toBe(true);
    expect(requiresApproval('view', true)).toBe(false);
    expect(requiresApproval('edit')).toBe(false);
    expect(requiresApproval(undefined)).toBe(false);
  });
});

describe('the manifest', () => {
  it('carries each action’s title and effect, so the agent runtime knows what needs approval', () => {
    const m = trading([]).toManifest();
    expect(m.actions.find(a => a.id === 'orders_place')).toMatchObject({ title: 'Place an order', effect: 'transaction' });
    expect(m.actions.find(a => a.id === 'orders_delete_draft')).toMatchObject({ confirm: true });
  });
});

describe('the approval gate', () => {
  it('refuses a transaction with no approval, answering APPROVAL_REQUIRED, and never runs it', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(trading(placed), () => ({}));
    const result = await runtime.execute(req('orders_place', order));
    expect(result).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(placed).toEqual([]);
  });

  it('runs it once on this tab’s grant for exactly these params, and refuses a replay', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(trading(placed), () => ({}));
    const hash = await argsHash(order);
    runtime.grantApproval({ approvalId: 'call_1', argsHash: hash, expiresAt: Date.now() + 60_000 });

    const ran = await runtime.execute(req('orders_place', order, { approvalId: 'call_1', argsHash: hash }));
    expect(ran).toMatchObject({ success: true, data: { placed: true } });
    expect(placed).toEqual([order]);

    // The same approval again, under a new request id: the grant is used.
    const replay = await runtime.execute(req('orders_place', order, { approvalId: 'call_1', argsHash: hash }));
    expect(replay).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(placed).toHaveLength(1);
  });

  it('refuses other params under a granted approval, a hash the grant does not hold, an unknown approval and an expired one', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(trading(placed), () => ({}));
    const hash = await argsHash(order);
    runtime.grantApproval({ approvalId: 'call_2', argsHash: hash, expiresAt: Date.now() + 60_000 });
    runtime.grantApproval({ approvalId: 'call_old', argsHash: hash, expiresAt: Date.now() - 1 });

    const cases: Array<[string, OUIActionRequest]> = [
      ['other params, the approved hash claimed', req('orders_place', { ...order, quantity: 10_000 }, { approvalId: 'call_2', argsHash: hash })],
      ['other params, their own hash', req('orders_place', { ...order, quantity: 10_000 }, { approvalId: 'call_2', argsHash: await argsHash({ ...order, quantity: 10_000 }) })],
      ['no such grant', req('orders_place', order, { approvalId: 'call_never', argsHash: hash })],
      ['an expired grant', req('orders_place', order, { approvalId: 'call_old', argsHash: hash })],
    ];
    for (const [what, r] of cases) {
      expect(await runtime.execute(r), what).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    }
    expect(placed).toEqual([]);
    // A refused attempt does not use up the grant.
    expect(await runtime.execute(req('orders_place', order, { approvalId: 'call_2', argsHash: hash }))).toMatchObject({ success: true });
  });

  it('guards a destructive action the same way, and leaves every other action alone', async () => {
    const deleted: string[] = [];
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(trading([], deleted), () => ({}));
    expect(await runtime.execute(req('orders_delete_draft', { id: 'd1' }))).toMatchObject({ error: { code: 'APPROVAL_REQUIRED' } });
    expect(await runtime.execute(req('orders_filter', { q: 'x' }))).toMatchObject({ success: true });
    const hash = await argsHash({ id: 'd1' });
    runtime.grantApproval({ approvalId: 'call_d', argsHash: hash, expiresAt: Date.now() + 60_000 });
    expect(await runtime.execute(req('orders_delete_draft', { id: 'd1' }, { approvalId: 'call_d', argsHash: hash }))).toMatchObject({ success: true });
    expect(deleted).toEqual(['d1']);
  });

  it('refuses on its receipt, and neither runs nor answers, a request carrying an approval this tab was never given: it is another tab’s', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const socket = createMockSocket();
    const accept = vi.fn(() => true);
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST, accept });
    runtime.mount(trading(placed), () => ({}));
    const receipts: unknown[] = [];
    socket.receiveWithAck('oui:dispatch', req('orders_place', order, { approvalId: 'call_forged', argsHash: await argsHash(order) }), (r) => receipts.push(r));
    await wait(80);
    expect(receipts).toEqual([{ ok: false, reason: expect.stringContaining('not given the approval') }]);
    expect(accept).not.toHaveBeenCalled();
    expect(placed).toEqual([]);
    expect(socket.emitted.filter(e => e.event === 'oui:action:result')).toEqual([]);
  });

  it('answers APPROVAL_REQUIRED, during a turn the accept gate admits, a request under an approval this tab was given but for other params', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const socket = createMockSocket();
    const accept = vi.fn(() => true);
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST, accept });
    runtime.mount(trading(placed), () => ({}));
    const hash = await argsHash(order);
    expect(runtime.grantApproval({ approvalId: 'call_mine', argsHash: hash, expiresAt: Date.now() + 60_000 })).toBe(true);
    const receipts: unknown[] = [];
    socket.receiveWithAck('oui:dispatch', req('orders_place', { ...order, quantity: 9 }, { approvalId: 'call_mine', argsHash: hash }), (r) => receipts.push(r));
    await wait(80);
    expect(receipts).toEqual([{ ok: true }]);
    expect(accept).toHaveBeenCalled();
    expect(placed).toEqual([]);
    const answers = socket.emitted.filter(e => e.event === 'oui:action:result').map(e => e.data as OUIActionResult);
    expect(answers).toEqual([expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'APPROVAL_REQUIRED' }) })]);
  });

  it('refuses a replayed grant: one it holds, one it has used, and one already expired; a replay never admits a second request', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(trading(placed), () => ({}));
    const hash = await argsHash(order);
    const grant = { approvalId: 'call_once', argsHash: hash, expiresAt: Date.now() + 60_000 };
    expect(runtime.grantApproval(grant)).toBe(true);
    expect(runtime.grantApproval({ ...grant })).toBe(false);
    expect(await runtime.execute(req('orders_place', order, { approvalId: 'call_once', argsHash: hash }))).toMatchObject({ success: true });
    // Pushed again after it ran: refused, so the same approval cannot run twice.
    expect(runtime.grantApproval({ ...grant, expiresAt: Date.now() + 120_000 })).toBe(false);
    expect(await runtime.execute(req('orders_place', order, { approvalId: 'call_once', argsHash: hash }))).toMatchObject({ error: { code: 'APPROVAL_REQUIRED' } });
    expect(runtime.grantApproval({ approvalId: 'call_stale', argsHash: hash, expiresAt: Date.now() - 1 })).toBe(false);
    expect(placed).toEqual([order]);
  });

  it('two tabs on one conversation: only the tab that holds the grant accepts the request, runs it once and answers it', async () => {
    const placedA: Array<Record<string, unknown>> = [];
    const placedB: Array<Record<string, unknown>> = [];
    const socketA = createMockSocket();
    const socketB = createMockSocket();
    const tabA = createSurfaceRuntime({ socket: socketA, announce: false, settle: FAST });
    const tabB = createSurfaceRuntime({ socket: socketB, announce: false, settle: FAST });
    tabA.mount(trading(placedA), () => ({}));
    tabB.mount(trading(placedB), () => ({}));
    const hash = await argsHash(order);
    expect(tabA.grantApproval({ approvalId: 'call_shared', argsHash: hash, expiresAt: Date.now() + 60_000 })).toBe(true);
    const request = req('orders_place', order, { approvalId: 'call_shared', argsHash: hash });
    const receipts: Record<string, unknown[]> = { a: [], b: [] };
    socketA.receiveWithAck('oui:dispatch', request, (r) => receipts.a.push(r));
    socketB.receiveWithAck('oui:dispatch', request, (r) => receipts.b.push(r));
    await wait(80);
    expect(receipts).toEqual({ a: [{ ok: true }], b: [{ ok: false, reason: expect.any(String) }] });
    expect(placedA).toEqual([order]);
    expect(placedB).toEqual([]);
    expect(socketB.emitted.filter(e => e.event === 'oui:action:result')).toEqual([]);
    expect(socketA.emitted.filter(e => e.event === 'oui:action:result').map(e => (e.data as OUIActionResult).success)).toEqual([true]);
  });

  it('carries the approval on a dispatch through the transport', async () => {
    const placed: Array<Record<string, unknown>> = [];
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
    runtime.mount(trading(placed), () => ({}));
    const hash = await argsHash(order);
    runtime.grantApproval({ approvalId: 'call_wire', argsHash: hash, expiresAt: Date.now() + 60_000 });
    socket.receive('oui:dispatch', req('orders_place', order, { approvalId: 'call_wire', argsHash: hash }));
    await wait(80);
    expect(placed).toEqual([order]);
  });
});
