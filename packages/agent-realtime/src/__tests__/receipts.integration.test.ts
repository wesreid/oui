/**
 * Approval receipts on the real server, twice over one real Redis: the worker
 * stores a pending approval on instance B, the user's tab decides on instance
 * A, the worker redeems on B, and the receipt it gets verifies against the
 * keys A publishes, with agent-core's own verifier, as a tool would.
 *
 * Issued once, at redemption, for the audience fixed at creation; never for a
 * declined, expired or withdrawn approval, nor for a UI action. Rotation: a
 * receipt of the previous key verifies while that key is published, and is
 * refused with `key` once it is removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  APPROVAL_DECIDE_EVENT,
  APPROVAL_RECEIPT_JWKS_PATH,
  APPROVAL_RECEIPT_TTL_SEC,
  argsHash,
  verifyApprovalReceipt,
  type ApprovalDecideResult,
  type ApprovalReceiptJwks,
  type PendingApprovalInput,
} from '@ouispec/agent-core';
import { createRealtimeServer, type RealtimeServerInstance } from '../server.js';
import { generateApprovalReceiptKey, type ApprovalReceiptKey } from '../approvals/receipt.js';
import type { RealtimeServerConfig } from '../types.js';
import { startTestRedis, type TestRedis } from '../testing/index.js';
import { fixtureRoomPolicy, recordingLogger, TEST_APPROVAL_KEY, TEST_TOKEN_SECRET } from './fixtures.js';

const KEY = 'receipts-internal-key';
const ISSUER = 'https://realtime.example.com';
const PRODUCT_API = 'https://api.example.com';
const BOOKINGS_API = 'https://bookings.dealer.example:8443';
const logger = recordingLogger();
let redis: TestRedis;
let a: RealtimeServerInstance;
let b: RealtimeServerInstance;
let plain: RealtimeServerInstance;
const clients: Socket[] = [];

const previousKey = generateApprovalReceiptKey({ kid: 'receipt-previous' });
const activeKey = generateApprovalReceiptKey({ kid: 'receipt-active', active: true });

const users: Record<string, { userId: string; accountId: string }> = {
  'token-u1': { userId: 'u1', accountId: 'acct-1' },
};

async function start(receipts: boolean): Promise<RealtimeServerInstance> {
  const config: RealtimeServerConfig = {
    auth: {
      async verify(token) {
        const user = users[token];
        if (!user) throw new Error('unknown token');
        return user;
      },
    },
    roomPolicy: fixtureRoomPolicy,
    internalApiKey: KEY,
    roomTokens: { secret: TEST_TOKEN_SECRET },
    approvals: {
      signingKey: TEST_APPROVAL_KEY,
      ...(receipts ? { receiptKeys: [activeKey, previousKey], receiptIssuer: ISSUER, defaultAudience: PRODUCT_API } : {}),
    },
    redis: redis.config,
    corsOrigins: ['http://localhost'],
    port: 0,
    logger,
  };
  return createRealtimeServer(config);
}

beforeAll(async () => {
  redis = await startTestRedis();
  [a, b, plain] = await Promise.all([start(true), start(true), start(false)]);
}, 20_000);

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await Promise.all([a?.close(), b?.close(), plain?.close()]);
  await redis?.stop();
});

const url = (s: RealtimeServerInstance) => `http://127.0.0.1:${s.port}`;

async function connect(server: RealtimeServerInstance): Promise<Socket> {
  const socket = connectClient(url(server), { auth: { token: 'token-u1' }, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

async function internal(server: RealtimeServerInstance, path: string, body?: unknown) {
  const res = await fetch(`${url(server)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const decide = (socket: Socket, approvalId: string, decision: 'approve' | 'decline') =>
  new Promise<ApprovalDecideResult>((resolve) => socket.emit(APPROVAL_DECIDE_EVENT, { approvalId, decision }, resolve));

/** A booking a dealer's API takes: a generated API tool's call, as the worker stores it. */
async function pending(overrides: Partial<PendingApprovalInput> = {}): Promise<PendingApprovalInput> {
  const id = `toolu_${crypto.randomUUID().slice(0, 12)}`;
  const args = overrides.args ?? { vehicleId: 'VIN-1HGCM82633A004352', slot: '2026-10-28T15:30:00-04:00', customer: { name: 'Ana Souza', phone: '+15555550142' } };
  return {
    approvalId: id,
    toolCallId: id,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    userId: 'u1',
    accountId: 'acct-1',
    tool: 'bookings_create',
    toolKind: 'backend',
    operationId: 'bookings_create',
    audience: BOOKINGS_API,
    args,
    argsHash: await argsHash(args),
    effect: 'transaction',
    destructive: false,
    argsSensitive: true,
    expiresAt: Date.now() + 5 * 60_000,
    preview: {
      title: 'Book a test drive',
      consequence: 'Books the slot with the dealer.',
      arguments: [{ name: 'slot', label: 'Slot', value: 'Wednesday 3:30 pm' }],
      readback: 'Book a test drive on Wednesday at 3:30 pm.',
    },
    ...overrides,
  };
}

