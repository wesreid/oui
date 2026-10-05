/**
 * The approval store (ADR-0228 §2.3–2.4), on the real server twice over one
 * real Redis: the worker stores a pending approval on instance B, the user's
 * tab decides on instance A, the worker redeems on B.
 *
 * §5.3: a replayed, expired, re-signed or cross-user token is refused by
 * `redeem`. §5.2 (store half): a token whose args hash is not the stored
 * call's is refused. §5.6 (store half): declining deletes the pending
 * approval.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  APPROVAL_DECIDE_EVENT,
  argsHash,
  type ApprovalDecideResult,
  type PendingApprovalInput,
} from '@ouispec/agent-core';
import { createRealtimeServer, type RealtimeServerInstance } from '../server.js';
import { Redis } from 'ioredis';
import { createApprovalTokenSigner } from '../approvals/token.js';
import { createApprovalStore } from '../approvals/store.js';
import type { RealtimeServerConfig } from '../types.js';
import { startTestRedis, type TestRedis } from '../testing/index.js';
import { fixtureRoomPolicy, recordingLogger, TEST_APPROVAL_KEY, TEST_TOKEN_SECRET } from './fixtures.js';

const KEY = 'approvals-internal-key';
const logger = recordingLogger();
let redis: TestRedis;
let a: RealtimeServerInstance;
let b: RealtimeServerInstance;
const clients: Socket[] = [];

const users: Record<string, { userId: string; accountId: string }> = {
  'token-u1': { userId: 'u1', accountId: 'acct-1' },
  'token-u2': { userId: 'u2', accountId: 'acct-2' },
};

async function start(): Promise<RealtimeServerInstance> {
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
    approvals: { signingKey: TEST_APPROVAL_KEY },
    redis: redis.config,
    corsOrigins: ['http://localhost'],
    port: 0,
    logger,
  };
  return createRealtimeServer(config);
}

beforeAll(async () => {
  redis = await startTestRedis();
  [a, b] = await Promise.all([start(), start()]);
}, 20_000);

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await Promise.all([a?.close(), b?.close()]);
  await redis?.stop();
});

const url = (s: RealtimeServerInstance) => `http://127.0.0.1:${s.port}`;

async function connect(server: RealtimeServerInstance, token: string): Promise<Socket & { seen: string[] }> {
  const socket = connectClient(url(server), { auth: { token }, transports: ['websocket'], reconnection: false }) as Socket & {
    seen: string[];
  };
  socket.seen = [];
  socket.onAny((event: string, data: unknown) => socket.seen.push(`${event} ${JSON.stringify(data)}`));
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

async function internal(server: RealtimeServerInstance, path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${url(server)}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-api-key': init.key ?? KEY },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const decide = (socket: Socket, approvalId: string, decision: 'approve' | 'decline') =>
  new Promise<ApprovalDecideResult>((resolve) => socket.emit(APPROVAL_DECIDE_EVENT, { approvalId, decision }, resolve));

let seq = 0;
async function pending(overrides: Partial<PendingApprovalInput> = {}): Promise<PendingApprovalInput> {
  const id = `call_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
  const args = overrides.args ?? { side: 'buy', symbol: 'ACME', quantity: 100, limitPrice: 12.34 };
  return {
    approvalId: id,
    toolCallId: id,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    userId: 'u1',
    tool: 'orders_place',
    args,
    argsHash: await argsHash(args),
    effect: 'transaction',
    destructive: false,
    argsSensitive: true,
    expiresAt: Date.now() + 5 * 60_000,
    preview: {
      title: 'Place an order',
      consequence: 'Sends the order to the exchange. It cannot be undone.',
      arguments: [
        { name: 'side', label: 'Side', value: 'buy' },
        { name: 'symbol', label: 'Symbol', value: 'ACME' },
        { name: 'quantity', label: 'Quantity', value: '100' },
        { name: 'limitPrice', label: 'Limit price', value: '12.34' },
      ],
      readback: 'Place an order: Side buy, Symbol ACME, Quantity 100, Limit price 12.34.',
    },
    ...overrides,
  };
}

async function stored(overrides: Partial<PendingApprovalInput> = {}) {
  const p = await pending(overrides);
  const res = await internal(b, '/internal/approvals', { body: p });
  expect(res.status).toBe(201);
  return p;
}

const redeem = (server: RealtimeServerInstance, token: string, userId = 'u1', conversationId = 'conv-1') =>
  internal(server, '/internal/approvals/redeem', { body: { token, userId, conversationId } });

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('a pending approval, decided on one instance and redeemed on the other', () => {
  it('issues a signed token only to the deciding socket, and redeem returns exactly the stored call, once', async () => {
    const p = await stored();
    const deciding = await connect(a, 'token-u1');
    const otherTab = await connect(a, 'token-u1');

    const result = await decide(deciding, p.approvalId, 'approve');
    expect(result).toMatchObject({ ok: true, decision: 'approve', approvalId: p.approvalId, argsHash: p.argsHash, expiresAt: p.expiresAt });
    if (!result.ok || result.decision !== 'approve') throw new Error('not approved');

    // A compact JWS, HS256, bound to the call.
    const [header] = result.token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'HS256', typ: 'JWT' });
    expect(claimsOf(result.token)).toMatchObject({
      aid: p.approvalId,
      sub: 'u1',
      cid: 'conv-1',
      tool: 'orders_place',
      ah: p.argsHash,
      eff: 'transaction',
      ch: 'ui',
      exp: Math.floor(p.expiresAt / 1000),
      jti: expect.any(String),
      iat: expect.any(Number),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(otherTab.seen.join('\n')).not.toContain(result.token);

    const first = await redeem(b, result.token);
    expect(first.status).toBe(200);
    expect(first.body.call).toEqual({
      approvalId: p.approvalId,
      toolCallId: p.toolCallId,
      conversationId: 'conv-1',
      turnId: 'turn-1',
      userId: 'u1',
      tool: 'orders_place',
      args: p.args,
      argsHash: p.argsHash,
      effect: 'transaction',
      destructive: false,
      channel: 'ui',
    });

    // Replayed, on either instance.
    for (const s of [b, a]) {
      const again = await redeem(s, result.token);
      expect(again.status).toBe(410);
      expect(again.body.reason).toBe('used');
    }
  });

  it('issues one token per approval: a second decision is refused', async () => {
    const p = await stored();
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: true });
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: false, reason: 'decided' });
  });

  it('lets only the approval’s own user decide it, and redeem only for that user and conversation', async () => {
    const p = await stored();
    const intruder = await connect(a, 'token-u2');
    expect(await decide(intruder, p.approvalId, 'approve')).toMatchObject({ ok: false, reason: 'forbidden' });

    const owner = await connect(a, 'token-u1');
    const result = await decide(owner, p.approvalId, 'approve');
    if (!result.ok || result.decision !== 'approve') throw new Error('not approved');

    const crossUser = await redeem(b, result.token, 'u2');
    expect(crossUser.status).toBe(403);
    expect(crossUser.body.reason).toBe('forbidden');
    const crossConversation = await redeem(b, result.token, 'u1', 'conv-2');
    expect(crossConversation.status).toBe(403);

    // Refusing a stranger's attempt does not use up the owner's approval.
    expect((await redeem(b, result.token)).status).toBe(200);
  });

  it('refuses a re-signed, tampered or unsigned token, and a validly signed one for other arguments', async () => {
    const p = await stored();
    const tab = await connect(a, 'token-u1');
    const result = await decide(tab, p.approvalId, 'approve');
    if (!result.ok || result.decision !== 'approve') throw new Error('not approved');
    const claims = claimsOf(result.token);

    const otherKey = createApprovalTokenSigner({ signingKey: 'another-environments-approval-key-000000' });
    const [header, , signature] = result.token.split('.');
    const forgeries = {
      'signed with another key': otherKey.sign(claims as never),
      'payload changed under the real signature': `${header}.${b64url({ ...claims, ah: 'f'.repeat(64) })}.${signature}`,
      'alg none': `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`,
      'not a token': 'garbage',
    };
    for (const [what, token] of Object.entries(forgeries)) {
      const res = await redeem(b, token);
      expect(res.status, what).toBe(403);
      expect(res.body.reason, what).toBe('invalid');
    }

    // Signed with the environment's own key, but for arguments that are not the stored call's.
    const sameKey = createApprovalTokenSigner({ signingKey: TEST_APPROVAL_KEY });
    const otherArgs = await argsHash({ ...p.args, quantity: 10_000 });
    const mismatched = await redeem(b, sameKey.sign({ ...(claims as never), ah: otherArgs }));
    expect(mismatched.status).toBe(403);
    expect(mismatched.body.reason).toBe('mismatch');

    // None of that used up the real approval.
    expect((await redeem(b, result.token)).status).toBe(200);
  });

  it('refuses an expired token, and a decision after the approval expired', async () => {
    const soon = await stored({ expiresAt: Date.now() + 1_500 });
    const late = await stored({ expiresAt: Date.now() + 1_500 });
    const tab = await connect(a, 'token-u1');
    const result = await decide(tab, soon.approvalId, 'approve');
    if (!result.ok || result.decision !== 'approve') throw new Error('not approved');

    await new Promise((r) => setTimeout(r, 1_700));
    const res = await redeem(b, result.token);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBe('expired');
    expect(await decide(tab, late.approvalId, 'approve')).toMatchObject({ ok: false });
  });
});

describe('declining', () => {
  it('deletes the pending approval: it can no longer be approved or redeemed, and its status says declined', async () => {
    const p = await stored();
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'decline')).toEqual({ ok: true, decision: 'decline', approvalId: p.approvalId });
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: false, reason: 'unknown' });

    const status = await internal(b, `/internal/approvals/${p.approvalId}?userId=u1`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ approvalId: p.approvalId, status: 'declined', tool: 'orders_place', title: 'Place an order' });
    expect((await internal(b, `/internal/approvals/${p.approvalId}?userId=u2`)).status).toBe(404);
  });
});

describe('an approval nobody decided: settled by a later turn', () => {
  const owner = { userId: 'u1', conversationId: 'conv-1' };
  const settle = (server: RealtimeServerInstance, id: string, body: Record<string, unknown> = owner) =>
    internal(server, `/internal/approvals/${id}/settle`, { body });
  /** Past an approval's expiry, on Redis's clock: its keys have lapsed. */
  const expired = async () => {
    const p = await stored({ expiresAt: Date.now() + 1_200 });
    await new Promise((r) => setTimeout(r, 1_500));
    return p;
  };

  it('says it expired undecided to two turns asking together, and gives the claim to exactly one', async () => {
    const p = await expired();
    const [first, second] = await Promise.all([settle(a, p.approvalId), settle(b, p.approvalId)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.outcome, second.body.outcome].sort()).toEqual(['already', 'claimed']);
    expect(first.body.expiresAt).toBe(p.expiresAt);
    expect(second.body.expiresAt).toBe(p.expiresAt);
    // Confirmed once stored, it stays settled: every later turn is told it expired, and stores nothing.
    expect((await settle(a, p.approvalId, { ...owner, confirm: true })).body).toEqual({ approvalId: p.approvalId, outcome: 'confirmed' });
    expect((await settle(b, p.approvalId)).body).toMatchObject({ outcome: 'already' });
  });

  it('says the user had approved it when an approved call was never run, and not that it expired undecided', async () => {
    // Approved on the card, and the turn that would have run it died: never redeemed.
    const p = await stored({ expiresAt: Date.now() + 1_200 });
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: true, decision: 'approve' });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await settle(b, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'claimed', expiresAt: p.expiresAt, decided: 'approved' });
    expect((await settle(a, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'already', expiresAt: p.expiresAt, decided: 'approved' });

    // One nobody decided carries no decision.
    const undecided = await expired();
    const answer = (await settle(a, undecided.approvalId)).body;
    expect(answer).toEqual({ approvalId: undecided.approvalId, outcome: 'claimed', expiresAt: undecided.expiresAt });
    expect(answer).not.toHaveProperty('decided');
  });

  it('keeps a confirmation that arrives with no live claim, and warns that the lease had lapsed', async () => {
    const p = await expired();
    logger.records.length = 0;
    // No turn holds a claim: this is a turn whose lease lapsed while its host was still storing.
    expect((await settle(a, p.approvalId, { ...owner, confirm: true })).body).toEqual({ approvalId: p.approvalId, outcome: 'confirmed' });
    expect(logger.records.filter((r) => r.level === 'warn' && /no live claim/.test(r.msg))).toHaveLength(1);
    expect((await settle(b, p.approvalId)).body).toMatchObject({ outcome: 'already' });
    // With a live claim there is no warning.
    const q = await expired();
    logger.records.length = 0;
    expect((await settle(a, q.approvalId)).body).toMatchObject({ outcome: 'claimed' });
    expect((await settle(a, q.approvalId, { ...owner, confirm: true })).body).toMatchObject({ outcome: 'confirmed' });
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(0);
  });

  it('leaves a pending approval, and an approved one not yet used, as open: the card is live', async () => {
    const p = await stored();
    expect((await settle(a, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'open' });
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: true });
    expect((await settle(b, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'open' });
    // And nothing was claimed by asking.
    expect((await settle(a, p.approvalId, { ...owner, confirm: true })).body).toMatchObject({ outcome: 'unknown' });
  });

  it('cannot say a redeemed approval expired: it ran, however long ago', async () => {
    const p = await stored({ expiresAt: Date.now() + 1_500 });
    const tab = await connect(a, 'token-u1');
    const approved = await decide(tab, p.approvalId, 'approve');
    if (!approved.ok || approved.decision !== 'approve') throw new Error('not approved');
    expect((await redeem(b, approved.token)).status).toBe(200);
    // At once, and after the time it would have expired at.
    expect((await settle(a, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'unknown' });
    await new Promise((r) => setTimeout(r, 1_700));
    expect((await settle(a, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'unknown' });
  });

  it('cannot say a declined approval expired', async () => {
    const p = await stored({ expiresAt: Date.now() + 1_500 });
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'decline')).toMatchObject({ ok: true });
    expect((await settle(b, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'unknown' });
    await new Promise((r) => setTimeout(r, 1_700));
    expect((await settle(b, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'unknown' });
  });

  it('lets the claim lapse when it is never confirmed, so a later turn claims again; confirmed, it does not lapse', async () => {
    // A store on the same Redis whose lease is short: a turn that claimed and then died.
    const client = new Redis({ host: redis.config.host, port: redis.config.port });
    try {
      const store = createApprovalStore(client, createApprovalTokenSigner({ signingKey: TEST_APPROVAL_KEY }), logger, { expiryClaimLeaseMs: 600 });
      const p = await expired();
      expect(await store.settleExpired(p.approvalId, owner)).toMatchObject({ outcome: 'claimed' });
      expect(await store.settleExpired(p.approvalId, owner)).toMatchObject({ outcome: 'already' });
      await new Promise((r) => setTimeout(r, 800));
      // The first turn never stored it. The next one claims, stores and confirms.
      expect(await store.settleExpired(p.approvalId, owner)).toMatchObject({ outcome: 'claimed' });
      expect(await store.confirmExpirySettled(p.approvalId, owner)).toBe(true);
      await new Promise((r) => setTimeout(r, 800));
      expect(await store.settleExpired(p.approvalId, owner)).toMatchObject({ outcome: 'already' });
    } finally {
      client.disconnect();
    }
  });

  it('answers only the approval’s own user and conversation, and only the internal key', async () => {
    const p = await expired();
    expect((await settle(a, p.approvalId, { userId: 'u2', conversationId: 'conv-1' })).body).toMatchObject({ outcome: 'unknown' });
    expect((await settle(a, p.approvalId, { userId: 'u1', conversationId: 'conv-other' })).body).toMatchObject({ outcome: 'unknown' });
    expect((await settle(a, p.approvalId, { userId: 'u2', conversationId: 'conv-1', confirm: true })).body).toMatchObject({ outcome: 'unknown' });
    expect((await settle(a, p.approvalId, { userId: 'u1' })).status).toBe(400);
    expect((await internal(a, `/internal/approvals/${p.approvalId}/settle`, { body: owner, key: 'wrong' })).status).toBe(401);
    // None of those claimed it.
    expect((await settle(a, p.approvalId)).body).toMatchObject({ outcome: 'claimed' });
  });

  it('knows nothing of an approval that was never asked for', async () => {
    expect((await settle(a, 'call_never_asked')).body).toEqual({ approvalId: 'call_never_asked', outcome: 'unknown' });
  });
});

