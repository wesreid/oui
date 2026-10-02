/**
 * OUI action results, held for the agent worker that asked (ADR-0209 D2).
 *
 * The worker sends a UI action to the turn's room and then waits here for the
 * client's answer. The answer arrives on whichever realtime instance holds the
 * client's socket, and the worker's wait may be served by another, so both
 * meet in Redis:
 *
 *   oui:result:{requestId}        → JSON { userId, result }, TTL 5 min, first answer wins
 *   oui:result:{requestId}:final  → JSON { userId, result }, TTL 35 min, the final answer
 *   channel oui:results           → the key's id (`{requestId}` or `{requestId}:final`),
 *                                   published when an answer is stored
 *
 * An async action (a GPU job, an export) is answered twice: acknowledged
 * (`interim: true`, "started"), then finished (`interim: false`) once its
 * output exists or it has failed. The first answer is what a worker's first
 * wait gets. The final answer is kept apart, for as long as the longest job
 * may run, so a worker can wait on to it and tell the person the work is done
 * only once it is. A synchronous action's one answer is both.
 *
 * An answer is kept under the user of the socket that sent it, and handed only
 * to a wait for that same user.
 */
import type { OUIActionResult } from 'oui-spec/spec';
import type { RealtimeLogger } from '../logger.js';
import { createWaitHub, type ResultsRedis, type ResultsSubscriber } from '../redis-waits.js';

export type { ResultsRedis, ResultsSubscriber };

export interface OUIResultStore {
  /** Keep a client's answer. Returns false when an answer for the request was already kept. */
  store(userId: string, result: OUIActionResult): Promise<boolean>;
  /**
   * The answer for `requestId` given by `userId`, waiting up to `waitMs` for it
   * to arrive: the first answer, or with `final` the final one (never an
   * acknowledgment).
   */
  await(requestId: string, userId: string, waitMs: number, options?: { final?: boolean }): Promise<OUIActionResult | null>;
  /** Waits in progress on this instance. */
  pendingCount(): number;
}

const CHANNEL = 'oui:results';
export const RESULT_TTL_SEC = 5 * 60;
/** As long as the longest job an action follows may run (an export, a recipient batch: 30 min), with margin. */
export const FINAL_RESULT_TTL_SEC = 35 * 60;

/** What a wait is for, as the channel and the waiters name it: the first answer, or the final one. */
const waitId = (requestId: string, final: boolean) => (final ? `${requestId}:final` : requestId);
const resultKey = (id: string) => `oui:result:${id}`;

interface StoredResult {
  userId: string;
  result: OUIActionResult;
}

export function createOUIResultStore(
  redis: ResultsRedis,
  subscriber: ResultsSubscriber,
  logger: RealtimeLogger,
): OUIResultStore {
  const hub = createWaitHub(subscriber, CHANNEL, logger, 'OUI results');

  async function read(requestId: string, userId: string, id: string): Promise<OUIActionResult | null> {
    const raw = await redis.get(resultKey(id));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredResult;
    if (stored.userId !== userId) {
      // Another user's answer for this id is not an answer to this user.
      logger.warn({ requestId, askedFor: userId, answeredBy: stored.userId }, 'OUI result belongs to another user');
      return null;
    }
    return stored.result;
  }

  /** Keep a final answer, the first one only, and wake its waits. */
  async function storeFinal(stored: StoredResult): Promise<void> {
    const id = waitId(stored.result.requestId, true);
    const written = await redis.set(resultKey(id), JSON.stringify(stored), 'EX', FINAL_RESULT_TTL_SEC, 'NX');
    if (written !== 'OK') {
      logger.debug({ requestId: stored.result.requestId }, 'OUI final result already held; later answer not kept');
      return;
    }
    await redis.publish(CHANNEL, id);
  }

  return {
    async store(userId, result) {
      const stored: StoredResult = { userId, result };
      if (result.interim !== true) await storeFinal(stored);
      const written = await redis.set(resultKey(result.requestId), JSON.stringify(stored), 'EX', RESULT_TTL_SEC, 'NX');
      if (written !== 'OK') {
        // An async action is answered twice (acknowledged, then finished). The
        // first wait gets the first; the finished answer is kept as the final
        // one (above), for a worker that waits on to it.
        logger.debug({ requestId: result.requestId, interim: result.interim }, 'OUI result already held; later answer not kept');
        return false;
      }
      await redis.publish(CHANNEL, result.requestId);
      return true;
    },

    async await(requestId, userId, waitMs, options = {}) {
      const id = waitId(requestId, options.final === true);
      return hub.wait(id, waitMs, () => read(requestId, userId, id), (err) =>
        logger.error({ err, requestId }, 'OUI result read failed'),
      );
    },

    pendingCount: () => hub.pendingCount(),
  };
}
