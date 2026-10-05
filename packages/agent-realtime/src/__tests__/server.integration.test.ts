import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createWebSocketTransport } from 'oui-spec/transport';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { RealtimeServerInstance } from '../server.js';
import { createHarness, next, url, type Harness } from './harness.js';

/**
 * The real server, twice, on one real Redis: a browser on instance A, the
 * product's backend and worker on instance B. Everything the worker and the
 * browser rely on crosses between them: room fan-out, room tokens, the UI
 * action result store.
 */

let h: Harness;
let a: RealtimeServerInstance;
let b: RealtimeServerInstance;

beforeAll(async () => {
  h = await createHarness({
    key: 'integration-internal-key',
    users: {
      'token-u1': { userId: 'u1', accountId: 'acct-1' },
      'token-u2': { userId: 'u2', accountId: 'acct-2' },
    },
  });
  [a, b] = await Promise.all([h.start(), h.start()]);
}, 20_000);

afterAll(async () => {
  await h?.close();
});

const connect = (server: RealtimeServerInstance, token?: string): Promise<Socket> => h.connect(server, token);
const internal = (...args: Parameters<Harness['internal']>) => h.internal(...args);
const mintToken = (...args: Parameters<Harness['mintToken']>) => h.mintToken(...args);
const emit = (server: RealtimeServerInstance, event: string, data: unknown, rooms: string[]) => h.emit(server, event, data, rooms);
const subscribe = (socket: Socket, payload: unknown) => h.subscribe(socket, payload);

describe('connection', () => {
  it('refuses a socket without a token, or with one the product does not verify', async () => {
    await expect(connect(a)).rejects.toThrow(/Authentication required/);
    await expect(connect(a, 'token-nobody')).rejects.toThrow(/Authentication failed/);
  });

  it("places a socket in its identity rooms, and an event emitted on the other instance reaches it", async () => {
    const browser = await connect(a, 'token-u1');
    const received = next(browser, 'notice:hello');
    const res = await emit(b, 'notice:hello', { n: 1 }, ['user:u1']);
    expect(res.status).toBe(200);
    await expect(received).resolves.toEqual({ n: 1 });
  });
});

describe('room tokens', () => {
  it('admits a token-guarded room with a token minted by the other instance, for this user only', async () => {
    const owner = await connect(a, 'token-u1');
    const other = await connect(a, 'token-u2');
    const token = await mintToken(b, 'u1', 'project:p1');

    await expect(subscribe(owner, { rooms: ['project:p1'], tokens: { 'project:p1': token } })).resolves.toMatchObject({
      ok: true,
      joined: ['project:p1'],
    });
    await expect(subscribe(other, { rooms: ['project:p1'], tokens: { 'project:p1': token } })).resolves.toMatchObject({
      ok: false,
      denied: ['project:p1'],
    });
    await expect(subscribe(other, ['project:p1'])).resolves.toMatchObject({ ok: false });

    const received = next(owner, 'project:updated');
    await emit(b, 'project:updated', { id: 'p1' }, ['project:p1']);
    await expect(received).resolves.toEqual({ id: 'p1' });
  });

  it('mints only for rooms the policy guards with a token, and only with the internal key', async () => {
    expect((await internal(b, '/internal/room-token', { body: { userId: 'u1', room: 'user:u1' } })).status).toBe(400);
    expect((await internal(b, '/internal/room-token', { body: { userId: 'u1', room: 'nope:1' } })).status).toBe(400);
    expect((await internal(b, '/internal/room-token', { body: { room: 'project:p1' } })).status).toBe(400);
    expect((await internal(b, '/internal/room-token', { body: { userId: 'u1', room: 'project:p1' }, key: 'wrong' })).status).toBe(401);
    expect((await internal(b, '/api/emit', { body: { event: 'x', rooms: ['user:u1'] }, key: 'wrong' })).status).toBe(401);
  });
});

