/**
 * Job settlements, kept for the workers that wait on them (W9).
 *
 * Every declared completion or failure the server emits settles one job: the
 * job of its kind whose id is in its correlation field. The first is kept, so
 * a worker on any instance can ask how the job ended without joining a room,
 * even when it asks after the event went out:
 *
 *   events:settlement:{kind}:{id}  → JSON Settlement, TTL 35 min, first wins
 *   channel events:settlements     → `{kind}:{id}`, published when one is kept
 *
 * The emitter is the product's backend, trusted by the internal key; so is
 * the worker that reads. No browser reaches either.
 */
import type { Settlement } from '@ouispec/agent-events';
import type { RealtimeLogger } from '../logger.js';
import { createWaitHub, type ResultsRedis, type ResultsSubscriber } from '../redis-waits.js';

const CHANNEL = 'events:settlements';
/** As long as the longest wait on a job may run, with margin: the same horizon as a final UI action result. */
export const SETTLEMENT_TTL_SEC = 35 * 60;

const settlementId = (kind: string, id: string) => `${kind}:${id}`;
const settlementKey = (kind: string, id: string) => `events:settlement:${settlementId(kind, id)}`;

export interface SettlementStore {
  /** Keep a job's settlement. Returns false when the job was already settled. */
  record(settlement: Settlement): Promise<boolean>;
  /** The job's settlement, waiting up to `waitMs` for it. */
  await(kind: string, id: string, waitMs: number): Promise<Settlement | null>;
  pendingCount(): number;
}

export function createSettlementStore(redis: ResultsRedis, subscriber: ResultsSubscriber, logger: RealtimeLogger): SettlementStore {
  const hub = createWaitHub(subscriber, CHANNEL, logger, 'Settlements');

  async function read(kind: string, id: string): Promise<Settlement | null> {
    const raw = await redis.get(settlementKey(kind, id));
    return raw ? (JSON.parse(raw) as Settlement) : null;
  }

  return {
    async record(settlement) {
      const written = await redis.set(
        settlementKey(settlement.kind, settlement.id),
        JSON.stringify(settlement),
        'EX',
        SETTLEMENT_TTL_SEC,
        'NX',
      );
      if (written !== 'OK') {
        logger.info(
          { kind: settlement.kind, id: settlement.id, event: settlement.event },
          'Job already settled; later settlement not kept',
        );
        return false;
      }
      await redis.publish(CHANNEL, settlementId(settlement.kind, settlement.id));
      return true;
    },

    await(kind, id, waitMs) {
      return hub.wait(settlementId(kind, id), waitMs, () => read(kind, id), (err) =>
        logger.error({ err, kind, id }, 'Settlement read failed'),
      );
    },

    pendingCount: () => hub.pendingCount(),
  };
}
