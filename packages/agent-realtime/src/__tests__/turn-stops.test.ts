import { describe, it, expect, beforeEach } from 'vitest';
import { createTurnStopStore, TURN_STOP_TTL_SEC } from '../turns/stops.js';
import { createMemoryRedis, recordingLogger } from './fixtures.js';

/** ADR-0252 §2.1: the stop record the worker asks for. */

const logger = recordingLogger();

describe('turn stop store', () => {
  let redis: ReturnType<typeof createMemoryRedis>;
  const store = () => createTurnStopStore(redis.client, redis.subscriber(), logger);
  beforeEach(() => {
    redis = createMemoryRedis();
  });

  it('keeps a stop for the user who asked, and answers a wait for it at once', async () => {
    const s = store();
    const { record, first } = await s.request('t1', 'u1', 'user_stop');
    expect(first).toBe(true);
    expect(record).toMatchObject({ turnId: 't1', by: 'u1', reason: 'user_stop' });
    await expect(s.await('t1', 'u1', 0)).resolves.toEqual(record);
  });

  it('wakes a worker waiting on one instance when the stop lands on another', async () => {
    const workerInstance = store();
    const socketInstance = store();
    const waiting = workerInstance.await('t2', 'u1', 2_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(workerInstance.pendingCount()).toBe(1);

    await socketInstance.request('t2', 'u1', 'superseded');
    await expect(waiting).resolves.toMatchObject({ turnId: 't2', reason: 'superseded' });
    expect(workerInstance.pendingCount()).toBe(0);
  });

  it('answers null when nobody asks for the turn to stop', async () => {
    const s = store();
    await expect(s.await('t3', 'u1', 40)).resolves.toBeNull();
    expect(s.pendingCount()).toBe(0);
  });

  it('lets the first request stand: a later one changes neither the reason nor the time', async () => {
    const s = store();
    const first = await s.request('t4', 'u1', 'user_stop');
    const second = await s.request('t4', 'u1', 'superseded');
    expect(second.first).toBe(false);
    expect(second.record).toEqual(first.record);
    await expect(s.await('t4', 'u1', 0)).resolves.toEqual(first.record);
  });

  it("never hands a turn's worker another user's stop, and does not let it block the owner's", async () => {
    const s = store();
    await s.request('t5', 'intruder', 'user_stop');
    await expect(s.await('t5', 'owner', 30)).resolves.toBeNull();

    const owners = await s.request('t5', 'owner', 'user_stop');
    expect(owners.first).toBe(true);
    await expect(s.await('t5', 'owner', 0)).resolves.toMatchObject({ by: 'owner' });
  });

  it('outlives any turn: a worker that starts late still hears it', () => {
    expect(TURN_STOP_TTL_SEC).toBe(30 * 60);
  });
});