describe('UI actions (ADR-0209)', () => {
  it("delivers a dispatch to the turn's room and serves the browser's answer to the worker on the other instance", async () => {
    const browser = await connect(a, 'token-u1');
    const turnRoom = 'agent:turn:t-int-1';
    await subscribe(browser, { rooms: [turnRoom], tokens: { [turnRoom]: await mintToken(b, 'u1', turnRoom) } });

    // The browser answers through OUI's own transport, as a real tab does.
    const transport = createWebSocketTransport(browser);
    const seen: OUIActionRequest[] = [];
    transport.onAction((request) => {
      seen.push(request);
      transport.sendResult({ requestId: request.requestId, success: true, data: { navigatedTo: '/projects' }, timestamp: Date.now() });
    });

    // The worker waits first, on B, then the dispatch goes out through B.
    const waiting = internal(b, '/internal/oui/action-results/req-int-1?userId=u1&waitMs=5000');
    const request: OUIActionRequest = { requestId: 'req-int-1', surfaceId: 'app-shell', actionId: 'navigate', params: { path: '/projects' } };
    // The dispatch's wire name is OUI's, captured from its transport.
    let wire: { event: string; data: unknown } | null = null;
    createWebSocketTransport({
      connected: true,
      emit: (event, data) => (wire = { event, data }),
      on() {},
      off() {},
      once() {},
    }).dispatch(request);
    expect((await emit(b, wire!.event, wire!.data, [turnRoom])).status).toBe(200);

    const res = await waiting;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestId: 'req-int-1', success: true, data: { navigatedTo: '/projects' } });
    expect(seen.map((r) => r.actionId)).toEqual(['navigate']);

    // A synchronous answer is also the final one; another user never gets it.
    const final = await internal(b, '/internal/oui/action-results/req-int-1?userId=u1&final=1');
    expect(final.status).toBe(200);
    expect((await internal(b, '/internal/oui/action-results/req-int-1?userId=u2')).status).toBe(204);
    transport.dispose();
  });

  it('keeps an async action’s acknowledgment first and its completion as the final answer', async () => {
    const browser = await connect(a, 'token-u1');
    browser.emit('oui:action:result', { requestId: 'req-int-2', success: true, interim: true, data: { status: 'started' }, timestamp: 1 });
    const finalWait = internal(b, '/internal/oui/action-results/req-int-2?userId=u1&waitMs=5000&final=1');
    await new Promise((r) => setTimeout(r, 50));
    browser.emit('oui:action:result', { requestId: 'req-int-2', success: true, interim: false, data: { status: 'complete' }, timestamp: 2 });

    expect(await (await finalWait).json()).toMatchObject({ interim: false, data: { status: 'complete' } });
    expect(await (await internal(b, '/internal/oui/action-results/req-int-2?userId=u1')).json()).toMatchObject({ interim: true });
  });
});

