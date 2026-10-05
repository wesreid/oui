/**
 * Stop requests for agent turns, held for the worker that runs the turn
 * (ADR-0252 §2.1).
 *
 * The worker has no socket. A stop is written here, by the user's own socket
 * or by the host's API, and the worker asks for it for as long as its turn
 * runs. The request may arrive on one instance and the worker's wait be
 * served by another, so both meet in Redis:
 *
 *   turn:stop:{turnId}:{userId}  → JSON TurnStopRecord, TTL 30 min, the first request stands
 *   channel turn:stops           → `{turnId}:{userId}`, published when a stop is stored
 *
 * A stop is kept under the user who asked, and a wait is answered only with
 * the stop of the user it asks for. The server keeps no record of who owns a
 * turn, so this is what makes a stop the owner's: the worker asks for its
 * turn's own user, and nobody else's request is ever read. One user's stop for
 * another user's turn is a record nobody waits on.
 *
 * The record outlives any turn: a worker that starts late, or whose wait
 * failed and was retried, still hears it.
 */
import { TURN_STOP_RECORD_TTL_MS, type TurnStopReason, type TurnStopRecord } from '@ouispec/agent-core';
import type { RealtimeLogger } from '../logger.js';
import { createWaitHub, type ResultsRedis, type ResultsSubscriber } from '../redis-waits.js';

export interface TurnStopStore {
  /**
   * Record that `userId` asks for `turnId` to stop. The first request stands:
   * a later one changes nothing and gets the first back, with `first: false`.
   */
  request(turnId: string, userId: string, reason: TurnStopReason): Promise<{ record: TurnStopRecord; first: boolean }>;
  /** The stop `userId` asked for on `turnId`, waiting up to `waitMs` for one. */
  await(turnId: string, userId: string, waitMs: number): Promise<TurnStopRecord | null>;
  /** Waits in progress on this instance. */
  pendingCount(): number;
}

const CHANNEL = 'turn:stops';
export const TURN_STOP_TTL_SEC = Math.ceil(TURN_STOP_RECORD_TTL_MS / 1000);

const waitId = (turnId: string, userId: string) => `${turnId}:${userId}`;
const stopKey = (turnId: string, userId: string) => `turn:stop:${waitId(turnId, userId)}`;

export function createTurnStopStore(redis: ResultsRedis, subscriber: ResultsSubscriber, logger: RealtimeLogger): TurnStopStore {
  const hub = createWaitHub(subscriber, CHANNEL, logger, 'Turn stops');

  async function read(turnId: string, userId: string): Promise<TurnStopRecord | null> {
    const raw = await redis.get(stopKey(turnId, userId));
    return raw ? (JSON.parse(raw) as TurnStopRecord) : null;
  }

  return {
    async request(turnId, userId, reason) {
      const record: TurnStopRecord = { turnId, by: userId, reason, at: Date.now() };
      const written = await redis.set(stopKey(turnId, userId), JSON.stringify(record), 'EX', TURN_STOP_TTL_SEC, 'NX');
      if (written !== 'OK') {
        const held = await read(turnId, userId);
        // Expired between the two commands: nothing stands, so this one does on a second try.
        if (!held) return this.request(turnId, userId, reason);
        return { record: held, first: false };
      }
      await redis.publish(CHANNEL, waitId(turnId, userId));
      logger.info({ turnId, userId, reason }, 'Turn stop requested');
      return { record, first: true };
    },

    async await(turnId, userId, waitMs) {
      return hub.wait(waitId(turnId, userId), waitMs, () => read(turnId, userId), (err) =>
        logger.error({ err, turnId }, 'Turn stop read failed'),
      );
    },

    pendingCount: () => hub.pendingCount(),
  };
}
