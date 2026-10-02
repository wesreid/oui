import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerClientEvents } from '../client-events/chain.js';
import { createBuiltinClientEvents } from '../client-events/builtin.js';
import { createRoomTokenSigner } from '../rooms/room-token.js';
import { createOUIResultStore, type OUIResultStore } from '../oui/results.js';
import { createMemoryRedis, fixtureRelay, fixtureRoomPolicy, recordingLogger, TEST_TOKEN_SECRET } from './fixtures.js';

/**
 * Client events go through the declared chain: undeclared events are refused,
 * payloads are validated, relays are allow-listed and confined to joined
 * rooms, and identity always comes from the socket, never the payload.
 * Ported from studio-realtime `src/__tests__/socket-events.test.ts`.
 */

const logger = recordingLogger();
const tokens = createRoomTokenSigner({ secret: TEST_TOKEN_SECRET });
const signRoomToken = (userId: string, room: string) => tokens.sign(userId, room);

let store: OUIResultStore;
const events = createBuiltinClientEvents({
  roomPolicy: fixtureRoomPolicy,
  roomTokens: tokens,
  relay: fixtureRelay,
  results: () => store,
});
const ouiActionResultEvent = events.find((e) => e.name === 'oui:action:result')!;

// ─── A socket.io stand-in: one server, sockets in rooms ─────────────────────

interface Emitted {
  rooms: string[];
  event: string;
  data: unknown;
}

function createServer() {
  const emitted: Emitted[] = [];
  const io = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, data: unknown) => emitted.push({ rooms: ([] as string[]).concat(rooms), event, data }),
    }),
  };

  function connect(user: { userId: string; accountId?: string; platformAdmin?: boolean }) {
    const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    const any: Array<(event: string, ...a: unknown[]) => void> = [];
    const rooms = new Set<string>();
    const socket = {
      id: `sock-${user.userId}`,
      connected: true,
      data: { user: { ...user } },
      rooms,
      join: (r: string) => rooms.add(r),
      leave: (r: string) => rooms.delete(r),
      on: (event: string, h: (...a: unknown[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
      onAny: (h: (event: string, ...a: unknown[]) => void) => any.push(h),
      emit: vi.fn(),
      /** What the browser sends. */
      send(event: string, payload?: unknown, ack?: (r: unknown) => void) {
        for (const h of any) h(event, payload);
        for (const h of handlers.get(event) ?? []) h(payload, ack);
      },
    };
    for (const r of fixtureRoomPolicy.identityRooms(user)) rooms.add(r);
    registerClientEvents(io as never, socket as never, events, logger);
    return socket;
  }

  return { emitted, connect };
}

async function ackOf(socket: { send: (e: string, p?: unknown, ack?: (r: unknown) => void) => void }, event: string, payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve) => socket.send(event, payload, (r) => resolve(r as Record<string, unknown>)));
}

beforeEach(() => {
  logger.records.length = 0;
  const redis = createMemoryRedis();
  store = createOUIResultStore(redis.client, redis.subscriber(), logger);
});

// ─── relay ───────────────────────────────────────────────────────────────────

