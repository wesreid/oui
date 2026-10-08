/**
 * Conversation holds (ADR-0260 §2.1): a person on the product's staff holds a
 * conversation, and while they do the agent does not answer it.
 *
 * One record per conversation, in Redis beside stop records and approvals, so
 * every instance, the worker and the product's API read one answer:
 *
 *   conversation:hold:{conversationId}  → hash { holderId, json }, TTL 7 days (a storage bound, not a policy)
 *
 * Take and release are each one script: of two staff members taking a
 * conversation at once exactly one holds it, and only its holder (or the
 * product, on its own authority) ends a hold. Taking one publishes on the
 * turn-stop channel, so a turn of the conversation waiting for its stop, on
 * any instance, hears that it was taken over.
 *
 * The store decides nothing about who may take a conversation: the product's
 * own route checks that before it asks (ADR-0260 §2.2).
 */
import { readConversationHold, type ConversationHold, type HandBackCause, type StaffSpeaker } from '@ouispec/agent-core';
import type { RealtimeLogger } from '../logger.js';
import { TURN_STOPS_CHANNEL, conversationWaitId } from '../turns/stops.js';

/** The Redis commands the store uses. ioredis satisfies it. */
export interface HoldRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
}

export type TakeOutcome =
  | { ok: true; change: 'taken_over' | 'already'; hold: ConversationHold }
  | { ok: false; reason: 'held'; hold: ConversationHold };

export type ReleaseOutcome =
  | { ok: true; change: 'handed_back'; hold: ConversationHold; by: HandBackCause }
  | { ok: true; change: 'not_held' }
  | { ok: false; reason: 'not_holder'; hold: ConversationHold };

export interface ConversationHoldStore {
  /** Who holds the conversation, or null. */
  get(conversationId: string): Promise<ConversationHold | null>;
  /** Hold it for `holder`; `already` when they hold it, refused with the hold when someone else does. */
  take(conversationId: string, holder: StaffSpeaker): Promise<TakeOutcome>;
  /**
   * End the hold. With `userId`, only when that user holds it (`by: 'holder'`);
   * without, on the product's own authority (`by: 'product'`).
   */
  release(conversationId: string, userId?: string): Promise<ReleaseOutcome>;
}

/** How long Redis keeps a hold nobody ended: a bound on storage, not a policy (ADR-0260 §2.1). */
export const HOLD_TTL_SEC = 7 * 24 * 60 * 60;

const holdKey = (conversationId: string) => `conversation:hold:${conversationId}`;

// KEYS: hold. ARGV: holderId, hold JSON, ttl s, channel, wait id.
const TAKE = `
local held = redis.call('HGET', KEYS[1], 'holderId')
if held then
  local json = redis.call('HGET', KEYS[1], 'json')
  if held == ARGV[1] then return {'already', json} end
  return {'held', json}
end
redis.call('HSET', KEYS[1], 'holderId', ARGV[1], 'json', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('PUBLISH', ARGV[4], ARGV[5])
return {'taken_over', ARGV[2]}`;

// KEYS: hold. ARGV: userId ('' for the product).
const RELEASE = `
local held = redis.call('HGET', KEYS[1], 'holderId')
if not held then return {'not_held'} end
local json = redis.call('HGET', KEYS[1], 'json')
if ARGV[1] ~= '' and held ~= ARGV[1] then return {'not_holder', json} end
redis.call('DEL', KEYS[1])
return {'handed_back', json}`;

export function createConversationHoldStore(redis: HoldRedis, logger: RealtimeLogger): ConversationHoldStore {
  /** A stored hold, read back strictly: a record this code did not write is no hold. */
  const parse = (json: unknown, conversationId: string): ConversationHold => {
    const hold = typeof json === 'string' ? readConversationHold(JSON.parse(json)) : null;
    if (!hold) throw new Error(`[agent-sdk-realtime] the hold of conversation ${conversationId} is not one this server wrote`);
    return hold;
  };

  return {
    async get(conversationId) {
      const json = await redis.hget(holdKey(conversationId), 'json');
      return json ? parse(json, conversationId) : null;
    },

    async take(conversationId, holder) {
      const hold: ConversationHold = { conversationId, holder, since: Date.now() };
      const [outcome, json] = (await redis.eval(
        TAKE,
        1,
        holdKey(conversationId),
        holder.userId,
        JSON.stringify(hold),
        HOLD_TTL_SEC,
        TURN_STOPS_CHANNEL,
        conversationWaitId(conversationId),
      )) as [string, string];
      const current = parse(json, conversationId);
      if (outcome === 'held') return { ok: false, reason: 'held', hold: current };
      if (outcome === 'taken_over') logger.info({ conversationId, holder: holder.userId }, 'Conversation taken over');
      return { ok: true, change: outcome === 'already' ? 'already' : 'taken_over', hold: current };
    },

    async release(conversationId, userId) {
      const [outcome, json] = (await redis.eval(RELEASE, 1, holdKey(conversationId), userId ?? '')) as [string, string | undefined];
      if (outcome === 'not_held') return { ok: true, change: 'not_held' };
      const hold = parse(json, conversationId);
      if (outcome === 'not_holder') return { ok: false, reason: 'not_holder', hold };
      const by: HandBackCause = userId ? 'holder' : 'product';
      logger.info({ conversationId, holder: hold.holder.userId, by }, 'Conversation handed back');
      return { ok: true, change: 'handed_back', hold, by };
    },
  };
}
