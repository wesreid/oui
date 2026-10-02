import { describe, it, expect, beforeEach } from 'vitest';
import type { OUIActionResult } from 'oui-spec/spec';
import { createOUIResultStore, FINAL_RESULT_TTL_SEC, type OUIResultStore } from '../oui/results.js';
import { createInternalKeyCheck, ouiResultsRouter } from '../http/routes.js';
import { createRoomTokenSigner } from '../rooms/room-token.js';
import { createMemoryRedis, fixtureRoomPolicy, recordingLogger, TEST_TOKEN_SECRET } from './fixtures.js';

/** Ported from studio-realtime `src/__tests__/oui-results.test.ts`. */

const logger = recordingLogger();

const answer = (requestId: string, extra: Partial<OUIActionResult> = {}): OUIActionResult => ({
  requestId,
  success: true,
  data: { navigatedTo: '/media-projects' },
  timestamp: Date.now(),
  ...extra,
});

describe('OUI result store', () => {
  let redis: ReturnType<typeof createMemoryRedis>;
  const store = () => createOUIResultStore(redis.client, redis.subscriber(), logger);
  beforeEach(() => {
    redis = createMemoryRedis();
  });

  it('returns an answer that is already held', async () => {
    const s = store();
    await s.store('u1', answer('r1'));
    await expect(s.await('r1', 'u1', 0)).resolves.toMatchObject({ requestId: 'r1', success: true });
  });

  it('wakes a wait on one instance when the answer lands on another', async () => {
    const waitingInstance = store();
    const socketInstance = store();

    const waiting = waitingInstance.await('r2', 'u1', 2_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(waitingInstance.pendingCount()).toBe(1);

    await socketInstance.store('u1', answer('r2'));
    await expect(waiting).resolves.toMatchObject({ requestId: 'r2' });
    expect(waitingInstance.pendingCount()).toBe(0);
  });

  it('resolves null when no answer arrives in time', async () => {
    const s = store();
    const started = Date.now();
    await expect(s.await('r3', 'u1', 60)).resolves.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(s.pendingCount()).toBe(0);
  });

  it("never hands one user another user's answer", async () => {
    const s = store();
    await s.store('intruder', answer('r4'));
    await expect(s.await('r4', 'u1', 30)).resolves.toBeNull();
  });

  it("keeps the first answer: an async action's acknowledgment, not its later completion", async () => {
    const s = store();
    await expect(s.store('u1', answer('r5', { interim: true, data: { jobId: 'j1' } }))).resolves.toBe(true);
    await expect(s.store('u1', answer('r5', { interim: false, data: { url: 'x' } }))).resolves.toBe(false);
    await expect(s.await('r5', 'u1', 0)).resolves.toMatchObject({ interim: true, data: { jobId: 'j1' } });
  });

  it("keeps an async action's final answer apart, for as long as a job may run, and a wait on it gets that", async () => {
    const socketInstance = store();
    const workerInstance = store();

    await socketInstance.store('u1', answer('r6', { interim: true, data: { status: 'started', jobId: 'j6' } }));
    await expect(workerInstance.await('r6', 'u1', 0, { final: true })).resolves.toBeNull();
    const waiting = workerInstance.await('r6', 'u1', 2_000, { final: true });
    await new Promise((r) => setTimeout(r, 20));

    await socketInstance.store('u1', answer('r6', { interim: false, data: { status: 'complete', contentUrl: 'https://cdn/c.mp4' } }));
    await expect(waiting).resolves.toMatchObject({ interim: false, data: { status: 'complete' } });
    expect(redis.ttls.get('oui:result:r6:final')).toBe(FINAL_RESULT_TTL_SEC);
    expect(FINAL_RESULT_TTL_SEC).toBeGreaterThanOrEqual(30 * 60);
    await expect(workerInstance.await('r6', 'u1', 0)).resolves.toMatchObject({ interim: true, data: { jobId: 'j6' } });
  });

  it("has a synchronous action's one answer as both its first and its final", async () => {
    const s = store();
    await s.store('u1', answer('r7'));
    await expect(s.await('r7', 'u1', 0)).resolves.toMatchObject({ requestId: 'r7' });
    await expect(s.await('r7', 'u1', 0, { final: true })).resolves.toMatchObject({ requestId: 'r7' });
  });

  it("keeps the first final answer, and never hands one user another user's", async () => {
    const s = store();
    await s.store('u1', answer('r8', { interim: false, data: { status: 'failed', error: 'CUDA out of memory' } }));
    await s.store('u1', answer('r8', { interim: false, data: { status: 'complete' } }));
    await expect(s.await('r8', 'u1', 0, { final: true })).resolves.toMatchObject({ data: { status: 'failed' } });
    await expect(s.await('r8', 'intruder', 30, { final: true })).resolves.toBeNull();
  });
});

describe('GET /internal/oui/action-results/:requestId', () => {
  let redis: ReturnType<typeof createMemoryRedis>;
  let current: OUIResultStore | null;
  beforeEach(() => {
    redis = createMemoryRedis();
    current = createOUIResultStore(redis.client, redis.subscriber(), logger);
  });

  /** Runs the route as express would, and returns what it sent. */
  async function get(requestId: string, query: Record<string, string>, key = 'internal-key') {
    type Handler = (req: unknown, res: unknown) => Promise<void>;
    const router = ouiResultsRouter({
      io: {} as never,
      roomPolicy: fixtureRoomPolicy,
      roomTokens: createRoomTokenSigner({ secret: TEST_TOKEN_SECRET }),
      results: () => current,
      isInternalKey: createInternalKeyCheck('internal-key'),
      logger,
    });
    const handler = (router as unknown as { stack: Array<{ route: { stack: Array<{ handle: Handler }> } }> }).stack[0].route
      .stack[0].handle;
    const sent: { status: number; body?: unknown } = { status: 200 };
    const res = {
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        return res;
      },
      end() {
        return res;
      },
    };
    await handler({ headers: { 'x-api-key': key }, params: { requestId }, query }, res);
    return sent;
  }

  it('answers with the first answer by default, and the final one with final=1', async () => {
    const s = createOUIResultStore(redis.client, redis.subscriber(), logger);
    await s.store('u1', answer('q1', { interim: true, data: { status: 'started' } }));

    await expect(get('q1', { userId: 'u1' })).resolves.toMatchObject({ status: 200, body: { interim: true } });
    await expect(get('q1', { userId: 'u1', final: '1' })).resolves.toEqual({ status: 204 });

    await s.store('u1', answer('q1', { interim: false, data: { status: 'complete' } }));
    await expect(get('q1', { userId: 'u1', final: '1' })).resolves.toMatchObject({
      status: 200,
      body: { interim: false, data: { status: 'complete' } },
    });
  });

  it('refuses a wrong key, a missing user and a bad wait', async () => {
    await expect(get('q2', { userId: 'u1', final: '1' }, 'wrong')).resolves.toMatchObject({ status: 401 });
    await expect(get('q2', { final: '1' })).resolves.toMatchObject({ status: 400 });
    await expect(get('q2', { userId: 'u1', waitMs: '-1' })).resolves.toMatchObject({ status: 400 });
  });

  it('answers 503 while the store is not connected', async () => {
    current = null;
    await expect(get('q3', { userId: 'u1' })).resolves.toMatchObject({ status: 503 });
  });
});
