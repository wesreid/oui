/**
 * The realtime key can be read by the host's getter instead of fixed in its configuration, so the
 * key need not sit in the host's environment or deploy template and a rotation reaches a running
 * worker. A fixed string works exactly as before.
 *
 * The source: a getter is read once, kept for its max age, read again after it, read again at
 * once when the realtime server refuses the key, and a failed re-read keeps the key that worked.
 * The clients: each presents the source's key, and a refused request is sent once more with the
 * newer key. Every client the runtime builds shares one cache.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRealtimeKeySource,
  DEFAULT_REALTIME_KEY_MAX_AGE_MS,
  fetchWithRealtimeKey,
  isRealtimeApiKey,
  isRealtimeKeySource,
} from '../realtime/api-key.js';
import { longPoll } from '../realtime/long-poll.js';
import { createHttpEmitAdapter } from '../emit/http-adapter.js';
import { createHttpUIActionChannel } from '../ui/channel.js';
import { createHttpApprovalStoreClient } from '../approvals/client.js';
import { createHttpConversationClient } from '../conversations/client.js';
import { createHttpTurnStopClient } from '../stop/turn-stop.js';
import { createHttpEventWaiter } from '../events/http-waiter.js';
import { createAgentTurnRunner } from '../runtime/turn-runner.js';
import { createLambdaAgentHandler } from '../lambda/handler.js';
import type { AgentRuntimeConfig } from '../runtime/types.js';
import * as root from '../index.js';

/** A secret store the host's getter reads: the key it holds now, and how often it was read. */
function secretStore(initial: string) {
  const store = {
    key: initial,
    reads: 0,
    fail: false as false | Error,
    getter: async () => {
      store.reads++;
      if (store.fail) throw store.fail;
      return store.key;
    },
  };
  return store;
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

describe('the realtime key source', () => {
  it('a fixed string is presented as it is and never re-read, even when refused', async () => {
    const source = createRealtimeKeySource('fixed-key');
    expect(await source.get()).toBe('fixed-key');
    expect(await source.refused('fixed-key')).toBe(false);
    expect(await source.get()).toBe('fixed-key');
    expect(isRealtimeKeySource(source)).toBe(true);
  });

  it('a getter is read once, and every caller meanwhile shares that one read', async () => {
    const store = secretStore('key-1');
    const source = createRealtimeKeySource(store.getter);
    const keys = await Promise.all(Array.from({ length: 20 }, () => source.get()));
    expect(new Set(keys)).toEqual(new Set(['key-1']));
    expect(store.reads).toBe(1);
  });

  it('reads the getter again once the key is older than its max age (30 s by default)', async () => {
    expect(DEFAULT_REALTIME_KEY_MAX_AGE_MS).toBe(30_000);
    const store = secretStore('key-1');
    const c = clock();
    const source = createRealtimeKeySource(store.getter, { now: c.now });
    expect(await source.get()).toBe('key-1');
    store.key = 'key-2'; // rotated in the store
    c.advance(29_999);
    expect(await source.get()).toBe('key-1');
    expect(store.reads).toBe(1);
    c.advance(1);
    expect(await source.get()).toBe('key-2');
    expect(store.reads).toBe(2);
  });

  it('takes its own max age', async () => {
    const store = secretStore('key-1');
    const c = clock();
    const source = createRealtimeKeySource(store.getter, { now: c.now, maxAgeMs: 5_000 });
    await source.get();
    store.key = 'key-2';
    c.advance(5_000);
    expect(await source.get()).toBe('key-2');
    expect(() => createRealtimeKeySource(store.getter, { maxAgeMs: -1 })).toThrow(/apiKeyMaxAgeMs/);
  });

  it('a failed or empty re-read keeps the key that worked, says so without the key, and asks again next time', async () => {
    const store = secretStore('key-1');
    const c = clock();
    const told: unknown[] = [];
    const source = createRealtimeKeySource(store.getter, { now: c.now, onRefreshError: (e) => told.push(e) });
    await source.get();
    c.advance(DEFAULT_REALTIME_KEY_MAX_AGE_MS);
    store.fail = new Error('Secrets Manager is unreachable');
    expect(await source.get()).toBe('key-1');
    expect(await source.get()).toBe('key-1');
    expect(store.reads).toBe(3); // asked again on each request while it fails
    store.fail = false;
    store.key = '';
    expect(await source.get()).toBe('key-1');
    expect(told).toHaveLength(3);
    for (const error of told) expect(String(error)).not.toContain('key-1');
    store.key = 'key-2';
    expect(await source.get()).toBe('key-2');
  });

  it('with no key held, a failed read rejects, is not cached, and the next request reads again', async () => {
    const store = secretStore('key-1');
    store.fail = new Error('Secrets Manager is unreachable');
    const source = createRealtimeKeySource(store.getter);
    await expect(source.get()).rejects.toThrow(/unreachable/);
    store.fail = false;
    expect(await source.get()).toBe('key-1');
    expect(store.reads).toBe(2);
  });

  it('a getter answering no key at all rejects, naming realtime.apiKey', async () => {
    const source = createRealtimeKeySource(() => '');
    await expect(source.get()).rejects.toThrow(/realtime\.apiKey.*no key/);
  });

  it('a refused key is read again at once; it is worth sending again only when the key changed', async () => {
    const store = secretStore('key-1');
    const source = createRealtimeKeySource(store.getter);
    await source.get();
    // Not rotated: the store still holds the refused key.
    expect(await source.refused('key-1')).toBe(false);
    expect(store.reads).toBe(2);
    store.key = 'key-2';
    expect(await source.refused('key-1')).toBe(true);
    expect(await source.get()).toBe('key-2');
    // A refusal of a key already replaced does not read again: the newer key is sent.
    expect(await source.refused('key-1')).toBe(true);
    expect(store.reads).toBe(3);
  });

  it('a source passed on is the same source: its cache and age apply', () => {
    const source = createRealtimeKeySource(() => 'k');
    expect(createRealtimeKeySource(source)).toBe(source);
  });

  it('only a non-empty string, a getter or a source is a realtime key', () => {
    expect(isRealtimeApiKey('k')).toBe(true);
    expect(isRealtimeApiKey(() => 'k')).toBe(true);
    expect(isRealtimeApiKey(createRealtimeKeySource('k'))).toBe(true);
    for (const bad of ['', undefined, null, 42, { get: () => 'k', refused: () => false }]) {
      expect(isRealtimeApiKey(bad)).toBe(false);
    }
    expect(() => createRealtimeKeySource('')).toThrow(/realtime\.apiKey/);
    expect(() => createRealtimeKeySource(42 as never)).toThrow(/realtime\.apiKey/);
  });

  it('is exported from the package root', () => {
    expect(root.createRealtimeKeySource).toBe(createRealtimeKeySource);
    expect(root.isRealtimeKeySource).toBe(isRealtimeKeySource);
    expect(root.DEFAULT_REALTIME_KEY_MAX_AGE_MS).toBe(DEFAULT_REALTIME_KEY_MAX_AGE_MS);
  });
});

// ─── The clients, against a realtime server whose key is rotated ──────────

/**
 * A realtime server's internal routes, answering only the key it holds now. It records the key of
 * every request, so a test sees which key each client presented.
 */
interface FakeRealtime {
  url: string;
  key: string;
  seen: Array<{ method: string; path: string; key: string | undefined; status: number }>;
  close(): Promise<void>;
}

async function fakeRealtime(key: string): Promise<FakeRealtime> {
  const state: FakeRealtime = { url: '', key, seen: [], close: async () => {} };
  const answer = (req: IncomingMessage): { status: number; body?: unknown } => {
    const path = (req.url ?? '').split('?')[0];
    if (req.headers['x-api-key'] !== state.key) return { status: 401, body: { error: 'Invalid or missing API key' } };
    if (path === '/api/emit') return { status: 200, body: { ok: true, receipts: { acknowledged: 1, accepted: 1 } } };
    if (path.startsWith('/internal/oui/action-results/')) return { status: 200, body: { requestId: 'r1', success: true } };
    if (path.startsWith('/internal/events/settlements/')) return { status: 200, body: { outcome: 'completed', data: {} } };
    if (path.startsWith('/internal/turns/')) return { status: 200, body: { reason: 'user_stop', requestedAt: '2026-11-19T00:00:00.000Z' } };
    if (path === '/internal/approvals') return { status: 201, body: {} };
    if (path.startsWith('/internal/conversations/')) return { status: 204 };
    return { status: 404, body: { error: 'no route' } };
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const { status, body } = answer(req);
      state.seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0], key: req.headers['x-api-key'] as string | undefined, status });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

