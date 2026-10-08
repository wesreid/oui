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
 *
 * A turn's conversation held by a person on the staff (ADR-0260 §2.3) is a
 * stop too, for every turn of that conversation, whoever's: a worker that
 * names its conversation is answered `taken_over` while the conversation is
 * held, and its wait wakes when a hold is taken (`conversation:{id}` on the
 * same channel).
 */
import { TURN_STOP_RECORD_TTL_MS, type TurnStopReason, type TurnStopRecord } from '@ouispec/agent-core';
import type { RealtimeLogger } from '../logger.js';
import { createWaitHub, type ResultsRedis, type ResultsSubscriber } from '../redis-waits.js';
import type { ConversationHoldStore } from '../conversations/holds.js';

export interface TurnStopStore {
  /**
   * Record that `userId` asks for `turnId` to stop. The first request stands:
   * a later one changes nothing and gets the first back, with `first: false`.
   */
  request(turnId: string, userId: string, reason: TurnStopReason): Promise<{ record: TurnStopRecord; first: boolean }>;
  /**
   * The stop `userId` asked for on `turnId`, waiting up to `waitMs` for one.
   * With `conversationId`, a hold on the conversation is a stop as well
   * (`taken_over`), and the user's own stop comes first.
   */
  await(turnId: string, userId: string, waitMs: number, conversationId?: string): Promise<TurnStopRecord | null>;
  /** Waits in progress on this instance. */
  pendingCount(): number;
}

/** The channel a stop, and a conversation's hold, is published on. */
export const TURN_STOPS_CHANNEL = 'turn:stops';
export const TURN_STOP_TTL_SEC = Math.ceil(TURN_STOP_RECORD_TTL_MS / 1000);

const waitId = (turnId: string, userId: string) => `${turnId}:${userId}`;
/** What a hold publishes, so every turn of the conversation waiting for its stop hears it. */
export const conversationWaitId = (conversationId: string) => `conversation:${conversationId}`;
const stopKey = (turnId: string, userId: string) => `turn:stop:${waitId(turnId, userId)}`;

export function createTurnStopStore(
  redis: ResultsRedis,
  subscriber: ResultsSubscriber,
  logger: RealtimeLogger,
  holds?: ConversationHoldStore,
): TurnStopStore {
  const hub = createWaitHub(subscriber, TURN_STOPS_CHANNEL, logger, 'Turn stops');

  async function read(turnId: string, userId: string, conversationId?: string): Promise<TurnStopRecord | null> {
    const raw = await redis.get(stopKey(turnId, userId));
    if (raw) return JSON.parse(raw) as TurnStopRecord;
    if (!conversationId || !holds) return null;
    const hold = await holds.get(conversationId);
    return hold ? { turnId, by: hold.holder.userId, reason: 'taken_over', at: hold.since } : null;
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
      await redis.publish(TURN_STOPS_CHANNEL, waitId(turnId, userId));
      logger.info({ turnId, userId, reason }, 'Turn stop requested');
      return { record, first: true };
    },

    async await(turnId, userId, waitMs, conversationId) {
      const ids = conversationId ? [waitId(turnId, userId), conversationWaitId(conversationId)] : waitId(turnId, userId);
      return hub.wait(ids, waitMs, () => read(turnId, userId, conversationId), (err) =>
        logger.error({ err, turnId }, 'Turn stop read failed'),
      );
    },

    pendingCount: () => hub.pendingCount(),
  };
}
