/**
 * The server follows the product's event declarations (W9, ADR-0227 §2.4).
 *
 * Given them, `/api/emit` sends only a declared event, with a payload its
 * schema accepts, into a room it is declared for, and refuses anything else
 * with a 400 it logs. A tab relays only a declared notice. And every declared
 * completion or failure is kept as its job's settlement, so a worker on any
 * instance can wait for the job to end without joining a socket room.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createWebSocketTransport } from 'oui-spec/transport';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { RealtimeServerInstance } from '../server.js';
import { fixtureCatalog, fixtureRoomPolicy, TEST_APPROVAL_KEY, TEST_TOKEN_SECRET } from './fixtures.js';
import { createHarness, next, type Harness } from './harness.js';
import { createRealtimeServer } from '../server.js';

let h: Harness;
let a: RealtimeServerInstance;
let b: RealtimeServerInstance;

beforeAll(async () => {
  h = await createHarness({
    key: 'declared-events-key',
    users: { 'token-u1': { userId: 'u1', accountId: 'acct-1' }, 'token-u2': { userId: 'u2', accountId: 'acct-2' } },
  });
  // The relay rule names the event; the declaration supplies its rooms and schema.
  [a, b] = await Promise.all([
    h.start({ events: fixtureCatalog, relay: { 'avatar:frame-reselect': {} } }),
    h.start({ events: fixtureCatalog, relay: { 'avatar:frame-reselect': {} } }),
  ]);
}, 20_000);

afterAll(async () => {
  await h?.close();
});

async function refusal(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: string }).error;
}

describe('/api/emit with declarations', () => {
  it('sends a declared event with a valid payload into its declared room', async () => {
    const tab = await h.connect(a, 'token-u1');
    const received = next(tab, 'render:done');
    expect((await h.emit(b, 'render:done', { jobId: 'job-1', url: 'https://cdn/job-1.png' }, ['user:u1'])).status).toBe(200);
    await expect(received).resolves.toEqual({ jobId: 'job-1', url: 'https://cdn/job-1.png' });
  });

  it('refuses an undeclared event, and logs it', async () => {
    const before = h.logger.records.length;
    expect(await refusal(await h.emit(b, 'render:finished', { jobId: 'job-1' }, ['user:u1']))).toBe(
      'event "render:finished" is not declared',
    );
    expect(h.logger.records.slice(before)).toContainEqual({
      level: 'warn',
      msg: 'Emit refused',
      data: { event: 'render:finished', rooms: ['user:u1'], reason: 'event "render:finished" is not declared' },
    });
  });

  it('refuses a payload its schema does not accept', async () => {
    expect(await refusal(await h.emit(b, 'render:done', { jobId: 'job-1' }, ['user:u1']))).toBe(
      "invalid \"render:done\" payload: / must have required property 'url'",
    );
    expect(await refusal(await h.emit(b, 'render:progress', { jobId: 7 }, ['generation:job-1']))).toBe(
      'invalid "render:progress" payload: /jobId must be string',
    );
  });

  it('refuses a room the event is not declared for, and a broadcast', async () => {
    expect(await refusal(await h.emit(b, 'render:progress', { jobId: 'job-1' }, ['user:u1']))).toBe(
      '"render:progress" may not go to user:u1; it is declared for generation:{jobId}',
    );
    expect(await refusal(await h.emit(b, 'render:progress', { jobId: 'job-1' }))).toBe(
      '"render:progress" is declared for generation:{jobId}; name its rooms, a declared event is never broadcast',
    );
  });

  it("still carries the platform's own events: a turn's tokens and a UI action dispatch, into the turn's room", async () => {
    const tab = await h.connect(a, 'token-u1');
    const turnRoom = 'agent:turn:t-decl-1';
    await h.subscribe(tab, { rooms: [turnRoom], tokens: { [turnRoom]: await h.mintToken(b, 'u1', turnRoom) } });

    const token = next(tab, 'agent:token');
    expect((await h.emit(b, 'agent:token', { turnId: 't-decl-1', text: 'Hi', timestamp: 1 }, [turnRoom])).status).toBe(200);
    await expect(token).resolves.toMatchObject({ text: 'Hi' });

    const transport = createWebSocketTransport(tab);
    const seen: OUIActionRequest[] = [];
    transport.onAction((r) => seen.push(r));
    let wire: { event: string; data: unknown } | null = null;
    createWebSocketTransport({ connected: true, emit: (event, data) => (wire = { event, data }), on() {}, off() {}, once() {} }).dispatch({
      requestId: 'req-decl-1',
      surfaceId: 'app-shell',
      actionId: 'navigate',
      params: { path: '/x' },
      timestamp: 1,
    });
    expect((await h.emit(b, wire!.event, wire!.data, [turnRoom])).status).toBe(200);
    await expect.poll(() => seen.map((r) => r.requestId)).toEqual(['req-decl-1']);
    transport.dispose();
  });
});

describe('relay with declarations', () => {
  it('carries a declared notice into its declared room, and refuses bad data or another room', async () => {
    const tab1 = await h.connect(a, 'token-u1');
    const tab2 = await h.connect(b, 'token-u1');
    for (const tab of [tab1, tab2]) {
      await h.subscribe(tab, { rooms: ['avatar:av-1'], tokens: { 'avatar:av-1': await h.mintToken(a, 'u1', 'avatar:av-1') } });
    }
    const relay = (data: unknown, rooms: string[]) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => tab1.emit('relay', { event: 'avatar:frame-reselect', data, rooms }, resolve));

    const received = next(tab2, 'avatar:frame-reselect');
    expect(await relay({ event: 'uploading' }, ['avatar:av-1'])).toEqual({ ok: true });
    await expect(received).resolves.toEqual({ event: 'uploading' });

    expect((await relay({ event: 'exploded' }, ['avatar:av-1'])).error).toBe(
      'invalid "avatar:frame-reselect" data: /event must be equal to one of the allowed values',
    );
    expect((await relay({ event: 'uploading' }, ['user:u1'])).error).toBe(
      '"avatar:frame-reselect" may not go to user:u1; it is declared for avatar:{avatarId}',
    );
  });

  it('refuses to start with a relay rule for an undeclared event, or for one only the server sends', async () => {
    const base = {
      auth: { verify: async () => ({ userId: 'u' }) },
      roomPolicy: fixtureRoomPolicy,
      internalApiKey: 'k',
      roomTokens: { secret: TEST_TOKEN_SECRET },
      approvals: { signingKey: TEST_APPROVAL_KEY },
      redis: { host: '127.0.0.1', port: 1, tls: false },
      corsOrigins: ['http://localhost'],
      port: 0,
      events: fixtureCatalog,
    };
    await expect(createRealtimeServer({ ...base, relay: { 'avatar:rotated': {} } })).rejects.toThrow(
      "[agent-sdk-realtime] relay[\"avatar:rotated\"] names the event 'avatar:rotated', which is not declared",
    );
    await expect(createRealtimeServer({ ...base, relay: { 'render:done': {} } })).rejects.toThrow(
      '[agent-sdk-realtime] relay["render:done"]: a completion event is sent only by the server; a client may relay only a notice',
    );
    await expect(createRealtimeServer({ ...base, relay: { 'agent:token': {} } })).rejects.toThrow(
      "[agent-sdk-realtime] relay[\"agent:token\"]: it goes to a turn's room, which only the server sends to",
    );
  });
});

describe('settlements: how a worker waits for a job to end', () => {
  const settlement = (server: RealtimeServerInstance, kind: string, id: string, waitMs = 0) =>
    h.internal(server, `/internal/events/settlements/${kind}/${encodeURIComponent(id)}?waitMs=${waitMs}`);

  it('keeps a completion emitted on one instance, for a wait on the other that began first', async () => {
    const waiting = settlement(a, 'render', 'job-s1', 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.emit(b, 'render:done', { jobId: 'job-s1', url: 'https://cdn/s1.png' }, ['generation:job-s1'])).status).toBe(200);

    const res = await waiting;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'render',
      role: 'completion',
      event: 'render:done',
      id: 'job-s1',
      payload: { jobId: 'job-s1', url: 'https://cdn/s1.png' },
    });
  });

  it('keeps a failure, and only the first settlement of a job', async () => {
    await h.emit(b, 'render:failed', { jobId: 'job-s2', error: 'GPU out of memory' }, ['user:u1']);
    await h.emit(b, 'render:done', { jobId: 'job-s2', url: 'https://cdn/late.png' }, ['user:u1']);
    expect(await (await settlement(a, 'render', 'job-s2')).json()).toMatchObject({
      role: 'failure',
      event: 'render:failed',
      payload: { error: 'GPU out of memory' },
    });
  });

  it('answers 204 while a job has not settled, and never settles on progress', async () => {
    await h.emit(b, 'render:progress', { jobId: 'job-s3', progress: 0.5 }, ['generation:job-s3']);
    expect((await settlement(a, 'render', 'job-s3', 100)).status).toBe(204);
  });

  it('refuses an undeclared job kind, a bad wait, and a caller without the key', async () => {
    expect(await refusal(await settlement(a, 'export', 'x'))).toBe("job kind 'export' is not declared (declared: render)");
    expect(await refusal(await h.internal(a, '/internal/events/settlements/render/x?waitMs=-1'))).toBe('waitMs must be a non-negative number');
    expect((await h.internal(a, '/internal/events/settlements/render/x', { key: 'wrong' })).status).toBe(401);
  });
});

describe('without declarations', () => {
  it('has no settlements to serve', async () => {
    const plain = await h.start();
    const res = await h.internal(plain, '/internal/events/settlements/render/x');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'this server has no event declarations' });
  });
});