describe('receipts of a UI action request (oui-spec §7.3.7)', () => {
  const receiptsOf = async (res: Response) => ((await res.json()) as { receipts?: unknown }).receipts;

  it('counts the tabs that received it, across instances: a worker on B, a tab on A', async () => {
    const tab = await connect(a, 'token-u1');
    tab.on('oui:dispatch', (_request: unknown, ack?: (r: unknown) => void) => ack?.({ ok: true }));
    const res = await internal(b, '/api/emit', {
      body: { event: 'oui:dispatch', data: { requestId: 'rcpt-1', surfaceId: 's', actionId: 'a', params: {} }, rooms: ['user:u1'], ackTimeoutMs: 1000 },
    });
    expect(res.status).toBe(200);
    expect(await receiptsOf(res)).toEqual({ acknowledged: 1, accepted: 1 });
    tab.disconnect();
  });

  it('counts a refusal as received but not accepted, and a tab that does not acknowledge as neither', async () => {
    const refusing = await connect(a, 'token-u1');
    refusing.on('oui:dispatch', (_r: unknown, ack?: (r: unknown) => void) => ack?.({ ok: false, reason: 'not now' }));
    const older = await connect(a, 'token-u1');
    older.on('oui:dispatch', () => {});
    const res = await internal(b, '/api/emit', {
      body: { event: 'oui:dispatch', data: { requestId: 'rcpt-2' }, rooms: ['user:u1'], ackTimeoutMs: 300 },
    });
    expect(await receiptsOf(res)).toEqual({ acknowledged: 1, accepted: 0 });
    refusing.disconnect();
    older.disconnect();
  });

  it('reports none received when the room is empty, and refuses receipts of a broadcast or past the limit', async () => {
    const empty = await internal(b, '/api/emit', { body: { event: 'oui:dispatch', data: {}, rooms: ['user:nobody'], ackTimeoutMs: 200 } });
    expect(await receiptsOf(empty)).toEqual({ acknowledged: 0, accepted: 0 });
    expect((await internal(b, '/api/emit', { body: { event: 'x', ackTimeoutMs: 200 } })).status).toBe(400);
    expect((await internal(b, '/api/emit', { body: { event: 'x', rooms: ['user:u1'], ackTimeoutMs: 60_000 } })).status).toBe(400);
  });

  it('answers without receipts when none are asked for', async () => {
    const res = await emit(b, 'notice:plain', {}, ['user:u1']);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('stopping a turn (ADR-0252)', () => {
  const stop = (socket: Socket, payload: unknown) =>
    new Promise<unknown>((resolve) => socket.emit('agent:turn_stop', payload, resolve));

  it("records the owner's stop from the turn's room, and the worker on the other instance hears it", async () => {
    const tab = await connect(a, 'token-u1');
    const room = 'agent:turn:t-stop-1';
    await subscribe(tab, { rooms: [room], tokens: { [room]: await mintToken(b, 'u1', room) } });

    // The worker's watch, open on B before the person presses Stop.
    const watching = internal(b, '/internal/turns/t-stop-1/stop?userId=u1&waitMs=5000');
    await new Promise((r) => setTimeout(r, 50));
    expect(await stop(tab, { turnId: 't-stop-1', room })).toEqual({ ok: true, stop: 'requested' });

    const heard = await watching;
    expect(heard.status).toBe(200);
    expect(await heard.json()).toMatchObject({ turnId: 't-stop-1', by: 'u1', reason: 'user_stop' });
    // Pressed again: the first stop stands.
    expect(await stop(tab, { turnId: 't-stop-1', room })).toEqual({ ok: true, stop: 'already' });
  });

  it("refuses a stop from a socket that is not in the turn's room", async () => {
    const outsider = await connect(a, 'token-u2');
    const room = 'agent:turn:t-stop-2';
    expect(await stop(outsider, { turnId: 't-stop-2', room })).toEqual({ ok: false, reason: 'not_in_turn_room' });
    // Its own identity room is one it is in, but joining it proves nothing about a turn.
    expect(await stop(outsider, { turnId: 't-stop-2', room: 'user:u2' })).toEqual({ ok: false, reason: 'not_in_turn_room' });
    expect(await stop(outsider, { turnId: 't-stop-2' })).toEqual({ ok: false, reason: 'invalid' });

    const none = await internal(b, '/internal/turns/t-stop-2/stop?userId=u1&waitMs=0');
    expect(none.status).toBe(204);
  });

  it("does not let one user's stop reach another user's turn, even from a turn room of their own", async () => {
    const other = await connect(a, 'token-u2');
    const ownRoom = 'agent:turn:t-own-u2';
    await subscribe(other, { rooms: [ownRoom], tokens: { [ownRoom]: await mintToken(b, 'u2', ownRoom) } });
    // u2 names u1's turn, from a room u2 is truly in.
    expect(await stop(other, { turnId: 't-stop-3', room: ownRoom })).toEqual({ ok: true, stop: 'requested' });

    // u1's worker asks for u1's stop, and there is none.
    const forOwner = await internal(b, '/internal/turns/t-stop-3/stop?userId=u1&waitMs=0');
    expect(forOwner.status).toBe(204);
  });

  it("takes the host's stop for its user, with the reason, and only with the internal key", async () => {
    const asked = await internal(a, '/internal/turns/t-stop-4/stop', { body: { userId: 'u1', reason: 'superseded' } });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({ ok: true, stop: 'requested', record: { reason: 'superseded', by: 'u1' } });

    const heard = await internal(b, '/internal/turns/t-stop-4/stop?userId=u1&waitMs=0');
    expect(await heard.json()).toMatchObject({ turnId: 't-stop-4', reason: 'superseded' });

    const again = await internal(a, '/internal/turns/t-stop-4/stop', { body: { userId: 'u1', reason: 'user_stop' } });
    expect(await again.json()).toMatchObject({ stop: 'already', record: { reason: 'superseded' } });

    expect((await internal(a, '/internal/turns/t-stop-5/stop', { body: { userId: 'u1', reason: 'bored' } })).status).toBe(400);
    expect((await internal(a, '/internal/turns/t-stop-5/stop', { body: { reason: 'user_stop' } })).status).toBe(400);
    expect((await internal(a, '/internal/turns/t-stop-5/stop?waitMs=0')).status).toBe(400);
    expect((await internal(a, '/internal/turns/t-stop-5/stop', { body: { userId: 'u1', reason: 'user_stop' }, key: 'wrong' })).status).toBe(401);
    expect((await internal(a, '/internal/turns/t-stop-5/stop?userId=u1', { key: 'wrong' })).status).toBe(401);
  });
});

describe('relay', () => {
  it('refuses a UI action dispatch into another account, and carries an allow-listed event to the room', async () => {
    const attacker = await connect(a, 'token-u2');
    const refused = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      attacker.emit('relay', { event: 'oui:dispatch', data: { requestId: 'x' }, rooms: ['account:acct-1'] }, resolve),
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/may not be relayed/);

    const tab1 = await connect(a, 'token-u1');
    const tab2 = await connect(b, 'token-u1');
    for (const tab of [tab1, tab2]) {
      await subscribe(tab, { rooms: ['avatar:av-1'], tokens: { 'avatar:av-1': await mintToken(a, 'u1', 'avatar:av-1') } });
    }
    const received = next(tab2, 'avatar:frame-reselect');
    const ack = await new Promise<{ ok: boolean }>((resolve) =>
      tab1.emit('relay', { event: 'avatar:frame-reselect', data: { event: 'uploading' }, rooms: ['avatar:av-1'] }, resolve),
    );
    expect(ack.ok).toBe(true);
    await expect(received).resolves.toEqual({ event: 'uploading' });
  });
});

describe('health', () => {
  it('reports ok with the connection count on both instances', async () => {
    for (const s of [a, b]) {
      const res = await fetch(`${url(s)}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok', connections: expect.any(Number), pendingResultWaits: 0 });
    }
  });
});