describe('every realtime client presents the source’s key, and recovers from a rotation', () => {
  let realtime: FakeRealtime;
  beforeAll(async () => {
    realtime = await fakeRealtime('key-1');
  });
  afterAll(async () => {
    await realtime.close();
  });
  beforeEach(() => {
    realtime.key = 'key-1';
    realtime.seen.length = 0;
  });

  /**
   * The rotation every case below goes through: the host's cache holds key-1, then the store and
   * the realtime server move to key-2 before the cache expires.
   */
  async function rotated() {
    const store = secretStore('key-1');
    const source = createRealtimeKeySource(store.getter);
    await source.get();
    store.key = 'key-2';
    realtime.key = 'key-2';
    return { store, source };
  }

  const refusedThenAccepted = (path: string) => {
    const calls = realtime.seen.filter((s) => s.path.startsWith(path));
    expect(calls.map((c) => [c.key, c.status])).toEqual([
      ['key-1', 401],
      ['key-2', expect.any(Number)],
    ]);
    expect(calls[1].status).not.toBe(401);
  };

  it('fetchWithRealtimeKey sends a refused request once more with the newer key, and not again when nothing changed', async () => {
    const { source } = await rotated();
    const res = await fetchWithRealtimeKey(source, (key) => fetch(`${realtime.url}/api/emit`, { method: 'POST', headers: { 'X-Api-Key': key }, body: '{}' }));
    expect(res.status).toBe(200);
    refusedThenAccepted('/api/emit');

    realtime.seen.length = 0;
    const stale = createRealtimeKeySource('key-1');
    const refused = await fetchWithRealtimeKey(stale, (key) => fetch(`${realtime.url}/api/emit`, { method: 'POST', headers: { 'X-Api-Key': key }, body: '{}' }));
    expect(refused.status).toBe(401);
    expect(realtime.seen).toHaveLength(1);
  });

  it('the emit adapter', async () => {
    const { source } = await rotated();
    await createHttpEmitAdapter({ url: realtime.url, apiKey: source }).emit('chat:turn:t1', 'agent:token', { text: 'hi' });
    refusedThenAccepted('/api/emit');
  });

  it('the UI action channel: the dispatch and the long poll for its answer', async () => {
    const { store, source } = await rotated();
    const channel = createHttpUIActionChannel({ url: realtime.url, apiKey: source, receiptTimeoutMs: 0, maxPollMs: 10 });
    expect(await channel.dispatch('chat:turn:t1', { requestId: 'r1', surfaceId: 's', actionId: 'a', params: {} } as never)).toEqual({
      acknowledged: 1,
      accepted: 1,
    });
    refusedThenAccepted('/api/emit');

    // Rotated again while the action runs: the poll for its answer moves to the newest key.
    realtime.seen.length = 0;
    store.key = 'key-3';
    realtime.key = 'key-3';
    expect(await channel.awaitResult('r1', { userId: 'u1', timeoutMs: 2_000 })).toEqual({ requestId: 'r1', success: true });
    expect(realtime.seen.map((s) => [s.key, s.status])).toEqual([
      ['key-2', 401],
      ['key-3', 200],
    ]);
  });

  it('the long poll asks again at once with the newer key, and a refusal with nothing newer still throws', async () => {
    const { source } = await rotated();
    const answer = await longPoll({ url: () => `${realtime.url}/internal/oui/action-results/r1`, apiKey: source, timeoutMs: 2_000, maxPollMs: 10, describe: 'r1' });
    expect(answer).toMatchObject({ requestId: 'r1' });
    refusedThenAccepted('/internal/oui/action-results/');

    await expect(
      longPoll({ url: () => `${realtime.url}/internal/oui/action-results/r1`, apiKey: createRealtimeKeySource('key-1'), timeoutMs: 2_000, maxPollMs: 10, describe: 'r1' }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('the event waiter', async () => {
    const { source } = await rotated();
    const settled = await createHttpEventWaiter({ url: realtime.url, apiKey: source, maxPollMs: 10 }).waitForSettlement({
      binding: { kind: 'job', usedBy: 'test' } as never,
      id: 'j1',
      timeoutMs: 2_000,
    });
    expect(settled).toMatchObject({ outcome: 'completed' });
    refusedThenAccepted('/internal/events/settlements/');
  });

  it('the approval store', async () => {
    const { source } = await rotated();
    await createHttpApprovalStoreClient({ url: realtime.url, apiKey: source }).create({ approvalId: 'a1' } as never);
    refusedThenAccepted('/internal/approvals');
  });

  it('the conversation client', async () => {
    const { source } = await rotated();
    expect(await createHttpConversationClient({ url: realtime.url, apiKey: source }).hold('c1')).toBeNull();
    refusedThenAccepted('/internal/conversations/');
  });

  it('the stop watch: the attempt after a refusal presents the newer key', async () => {
    const { source } = await rotated();
    const errors: unknown[] = [];
    const record = await createHttpTurnStopClient({ url: realtime.url, apiKey: source, maxBackoffMs: 10, onError: (e) => errors.push(e) }).watch(
      't1',
      'u1',
      new AbortController().signal,
    );
    expect(record).toMatchObject({ reason: 'user_stop' });
    refusedThenAccepted('/internal/turns/');
    expect(errors.map(String)).toEqual(['Error: HTTP 401']);
  });

  it('a getter given straight to a client is read once for all of its requests', async () => {
    const store = secretStore('key-1');
    const emit = createHttpEmitAdapter({ url: realtime.url, apiKey: store.getter });
    for (let i = 0; i < 5; i++) await emit.emit('chat:turn:t1', 'agent:token', { text: String(i) });
    expect(realtime.seen.map((s) => [s.key, s.status])).toEqual(Array.from({ length: 5 }, () => ['key-1', 200]));
    expect(store.reads).toBe(1);
  });
});

describe('the runtime takes a getter for realtime.apiKey', () => {
  const complete = (apiKey: AgentRuntimeConfig<object>['realtime']['apiKey']): AgentRuntimeConfig<object> => ({
    model: 'provider/model-id',
    realtime: { url: 'http://127.0.0.1:1', apiKey },
    systemPrompt: () => 'You help.',
    tools: [],
    getDb: async () => ({}),
    getHistory: async () => [],
    persistMessages: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  it('starts with a fixed key, a getter, or a source, and reads no key at start-up', () => {
    const store = secretStore('key-1');
    expect(() => createAgentTurnRunner(complete('key-1'))).not.toThrow();
    expect(() => createLambdaAgentHandler(complete(store.getter))).not.toThrow();
    expect(() => createAgentTurnRunner(complete(createRealtimeKeySource(store.getter)))).not.toThrow();
    expect(store.reads).toBe(0);
  });

  it('refuses anything else, naming realtime.apiKey', () => {
    for (const bad of ['', 42, { key: 'k' }]) {
      expect(() => createAgentTurnRunner(complete(bad as never))).toThrow(/Missing required configuration: realtime\.apiKey/);
    }
  });

  it('refuses a max age that is not a number of milliseconds', () => {
    const config = complete(() => 'k');
    expect(() => createAgentTurnRunner({ ...config, realtime: { ...config.realtime, apiKeyMaxAgeMs: Number.NaN } })).toThrow(/apiKeyMaxAgeMs/);
  });
});