describe('relay', () => {
  it('refuses oui:dispatch into another account — the attack this closes', async () => {
    const server = createServer();
    const attacker = server.connect({ userId: 'u-attacker', accountId: 'acct-a' });

    const ack = await ackOf(attacker, 'relay', {
      event: 'oui:dispatch',
      data: { requestId: 'x', surfaceId: 'app-shell', actionId: 'navigate', params: { path: '/account' } },
      rooms: ['account:acct-victim'],
    });

    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toContain('may not be relayed');
    expect(server.emitted).toEqual([]);
    expect(logger.records.some((l) => l.msg === 'Client event refused' && l.data.userId === 'u-attacker')).toBe(true);
  });

  it("refuses server-originated events, even into the sender's own rooms", async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    for (const event of ['agent:token', 'agent:turn_complete', 'generation:completed', 'oui:action:result']) {
      const ack = await ackOf(user, 'relay', { event, data: {}, rooms: ['account:acct-1'] });
      expect(ack.ok, event).toBe(false);
    }
    expect(server.emitted).toEqual([]);
  });

  it('relays an allow-listed event to a room the socket has joined', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    await ackOf(user, 'subscribe', { rooms: ['avatar:av-1'], tokens: { 'avatar:av-1': signRoomToken('u1', 'avatar:av-1') } });

    const ack = await ackOf(user, 'relay', { event: 'avatar:frame-reselect', data: { event: 'uploading' }, rooms: ['avatar:av-1'] });

    expect(ack).toEqual({ ok: true });
    expect(server.emitted).toEqual([{ rooms: ['avatar:av-1'], event: 'avatar:frame-reselect', data: { event: 'uploading' } }]);
  });

  it('refuses an allow-listed event to a room the socket has not joined', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    const ack = await ackOf(user, 'relay', { event: 'avatar:frame-reselect', data: { event: 'uploading' }, rooms: ['avatar:someone-elses'] });
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toContain('not a member');
    expect(server.emitted).toEqual([]);
  });

  it('refuses an allow-listed event with the wrong room kind or bad data', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    await ackOf(user, 'subscribe', { rooms: ['avatar:av-1'], tokens: { 'avatar:av-1': signRoomToken('u1', 'avatar:av-1') } });

    const wrongRoom = await ackOf(user, 'relay', { event: 'avatar:frame-reselect', data: { event: 'uploading' }, rooms: ['account:acct-1'] });
    const badData = await ackOf(user, 'relay', { event: 'avatar:frame-reselect', data: { event: 'rm -rf', extra: 1 }, rooms: ['avatar:av-1'] });

    expect(wrongRoom.ok).toBe(false);
    expect(badData.ok).toBe(false);
    expect(server.emitted).toEqual([]);
  });

  it('rate-limits a flood', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    await ackOf(user, 'subscribe', { rooms: ['avatar:av-1'], tokens: { 'avatar:av-1': signRoomToken('u1', 'avatar:av-1') } });
    for (let i = 0; i < 50; i++) {
      user.send('relay', { event: 'avatar:frame-reselect', data: { event: 'uploading' }, rooms: ['avatar:av-1'] });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(server.emitted.length).toBeLessThanOrEqual(20);
    expect(logger.records.some((l) => l.data.reason === 'rate limit exceeded')).toBe(true);
  });

  it('refuses everything when the product declares no relayable events', async () => {
    const bare = createBuiltinClientEvents({ roomPolicy: fixtureRoomPolicy, roomTokens: tokens, relay: {}, results: () => store });
    const rooms = new Set(['avatar:av-1']);
    const handlers = new Map<string, (p: unknown, ack: (r: unknown) => void) => void>();
    const socket = {
      id: 's',
      data: { user: { userId: 'u1' } },
      rooms,
      on: (e: string, h: (p: unknown, ack: (r: unknown) => void) => void) => handlers.set(e, h),
      onAny: () => {},
    };
    registerClientEvents({ to: () => ({ emit: () => {} }) } as never, socket as never, bare, logger);
    const ack = await new Promise<Record<string, unknown>>((resolve) =>
      handlers.get('relay')!({ event: 'avatar:frame-reselect', data: { event: 'started' }, rooms: ['avatar:av-1'] }, (r) =>
        resolve(r as Record<string, unknown>),
      ),
    );
    expect(String(ack.error)).toContain('may not be relayed');
  });
});

// ─── undeclared events and payloads ─────────────────────────────────────────

describe('the chain', () => {
  it('refuses and logs an undeclared event', () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    user.send('oui:dispatch', { requestId: 'x' });
    expect(logger.records.some((l) => l.msg === 'Undeclared client event refused' && l.data.event === 'oui:dispatch')).toBe(true);
  });

  it('refuses a malformed room and an oversized payload', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    const malformed = await ackOf(user, 'subscribe', ['account:../../etc']);
    const huge = await ackOf(user, 'subscribe', { rooms: ['global'], tokens: { global: 'x'.repeat(70_000) } });
    expect(malformed.ok).toBe(false);
    expect(huge.ok).toBe(false);
    expect(String(huge.error)).toContain('larger than');
  });

  it('refuses two declarations of one event name at registration', () => {
    const server = createServer();
    expect(() =>
      registerClientEvents({} as never, { data: { user: { userId: 'u' } }, on() {}, onAny() {} } as never, [...events, events[0]], logger),
    ).toThrow(/declared twice/);
    expect(server.emitted).toEqual([]);
  });
});

// ─── subscribe / unsubscribe ─────────────────────────────────────────────────