describe('an approval withdrawn before it was used (ADR-0252 §2.6)', () => {
  const owner = { userId: 'u1', conversationId: 'conv-1' };
  const settle = (server: RealtimeServerInstance, id: string, body: Record<string, unknown> = owner) =>
    internal(server, `/internal/approvals/${id}/settle`, { body });
  const withdraw = (server: RealtimeServerInstance, id: string, reason: unknown = 'superseded', who: Record<string, unknown> = owner) =>
    settle(server, id, { ...who, expire: reason });

  it('expires a pending approval at once: the card is dead, and a later turn is told it was withdrawn, not that it timed out', async () => {
    const p = await stored();
    expect((await withdraw(b, p.approvalId)).body).toEqual({ approvalId: p.approvalId, outcome: 'withdrawn' });

    // The click that comes after finds nothing to decide.
    const tab = await connect(a, 'token-u1');
    expect(await decide(tab, p.approvalId, 'approve')).toMatchObject({ ok: false, reason: 'unknown' });
    expect((await internal(a, `/internal/approvals/${p.approvalId}?userId=u1`)).status).toBe(404);

    // Settled as any expiry is, long before its five minutes: claimed once, with why.
    const [first, second] = await Promise.all([settle(a, p.approvalId), settle(b, p.approvalId)]);
    expect([first.body.outcome, second.body.outcome].sort()).toEqual(['already', 'claimed']);
    expect(first.body).toMatchObject({ expiresAt: p.expiresAt, withdrawn: 'superseded' });
    expect(second.body).toMatchObject({ withdrawn: 'superseded' });
    expect(first.body).not.toHaveProperty('decided');
    expect((await settle(a, p.approvalId, { ...owner, confirm: true })).body).toMatchObject({ outcome: 'confirmed' });
  });

  it('expires an approved approval that was not used yet: it keeps that the user approved it, and its token answers used', async () => {
    const p = await stored();
    const tab = await connect(a, 'token-u1');
    const approved = await decide(tab, p.approvalId, 'approve');
    expect(approved).toMatchObject({ ok: true, decision: 'approve' });
    const token = (approved as { token: string }).token;

    expect((await withdraw(a, p.approvalId, 'stopped')).body).toEqual({ approvalId: p.approvalId, outcome: 'withdrawn' });

    const redeemed = await internal(b, '/internal/approvals/redeem', { body: { token, ...owner } });
    expect(redeemed.status).toBe(410);
    expect(redeemed.body).toMatchObject({ reason: 'used' });

    expect((await settle(b, p.approvalId)).body).toEqual({
      approvalId: p.approvalId,
      outcome: 'claimed',
      expiresAt: p.expiresAt,
      decided: 'approved',
      withdrawn: 'stopped',
    });
  });

  it('changes nothing that has already ended: redeemed, declined, expired or withdrawn before', async () => {
    const tab = await connect(a, 'token-u1');

    const used = await stored();
    const approved = (await decide(tab, used.approvalId, 'approve')) as { token: string };
    expect((await internal(b, '/internal/approvals/redeem', { body: { token: approved.token, ...owner } })).status).toBe(200);
    // It ran: the store has no memory of it to withdraw.
    expect((await withdraw(a, used.approvalId)).body).toMatchObject({ outcome: 'unknown' });
    expect((await settle(a, used.approvalId)).body).toMatchObject({ outcome: 'unknown' });

    const declined = await stored();
    await decide(tab, declined.approvalId, 'decline');
    expect((await withdraw(a, declined.approvalId)).body).toMatchObject({ outcome: 'unknown' });

    const twice = await stored();
    expect((await withdraw(a, twice.approvalId, 'superseded')).body).toMatchObject({ outcome: 'withdrawn' });
    // The first reason stands.
    expect((await withdraw(b, twice.approvalId, 'stopped')).body).toMatchObject({ outcome: 'settled' });
    expect((await settle(a, twice.approvalId)).body).toMatchObject({ outcome: 'claimed', withdrawn: 'superseded' });

    const timedOut = await stored({ expiresAt: Date.now() + 1_200 });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await withdraw(a, timedOut.approvalId)).body).toMatchObject({ outcome: 'settled' });
    // Its time ran out: it is not told as withdrawn.
    expect((await settle(a, timedOut.approvalId)).body).not.toHaveProperty('withdrawn');
  });

  it('with a decision arriving at the same instant, exactly one of them happens', async () => {
    const tab = await connect(a, 'token-u1');
    for (let i = 0; i < 5; i++) {
      const p = await stored();
      const [decision, withdrawal] = await Promise.all([decide(tab, p.approvalId, 'decline'), withdraw(b, p.approvalId)]);
      // Declined first: nothing was left to withdraw. Withdrawn first: nothing was left to decline.
      if (decision.ok) expect(withdrawal.body.outcome).toBe('unknown');
      else expect(withdrawal.body.outcome).toBe('withdrawn');
    }
  });

  it('withdraws only for the approval’s own user and conversation, a reason it knows, and the internal key', async () => {
    const p = await stored();
    expect((await withdraw(a, p.approvalId, 'superseded', { userId: 'u2', conversationId: 'conv-1' })).body).toMatchObject({ outcome: 'unknown' });
    expect((await withdraw(a, p.approvalId, 'superseded', { userId: 'u1', conversationId: 'conv-9' })).body).toMatchObject({ outcome: 'unknown' });
    expect((await withdraw(a, p.approvalId, 'bored')).status).toBe(400);
    expect((await internal(a, `/internal/approvals/${p.approvalId}/settle`, { body: { ...owner, expire: 'superseded' }, key: 'wrong' })).status).toBe(401);
    // Still live after all of that.
    expect((await settle(a, p.approvalId)).body).toMatchObject({ outcome: 'open' });
  });

  it('forgets an old withdrawal when the same call id asks again', async () => {
    const p = await stored();
    await withdraw(a, p.approvalId);
    const again = await internal(b, '/internal/approvals', { body: { ...p, expiresAt: Date.now() + 1_200 } });
    expect(again.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1_500));
    // This time its time ran out.
    expect((await settle(a, p.approvalId)).body).not.toHaveProperty('withdrawn');
  });
});