async function stored(overrides: Partial<PendingApprovalInput> = {}) {
  const p = await pending(overrides);
  const res = await internal(b, '/internal/approvals', p);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return p;
}

async function approved(overrides: Partial<PendingApprovalInput> = {}) {
  const p = await stored(overrides);
  const result = await decide(await connect(a), p.approvalId, 'approve');
  if (!result.ok || result.decision !== 'approve') throw new Error('not approved');
  return { p, token: result.token };
}

const redeem = (server: RealtimeServerInstance, token: string) =>
  internal(server, '/internal/approvals/redeem', { token, userId: 'u1', conversationId: 'conv-1' });

async function publishedKeys(server: RealtimeServerInstance): Promise<ApprovalReceiptJwks> {
  const res = await fetch(`${url(server)}${APPROVAL_RECEIPT_JWKS_PATH}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ApprovalReceiptJwks;
}

const headerOf = (jws: string) => JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;

describe('a redeemed approval carries a receipt the tool verifies', () => {
  it('issues one at redemption whose claims are the stored call, verified against the published keys; a replay gets neither call nor receipt', async () => {
    const { p, token } = await approved();
    const before = Math.floor(Date.now() / 1000);
    const first = await redeem(b, token);
    expect(first.status).toBe(200);
    expect(first.body.call).toMatchObject({ approvalId: p.approvalId, args: p.args, argsHash: p.argsHash, channel: 'ui' });
    const receipt = first.body.receipt as string;
    expect(typeof receipt).toBe('string');
    expect(headerOf(receipt)).toEqual({ alg: 'EdDSA', typ: 'oui-approval-receipt+jwt', kid: 'receipt-active' });

    // As the dealer's API checks it: the keys from the server's public address, the hash of what it received, its own origin.
    const verified = await verifyApprovalReceipt(receipt, { jwks: await publishedKeys(a), expectedArgsHash: await argsHash(p.args), audience: BOOKINGS_API });
    if (!verified.ok) throw new Error(`refused: ${verified.reason} ${verified.error}`);
    expect(verified.claims).toEqual({
      iss: ISSUER,
      aud: BOOKINGS_API,
      approvalId: p.approvalId,
      argsHash: p.argsHash,
      tool: 'bookings_create',
      operationId: 'bookings_create',
      conversationId: 'conv-1',
      userId: 'u1',
      accountId: 'acct-1',
      channel: 'ui',
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(verified.claims.iat).toBeGreaterThanOrEqual(before);
    expect(verified.claims.exp - verified.claims.iat).toBe(APPROVAL_RECEIPT_TTL_SEC);

    // The log names the receipt by key and jti, never the receipt itself.
    const redeemed = logger.records.find((r) => r.msg === 'Approval redeemed' && r.data.approvalId === p.approvalId);
    expect(redeemed?.data.receipt).toEqual({ kid: 'receipt-active', jti: verified.claims.jti, audience: BOOKINGS_API, exp: verified.claims.exp });
    expect(JSON.stringify(logger.records)).not.toContain(receipt);

    for (const s of [b, a]) {
      const again = await redeem(s, token);
      expect(again.status).toBe(410);
      expect(again.body).not.toHaveProperty('receipt');
      expect(again.body).not.toHaveProperty('call');
    }
  });

  it('gives every receipt its own jti', async () => {
    const one = await redeem(b, (await approved()).token);
    const two = await redeem(b, (await approved()).token);
    const jti = async (r: typeof one) =>
      ((await verifyApprovalReceipt(r.body.receipt as string, { jwks: await publishedKeys(b), expectedArgsHash: (r.body.call as { argsHash: string }).argsHash, audience: BOOKINGS_API })) as { claims: { jti: string } }).claims.jti;
    expect(await jti(one)).not.toBe(await jti(two));
  });

  it('names how it was approved: a conversation channel’s decision says voice', async () => {
    const p = await stored();
    const decided = await internal(b, `/internal/approvals/${p.approvalId}/decide`, { userId: 'u1', decision: 'approve', channel: 'voice' });
    expect(decided.status).toBe(200);
    const res = await redeem(a, decided.body.token as string);
    const verified = await verifyApprovalReceipt(res.body.receipt as string, { jwks: await publishedKeys(b), expectedArgsHash: p.argsHash, audience: BOOKINGS_API });
    expect(verified).toMatchObject({ ok: true, claims: { channel: 'voice' } });
  });

  it('gives a host tool that names no audience the product’s own, and leaves out the claims its call has none of', async () => {
    const { p, token } = await approved({ audience: undefined, operationId: undefined, accountId: undefined, tool: 'crm_note_add' });
    const res = await redeem(b, token);
    const verified = await verifyApprovalReceipt(res.body.receipt as string, { jwks: await publishedKeys(a), expectedArgsHash: p.argsHash, audience: PRODUCT_API });
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.claims.aud).toBe(PRODUCT_API);
    expect(verified.claims.tool).toBe('crm_note_add');
    expect(verified.claims).not.toHaveProperty('operationId');
    expect(verified.claims).not.toHaveProperty('accountId');
  });
});

describe('a receipt is never issued', () => {
  it('for a UI action: the browser checks its own grant', async () => {
    const { token } = await approved({ toolKind: 'ui', audience: undefined, operationId: undefined, tool: 'orders.place' });
    const res = await redeem(b, token);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('receipt');
  });

  it('for a declined approval', async () => {
    const p = await stored();
    expect(await decide(await connect(a), p.approvalId, 'decline')).toMatchObject({ ok: true, decision: 'decline' });
    // Nothing to redeem: the decline deleted it.
    const status = await internal(b, `/internal/approvals/${p.approvalId}?userId=u1`);
    expect(status.body).toMatchObject({ status: 'declined' });
  });

  it('for an expired approval', async () => {
    const { token } = await approved({ expiresAt: Date.now() + 1_200 });
    await new Promise((r) => setTimeout(r, 1_500));
    const res = await redeem(b, token);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBe('expired');
    expect(res.body).not.toHaveProperty('receipt');
  });

  it('for an approval withdrawn before it was used (superseded by a new message, or its turn stopped)', async () => {
    for (const reason of ['superseded', 'stopped']) {
      const { p, token } = await approved();
      const withdrawn = await internal(a, `/internal/approvals/${p.approvalId}/settle`, { userId: 'u1', conversationId: 'conv-1', expire: reason });
      expect(withdrawn.body).toMatchObject({ outcome: 'withdrawn' });
      const res = await redeem(b, token);
      expect(res.status).toBe(410);
      expect(res.body).toEqual({ error: expect.any(String), reason: 'used' });
    }
  });

  it('by a server with no receipt keys: it stores no audience and answers the call alone', async () => {
    const p = await pending();
    expect((await internal(plain, '/internal/approvals', p)).status).toBe(201);
    const result = await decide(await connect(plain), p.approvalId, 'approve');
    if (!result.ok || result.decision !== 'approve') throw new Error('not approved');
    // Redeemed on a server that does hold keys: the audience was never fixed, so still no receipt.
    const res = await redeem(a, result.token);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('receipt');
    expect((await fetch(`${url(plain)}${APPROVAL_RECEIPT_JWKS_PATH}`)).status).toBe(404);
  });
});

describe('the audience is fixed when the approval is created', () => {
  it('cannot be named at redemption, and a receipt for one API is refused by another', async () => {
    const { p, token } = await approved();
    const renamed = await internal(b, '/internal/approvals/redeem', { token, userId: 'u1', conversationId: 'conv-1', audience: PRODUCT_API });
    expect(renamed.status).toBe(400);
    const res = await redeem(b, token);
    const jwks = await publishedKeys(a);
    const options = { jwks, expectedArgsHash: p.argsHash };
    expect(await verifyApprovalReceipt(res.body.receipt as string, { ...options, audience: PRODUCT_API })).toMatchObject({ ok: false, reason: 'audience' });
    expect(await verifyApprovalReceipt(res.body.receipt as string, { ...options, audience: BOOKINGS_API })).toMatchObject({ ok: true });
  });

  it('is refused when it is not an origin, and on a UI action', async () => {
    for (const audience of ['https://api.example.com/v1', 'https://api.example.com/', 'api.example.com', 'ftp://api.example.com']) {
      const res = await internal(b, '/internal/approvals', await pending({ audience }));
      expect(res.status, audience).toBe(400);
    }
    const ui = await internal(b, '/internal/approvals', await pending({ toolKind: 'ui' }));
    expect(ui.status).toBe(400);
    expect(String(ui.body.error)).toMatch(/UI action gets no receipt/);
  });

  it('a receipt for other arguments than the request carries is refused with args', async () => {
    const { p, token } = await approved();
    const res = await redeem(b, token);
    const tampered = await argsHash({ ...p.args, slot: '2026-10-29T09:00:00-04:00' });
    expect(await verifyApprovalReceipt(res.body.receipt as string, { jwks: await publishedKeys(a), expectedArgsHash: tampered, audience: BOOKINGS_API })).toMatchObject({
      ok: false,
      reason: 'args',
    });
  });
});

describe('the published keys', () => {
  it('are public, cacheable for an hour, readable from any origin, and carry no private part', async () => {
    const res = await fetch(`${url(a)}${APPROVAL_RECEIPT_JWKS_PATH}`, { headers: { origin: 'https://tools.elsewhere.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      keys: [
        { kty: 'OKP', crv: 'Ed25519', x: activeKey.x, kid: 'receipt-active', alg: 'EdDSA', use: 'sig' },
        { kty: 'OKP', crv: 'Ed25519', x: previousKey.x, kid: 'receipt-previous', alg: 'EdDSA', use: 'sig' },
      ],
    });
    expect(text).not.toContain(activeKey.d);
    expect(text).not.toContain(previousKey.d);
    expect(text).not.toContain('"active"');
  });
});

describe('rotation', () => {
  it('publishes a new key before it signs, verifies the previous key’s receipts while it is published, and refuses them with key once it is removed', async () => {
    const newKey = generateApprovalReceiptKey({ kid: 'receipt-next' });
    const old = { ...activeKey, active: false };
    const rotate = (keys: ApprovalReceiptKey[]) => [a, b].forEach((s) => s.setReceiptKeys(keys));
    try {
      // 1. Added, published, not yet active: receipts still name the old key.
      rotate([activeKey, previousKey, newKey]);
      expect((await publishedKeys(a)).keys.map((k) => k.kid)).toEqual(['receipt-active', 'receipt-previous', 'receipt-next']);
      const { p: before, token: beforeToken } = await approved();
      const oldReceipt = (await redeem(b, beforeToken)).body.receipt as string;
      expect(headerOf(oldReceipt).kid).toBe('receipt-active');

      // 2. The new key signs; the old one is still published, and its receipt still verifies.
      rotate([{ ...newKey, active: true }, old]);
      const { p: after, token: afterToken } = await approved();
      const newReceipt = (await redeem(b, afterToken)).body.receipt as string;
      expect(headerOf(newReceipt).kid).toBe('receipt-next');
      const during = await publishedKeys(a);
      expect(await verifyApprovalReceipt(oldReceipt, { jwks: during, expectedArgsHash: before.argsHash, audience: BOOKINGS_API })).toMatchObject({ ok: true });
      expect(await verifyApprovalReceipt(newReceipt, { jwks: during, expectedArgsHash: after.argsHash, audience: BOOKINGS_API })).toMatchObject({ ok: true });

      // 3. The old key removed: its receipts are refused with key.
      rotate([{ ...newKey, active: true }]);
      const afterRemoval = await publishedKeys(b);
      expect(afterRemoval.keys.map((k) => k.kid)).toEqual(['receipt-next']);
      expect(await verifyApprovalReceipt(oldReceipt, { jwks: afterRemoval, expectedArgsHash: before.argsHash, audience: BOOKINGS_API })).toMatchObject({
        ok: false,
        reason: 'key',
      });
    } finally {
      rotate([activeKey, previousKey]);
    }
  });

  it('keeps the keys in use when a replacement is not a key set', async () => {
    expect(() => a.setReceiptKeys([previousKey])).toThrow(/exactly one key must be active/);
    expect(() => a.setReceiptKeys([{ ...activeKey, x: previousKey.x }])).toThrow(/not its private key/);
    expect(a.receipts?.activeKid()).toBe('receipt-active');
    expect(() => plain.setReceiptKeys([activeKey])).toThrow(/without approvals\.receiptKeys/);
  });
});