describe('subscribe and unsubscribe', () => {
  it('applies the join policy per room, and names the denied ones', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    const token = signRoomToken('u1', 'agent:turn:t1');
    const ack = await ackOf(user, 'subscribe', {
      rooms: ['agent:turn:t1', 'agent:turn:t2', 'account:acct-2', 'fleet'],
      tokens: { 'agent:turn:t1': token },
    });
    expect(ack).toEqual({ ok: false, joined: ['agent:turn:t1'], denied: ['agent:turn:t2', 'account:acct-2', 'fleet'] });
    expect(user.rooms.has('agent:turn:t1')).toBe(true);
  });

  it('admits a resource room only with a token for this user and this room', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    for (const room of ['generation:job-1', 'avatar:av-1', 'project:mp-1', 'session:s-1']) {
      const bare = await ackOf(user, 'subscribe', [room]);
      const othersToken = await ackOf(user, 'subscribe', { rooms: [room], tokens: { [room]: signRoomToken('u2', room) } });
      const wrongRoom = await ackOf(user, 'subscribe', { rooms: [room], tokens: { [room]: signRoomToken('u1', 'avatar:other') } });
      const granted = await ackOf(user, 'subscribe', { rooms: [room], tokens: { [room]: signRoomToken('u1', room) } });
      expect([bare.ok, othersToken.ok, wrongRoom.ok, granted.ok], room).toEqual([false, false, false, true]);
    }
  });

  it('admits identity and open rooms by the policy, without a token', async () => {
    const server = createServer();
    const admin = server.connect({ userId: 'u9', accountId: 'acct-9', platformAdmin: true });
    const ack = await ackOf(admin, 'subscribe', ['fleet', 'global', 'user:u9']);
    expect(ack).toEqual({ ok: true, joined: ['fleet', 'global', 'user:u9'], denied: undefined });
  });

  it('never leaves the rooms the socket was placed in by its identity', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    await ackOf(user, 'unsubscribe', ['user:u1', 'account:acct-1']);
    expect(user.rooms.has('user:u1')).toBe(true);
    expect(user.rooms.has('account:acct-1')).toBe(true);
  });

  it('leaves any other room', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    await ackOf(user, 'subscribe', { rooms: ['project:p1'], tokens: { 'project:p1': signRoomToken('u1', 'project:p1') } });
    await ackOf(user, 'unsubscribe', 'project:p1');
    expect(user.rooms.has('project:p1')).toBe(false);
  });
});

// ─── OUI action result ───────────────────────────────────────────────────────

describe('OUI action result', () => {
  it("keeps an answer under the socket's own user, whatever the payload claims", async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });

    user.send(ouiActionResultEvent.name, { requestId: 'r1', success: true, userId: 'someone-else', timestamp: 1 });
    await new Promise((r) => setTimeout(r, 5));

    await expect(store.await('r1', 'u1', 0)).resolves.toMatchObject({ requestId: 'r1' });
    await expect(store.await('r1', 'someone-else', 0)).resolves.toBeNull();
  });

  it('refuses an answer without a requestId', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    user.send(ouiActionResultEvent.name, { success: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(logger.records.some((l) => l.msg === 'Client event refused' && String(l.data.reason).includes('requestId'))).toBe(true);
  });

  it("uses OUI's own event name", () => {
    expect(ouiActionResultEvent.name).toBe('oui:action:result');
  });

  it('acknowledges an answer it keeps, and a repeat it does not, so the tab knows it arrived', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    const answer = { requestId: 'r-ack', success: true, timestamp: 1 };
    expect(await ackOf(user, ouiActionResultEvent.name, answer)).toEqual({ ok: true, kept: true });
    expect(await ackOf(user, ouiActionResultEvent.name, answer)).toEqual({ ok: true, kept: false });
  });

  it('acknowledges an answer too large to keep as refused, with why, and keeps nothing (oui-spec §7.3.6)', async () => {
    const server = createServer();
    const user = server.connect({ userId: 'u1', accountId: 'acct-1' });
    const heavy = { requestId: 'r-big', success: true, timestamp: 1, surfaces: [{ blob: 'x'.repeat(600 * 1024) }] };
    expect(await ackOf(user, ouiActionResultEvent.name, heavy)).toEqual({
      ok: false,
      error: 'payload larger than 524288 bytes',
    });
    await expect(store.await('r-big', 'u1', 0)).resolves.toBeNull();

    // The tab's answer again, trimmed as oui-spec sends it: kept, and the outcome reaches the worker.
    const trimmed = {
      requestId: 'r-big',
      success: true,
      timestamp: 2,
      surfacesHash: 'fnv1a64:0123456789abcdef',
      delivery: { trimmed: true, reason: 'payload larger than 524288 bytes', omitted: ['surfaces', 'observations'] },
    };
    expect(await ackOf(user, ouiActionResultEvent.name, trimmed)).toEqual({ ok: true, kept: true });
    await expect(store.await('r-big', 'u1', 0)).resolves.toMatchObject({ success: true, delivery: { trimmed: true } });
    expect(
      logger.records.some(
        (l) => l.msg === 'OUI result received' && l.data.requestId === 'r-big' && Array.isArray(l.data.trimmed),
      ),
    ).toBe(true);
  });
});