describe('a conversation channel deciding through the engine route', () => {
  it('issues a token for the session’s user on a voice channel, and refuses a UI decision there', async () => {
    const p = await stored();
    const ui = await internal(b, `/internal/approvals/${p.approvalId}/decide`, { body: { userId: 'u1', decision: 'approve', channel: 'ui' } });
    expect(ui.status).toBe(400);
    expect(ui.body.reason).toBe('channel');
    const wrongUser = await internal(b, `/internal/approvals/${p.approvalId}/decide`, {
      body: { userId: 'u2', decision: 'approve', channel: 'voice' },
    });
    expect(wrongUser.status).toBe(403);

    const voice = await internal(a, `/internal/approvals/${p.approvalId}/decide`, { body: { userId: 'u1', decision: 'approve', channel: 'voice' } });
    expect(voice.status).toBe(200);
    expect(claimsOf(voice.body.token as string)).toMatchObject({ ch: 'voice', sub: 'u1', aid: p.approvalId });
    const res = await redeem(b, voice.body.token as string);
    expect(res.body.call).toMatchObject({ channel: 'voice', args: p.args });
  });
});

describe('storing a pending approval', () => {
  it('requires the internal key, a hash that matches the arguments, an expiry within 30 minutes and a unique id', async () => {
    const p = await pending();
    expect((await internal(b, '/internal/approvals', { body: p, key: 'wrong' })).status).toBe(401);
    expect((await internal(b, '/internal/approvals', { body: { ...p, argsHash: 'a'.repeat(64) } })).status).toBe(400);
    expect((await internal(b, '/internal/approvals', { body: { ...p, expiresAt: Date.now() + 31 * 60_000 } })).status).toBe(400);
    expect((await internal(b, '/internal/approvals', { body: { ...p, expiresAt: Date.now() - 1 } })).status).toBe(400);
    expect((await internal(b, '/internal/approvals', { body: { ...p, userId: undefined } })).status).toBe(400);
    const created = await internal(b, '/internal/approvals', { body: p });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ approvalId: p.approvalId, argsHash: p.argsHash, expiresAt: p.expiresAt });
    expect((await internal(a, '/internal/approvals', { body: p })).status).toBe(409);
    expect((await internal(b, '/internal/approvals/redeem', { body: { token: 'x', userId: 'u1', conversationId: 'c' }, key: 'wrong' })).status).toBe(
      401,
    );
  });

  it('logs every issue, decision and redemption with the approval, user, tool, effect, channel and hash, and the arguments only when they are not sensitive', async () => {
    const secret = await stored({ args: { account: 'IBAN-SECRET-1' } });
    const open = await stored({ args: { symbol: 'OPEN-ARG' }, argsSensitive: false });
    const tab = await connect(a, 'token-u1');
    for (const p of [secret, open]) {
      const r = await decide(tab, p.approvalId, 'approve');
      if (!r.ok || r.decision !== 'approve') throw new Error('not approved');
      expect((await redeem(b, r.token)).status).toBe(200);
    }
    const records = logger.records.filter((r) => r.data.approvalId === secret.approvalId || r.data.approvalId === open.approvalId);
    for (const msg of ['Approval stored', 'Approval approved', 'Approval redeemed']) {
      const rec = records.find((r) => r.msg === msg && r.data.approvalId === secret.approvalId);
      expect(rec?.data, msg).toMatchObject({ userId: 'u1', tool: 'orders_place', effect: 'transaction', argsHash: secret.argsHash });
    }
    expect(records.find((r) => r.msg === 'Approval approved')?.data.channel).toBe('ui');
    const all = JSON.stringify(logger.records);
    expect(all).not.toContain('IBAN-SECRET-1');
    expect(all).toContain('OPEN-ARG');
    expect(all).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/); // no token is ever logged
  });
});
