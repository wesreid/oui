/**
 * The approval store (ADR-0228 §2.4), beside the UI action result store and on
 * the same Redis, so every realtime instance sees every approval:
 *
 *   approval:{id}           → the pending call as the worker stored it (JSON,
 *                             never rewritten), TTL until it expires
 *   approval:{id}:state     → hash: status (pending | approved), userId,
 *                             conversationId, tool, argsHash, expiresAt, and
 *                             once approved the token's jti and the channel
 *   approval:declined:{id}  → what the next turn tells the model, 30 min
 *   approval:{id}:seen      → that it was asked for and has not run or been
 *                             declined (userId, conversationId, expiresAt,
 *                             and `decided: approved` once the user has
 *                             approved it): written with the approval,
 *                             rewritten in the script that approves it,
 *                             removed in the script that declines or redeems
 *                             it, and kept 30 days past its expiry. Present
 *                             with the approval gone, it expired without
 *                             having run: undecided, or approved and unused.
 *   approval:{id}:settled   → a turn's claim to store that expiry: a two
 *                             minute lease, permanent once confirmed
 *
 * Each decision and each redemption is one Lua script, so two instances can
 * never both approve one call, or both redeem one token. The stored call is
 * kept as the worker wrote it and never re-encoded inside Redis: Lua's JSON
 * would round numbers and turn `[]` into `{}`, and the redeemed call must be
 * exactly the one the user approved.
 */
import crypto from 'node:crypto';
import {
  APPROVAL_WITHDRAW_REASONS,
  argsHash as hashOf,
  EXPIRED_APPROVAL_MEMORY_MS,
  EXPIRY_CLAIM_LEASE_MS,
  MAX_APPROVAL_TTL_MS,
  type ApprovalChannel,
  type ApprovalDecideResult,
  type ApprovalDecision,
  type ApprovalOwner,
  type ApprovalRedeemResult,
  type ApprovalRefusal,
  type ApprovalRefusalReason,
  type ApprovalSettlement,
  type ApprovalStatus,
  type ApprovalWithdrawal,
  type ApprovalWithdrawReason,
  type ApprovedCall,
  type PendingApprovalInput,
} from '@ouispec/agent-core';
import type { RealtimeLogger } from '../logger.js';
import type { ApprovalTokenSigner } from './token.js';

/** The Redis command the store uses. ioredis satisfies it. */
export interface ApprovalRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ApprovalStore {
  /** Keep a pending approval until it expires. */
  create(input: PendingApprovalInput): Promise<{ ok: true; approvalId: string; argsHash: string; expiresAt: number } | ApprovalRefusal>;
  /** The user's decision. An approval's token is returned only here, to the decider. */
  decide(approvalId: string, by: { userId: string; decision: ApprovalDecision; channel: ApprovalChannel }): Promise<ApprovalDecideResult>;
  /** Atomic single use: the stored call, for a valid, unexpired, unused token of this user and conversation. */
  redeem(token: string, caller: { userId: string; conversationId: string }): Promise<ApprovalRedeemResult>;
  /** Where an approval of this user's stands, or null when it is not theirs or not known. */
  status(approvalId: string, userId: string): Promise<ApprovalStatus | null>;
  /**
   * Settle an approval a conversation still shows as waiting: whether it
   * expired undecided, and whether this caller holds the claim to store that.
   * One script, so of two turns asking together exactly one is `claimed`.
   * Expiry is the approval's keys lapsing in Redis: this server's clock is
   * not consulted, and nor is the caller's.
   */
  settleExpired(approvalId: string, owner: ApprovalOwner): Promise<ApprovalSettlement>;
  /** The claimed expiry is stored: the claim no longer lapses. False when the store does not know the approval as this owner's. */
  confirmExpirySettled(approvalId: string, owner: ApprovalOwner): Promise<boolean>;
  /**
   * Expire an approval now instead of at its time limit (ADR-0252 §2.6): the
   * person sent a new message while its card waited, or the turn that asked
   * was stopped. One script, with decide and redeem, so it cannot interleave
   * with either: a pending approval, or an approved one not yet used, is gone
   * from that moment, its memory kept with why. A later turn then settles it
   * as any expiry (`settleExpired`), and is told it was withdrawn.
   */
  withdraw(approvalId: string, owner: ApprovalOwner, reason: ApprovalWithdrawReason): Promise<ApprovalWithdrawal>;
}

/** How long a decline is remembered for the turn that follows it. */
export const DECLINED_TTL_SEC = 30 * 60;

const recordKey = (id: string) => `approval:${id}`;
const stateKey = (id: string) => `approval:${id}:state`;
const declinedKey = (id: string) => `approval:declined:${id}`;
const seenKey = (id: string) => `approval:${id}:seen`;
const settledKey = (id: string) => `approval:${id}:settled`;
const withdrawnKey = (id: string) => `approval:${id}:withdrawn`;

// KEYS: record, state, declined, seen, settled, withdrawn. ARGV: record JSON, ttl ms, userId, conversationId, tool,
// argsHash, expiresAt, seen JSON, seen ttl ms.
// A new approval supersedes an old decline under the same id, an old expiry's settlement, and an old withdrawal.
const CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 'exists' end
redis.call('DEL', KEYS[3], KEYS[5], KEYS[6])
redis.call('SET', KEYS[4], ARGV[8], 'PX', ARGV[9])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('HSET', KEYS[2], 'status', 'pending', 'userId', ARGV[3], 'conversationId', ARGV[4], 'tool', ARGV[5], 'argsHash', ARGV[6], 'expiresAt', ARGV[7])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return 'ok'`;

// KEYS: state, record, declined, seen. ARGV: userId, decision, now ms, jti, channel, declined ttl s, declined JSON,
// seen JSON once approved.
// A decline decides it: it is no longer something that can expire. An approval is recorded in the
// memory (same TTL), so if the approved call is never run its expiry is not told as "undecided".
const DECIDE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'unknown'} end
local s = redis.call('HMGET', KEYS[1], 'status', 'userId', 'expiresAt')
if s[2] ~= ARGV[1] then return {'forbidden'} end
if s[1] ~= 'pending' then return {'decided'} end
if tonumber(ARGV[3]) >= tonumber(s[3]) then return {'expired'} end
local record = redis.call('GET', KEYS[2])
if ARGV[2] == 'approve' then
  redis.call('HSET', KEYS[1], 'status', 'approved', 'jti', ARGV[4], 'channel', ARGV[5])
  if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('SET', KEYS[4], ARGV[8], 'KEEPTTL') end
  return {'approved', record}
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[4])
redis.call('SET', KEYS[3], ARGV[7], 'EX', ARGV[6])
return {'declined', record}`;

// KEYS: state, record, seen. ARGV: jti, argsHash, tool, userId, conversationId.
// A redemption uses it: it did not expire undecided.
const REDEEM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'used'} end
local s = redis.call('HMGET', KEYS[1], 'status', 'jti', 'argsHash', 'tool', 'userId', 'conversationId', 'channel')
if s[1] ~= 'approved' or s[2] ~= ARGV[1] or s[3] ~= ARGV[2] or s[4] ~= ARGV[3] or s[5] ~= ARGV[4] or s[6] ~= ARGV[5] then
  return {'mismatch'}
end
local record = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {'ok', record, s[7]}`;

// KEYS: state, record, seen, withdrawn. ARGV: userId, conversationId, reason.
// Expire-now. A pending approval, or an approved one not yet redeemed, loses its state and record,
// which is exactly what its time running out does: a decision is then refused, a token redeemed
// after it answers 'used', and SETTLE finds "state gone, seen present". The memory (seen) is left
// as it is, so one the person had approved still says 'approved'; why it was withdrawn is kept
// beside it for as long as the memory lasts.
const WITHDRAW = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  local seen = redis.call('GET', KEYS[3])
  if not seen then return 'unknown' end
  local m = cjson.decode(seen)
  if m['userId'] ~= ARGV[1] or m['conversationId'] ~= ARGV[2] then return 'unknown' end
  return 'settled'
end
local o = redis.call('HMGET', KEYS[1], 'userId', 'conversationId')
if o[1] ~= ARGV[1] or o[2] ~= ARGV[2] then return 'unknown' end
redis.call('DEL', KEYS[1], KEYS[2])
local left = redis.call('PTTL', KEYS[3])
if left > 0 then redis.call('SET', KEYS[4], ARGV[3], 'PX', left) end
return 'withdrawn'`;

// KEYS: state, seen, settled, withdrawn. ARGV: userId, conversationId, lease ms.
// The approval's own keys lapse in Redis at its expiry, so "state gone, seen present" is this
// server's Redis saying it expired undecided. The claim is one SET NX: exactly one caller gets it,
// and it lapses unless confirmed. An approval that was withdrawn says why.
const SETTLE = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local o = redis.call('HMGET', KEYS[1], 'userId', 'conversationId')
  if o[1] ~= ARGV[1] or o[2] ~= ARGV[2] then return {'unknown'} end
  return {'open'}
end
local seen = redis.call('GET', KEYS[2])
if not seen then return {'unknown'} end
local m = cjson.decode(seen)
if m['userId'] ~= ARGV[1] or m['conversationId'] ~= ARGV[2] then return {'unknown'} end
local withdrawn = redis.call('GET', KEYS[4]) or ''
if redis.call('SET', KEYS[3], 'lease', 'NX', 'PX', ARGV[3]) then return {'claimed', seen, withdrawn} end
return {'already', seen, withdrawn}`;

// KEYS: state, seen, settled. ARGV: userId, conversationId, memory ms.
// The expiry is stored in the conversation: the claim stays for as long as the memory of the approval does.
// A confirmation with no live claim (the lease lapsed while the host was storing) is still kept, and said.
const CONFIRM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'unknown' end
local seen = redis.call('GET', KEYS[2])
if not seen then return 'unknown' end
local m = cjson.decode(seen)
if m['userId'] ~= ARGV[1] or m['conversationId'] ~= ARGV[2] then return 'unknown' end
local claimed = redis.call('EXISTS', KEYS[3])
redis.call('SET', KEYS[3], 'confirmed', 'PX', ARGV[3])
if claimed == 1 then return 'confirmed' end
return 'unclaimed'`;

// KEYS: state, record, declined. ARGV: userId. A live approval first, then a remembered decline.
const STATUS = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local s = redis.call('HMGET', KEYS[1], 'status', 'userId')
  if s[2] ~= ARGV[1] then return {'unknown'} end
  return {s[1], redis.call('GET', KEYS[2])}
end
local d = redis.call('GET', KEYS[3])
if d then return {'declined', d} end
return {'unknown'}`;

interface Declined {
  userId: string;
  tool: string;
  title: string;
}

const refusal = (reason: ApprovalRefusalReason, error: string): ApprovalRefusal => ({ ok: false, reason, error });

const REFUSALS: Partial<Record<string, string>> = {
  unknown: 'no such approval is waiting: it was never asked for, was already decided and used, or has expired',
  forbidden: "this approval is another user's",
  decided: 'this approval has already been decided',
  expired: 'this approval has expired',
  used: 'this approval has already been used',
  mismatch: 'this token is not for the stored call',
};

type Seen =
  | { kind: 'open'; status: 'pending' | 'approved'; pending: PendingApprovalInput }
  | { kind: 'declined'; declined: Declined }
  | { kind: 'unknown' };

export interface ApprovalStoreOptions {
  /** How long a turn's claim on an expiry lasts unconfirmed. Default `EXPIRY_CLAIM_LEASE_MS`; shorter in tests. */
  expiryClaimLeaseMs?: number;
}

export function createApprovalStore(
  redis: ApprovalRedis,
  signer: ApprovalTokenSigner,
  logger: RealtimeLogger,
  options: ApprovalStoreOptions = {},
): ApprovalStore {
  const expiryClaimLeaseMs = options.expiryClaimLeaseMs ?? EXPIRY_CLAIM_LEASE_MS;
  /** An approval as this user may see it. */
  async function read(approvalId: string, userId: string): Promise<Seen> {
    const [status, raw] = ((await redis.eval(STATUS, 3, stateKey(approvalId), recordKey(approvalId), declinedKey(approvalId), userId)) ??
      []) as [string | undefined, string | undefined];
    if (status === 'declined' && raw) return { kind: 'declined', declined: JSON.parse(raw) as Declined };
    if ((status === 'pending' || status === 'approved') && raw) return { kind: 'open', status, pending: JSON.parse(raw) as PendingApprovalInput };
    return { kind: 'unknown' };
  }

  /** What every log record about an approval carries; the arguments only when their declaration says they are not sensitive. */
  const audit = (p: PendingApprovalInput, extra: Record<string, unknown> = {}) => ({
    approvalId: p.approvalId,
    userId: p.userId,
    conversationId: p.conversationId,
    tool: p.tool,
    effect: p.effect,
    destructive: p.destructive,
    argsHash: p.argsHash,
    ...(p.argsSensitive === false ? { args: p.args } : {}),
    ...extra,
  });

  return {
    async create(input) {
      const now = Date.now();
      if (input.approvalId !== input.toolCallId) return refusal('invalid', 'approvalId must be the tool call id');
      if (!(input.expiresAt > now)) return refusal('invalid', 'expiresAt must be in the future');
      if (input.expiresAt - now > MAX_APPROVAL_TTL_MS) {
        return refusal('invalid', `an approval lasts at most ${MAX_APPROVAL_TTL_MS / 60_000} minutes`);
      }
      let computed: string;
      try {
        computed = await hashOf(input.args);
      } catch (err) {
        return refusal('invalid', err instanceof Error ? err.message : String(err));
      }
      if (computed !== input.argsHash) return refusal('invalid', 'argsHash does not match the arguments');

      const seen = { userId: input.userId, conversationId: input.conversationId, expiresAt: input.expiresAt };
      const result = await redis.eval(
        CREATE,
        6,
        recordKey(input.approvalId),
        stateKey(input.approvalId),
        declinedKey(input.approvalId),
        seenKey(input.approvalId),
        settledKey(input.approvalId),
        withdrawnKey(input.approvalId),
        JSON.stringify(input),
        input.expiresAt - now,
        input.userId,
        input.conversationId,
        input.tool,
        input.argsHash,
        input.expiresAt,
        JSON.stringify(seen),
        input.expiresAt - now + EXPIRED_APPROVAL_MEMORY_MS,
      );
      if (result !== 'ok') return refusal('decided', `an approval ${input.approvalId} already exists`);
      logger.info(audit(input, { expiresAt: input.expiresAt }), 'Approval stored');
      return { ok: true, approvalId: input.approvalId, argsHash: input.argsHash, expiresAt: input.expiresAt };
    },

    async decide(approvalId, { userId, decision, channel }) {
      const jti = crypto.randomUUID();
      // What a decline is remembered by: the call's tool and title, from its
      // record, which never changes once stored.
      const seen = await read(approvalId, userId);
      const declined: Declined = {
        userId,
        tool: seen.kind === 'open' ? seen.pending.tool : '',
        title: seen.kind === 'open' ? seen.pending.preview.title : '',
      };

      const [outcome, raw] = (await redis.eval(
        DECIDE,
        4,
        stateKey(approvalId),
        recordKey(approvalId),
        declinedKey(approvalId),
        seenKey(approvalId),
        userId,
        decision,
        Date.now(),
        jti,
        channel,
        DECLINED_TTL_SEC,
        JSON.stringify(declined),
        // The memory of the approval once it is approved: written by the script, never re-encoded in Lua.
        seen.kind === 'open'
          ? JSON.stringify({ userId: seen.pending.userId, conversationId: seen.pending.conversationId, expiresAt: seen.pending.expiresAt, decided: 'approved' })
          : '',
      )) as [string, string | undefined];

      if (outcome !== 'approved' && outcome !== 'declined') {
        logger.warn({ approvalId, userId, decision, channel, reason: outcome }, 'Approval decision refused');
        return refusal(outcome as ApprovalRefusalReason, REFUSALS[outcome] ?? outcome);
      }
      const pending = JSON.parse(raw!) as PendingApprovalInput;
      if (outcome === 'declined') {
        logger.info(audit(pending, { channel }), 'Approval declined');
        return { ok: true, decision: 'decline', approvalId };
      }
      const token = signer.sign({
        aid: approvalId,
        sub: pending.userId,
        cid: pending.conversationId,
        tool: pending.tool,
        ah: pending.argsHash,
        eff: pending.effect,
        ch: channel,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(pending.expiresAt / 1000),
        jti,
      });
      logger.info(audit(pending, { channel, expiresAt: pending.expiresAt }), 'Approval approved');
      return { ok: true, decision: 'approve', approvalId, token, argsHash: pending.argsHash, expiresAt: pending.expiresAt, channel };
    },

    async redeem(token, caller) {
      const checked = signer.verify(token);
      if (!checked.ok) {
        logger.warn({ userId: caller.userId, conversationId: caller.conversationId, reason: checked.reason, error: checked.error }, 'Approval redemption refused');
        return refusal(checked.reason, checked.reason === 'expired' ? (REFUSALS.expired as string) : `not a valid approval token: ${checked.error}`);
      }
      const { claims } = checked;
      const context = { approvalId: claims.aid, userId: caller.userId, tool: claims.tool, effect: claims.eff, channel: claims.ch, argsHash: claims.ah };
      if (claims.sub !== caller.userId || claims.cid !== caller.conversationId) {
        logger.warn({ ...context, tokenUser: claims.sub, reason: 'forbidden' }, 'Approval redemption refused');
        return refusal('forbidden', "this approval is another user's or another conversation's");
      }
      const [outcome, raw, channel] = (await redis.eval(
        REDEEM,
        3,
        stateKey(claims.aid),
        recordKey(claims.aid),
        seenKey(claims.aid),
        claims.jti,
        claims.ah,
        claims.tool,
        claims.sub,
        claims.cid,
      )) as [string, string | undefined, string | undefined];
      if (outcome !== 'ok') {
        logger.warn({ ...context, reason: outcome }, 'Approval redemption refused');
        return refusal(outcome as ApprovalRefusalReason, REFUSALS[outcome] ?? outcome);
      }
      const p = JSON.parse(raw!) as PendingApprovalInput;
      const call: ApprovedCall = {
        approvalId: p.approvalId,
        toolCallId: p.toolCallId,
        conversationId: p.conversationId,
        turnId: p.turnId,
        userId: p.userId,
        tool: p.tool,
        args: p.args,
        argsHash: p.argsHash,
        effect: p.effect,
        destructive: p.destructive,
        channel: channel as ApprovalChannel,
      };
      logger.info(audit(p, { channel }), 'Approval redeemed');
      return { ok: true, call };
    },

    async status(approvalId, userId) {
      const seen = await read(approvalId, userId);
      if (seen.kind === 'declined') {
        return seen.declined.userId === userId ? { approvalId, status: 'declined', tool: seen.declined.tool, title: seen.declined.title } : null;
      }
      if (seen.kind === 'open') return { approvalId, status: seen.status, tool: seen.pending.tool, title: seen.pending.preview.title };
      return null;
    },

    async settleExpired(approvalId, { userId, conversationId }) {
      const [outcome, raw, why] = ((await redis.eval(
        SETTLE,
        4,
        stateKey(approvalId),
        seenKey(approvalId),
        settledKey(approvalId),
        withdrawnKey(approvalId),
        userId,
        conversationId,
        expiryClaimLeaseMs,
      )) ?? []) as [string | undefined, string | undefined, string | undefined];
      if (outcome === 'open') return { approvalId, outcome };
      if ((outcome === 'claimed' || outcome === 'already') && raw) {
        const { expiresAt, decided } = JSON.parse(raw) as { expiresAt: number; decided?: 'approved' };
        const withdrawn = (APPROVAL_WITHDRAW_REASONS as readonly string[]).includes(why ?? '') ? (why as ApprovalWithdrawReason) : null;
        if (outcome === 'claimed') {
          logger.info(
            { approvalId, userId, conversationId, expiresAt, decided: decided ?? null, withdrawn },
            'Approval expired without running: claimed for a turn to store',
          );
        }
        return { approvalId, outcome, expiresAt, ...(decided === 'approved' ? { decided } : {}), ...(withdrawn ? { withdrawn } : {}) };
      }
      return { approvalId, outcome: 'unknown' };
    },

    async withdraw(approvalId, { userId, conversationId }, reason) {
      const outcome = (await redis.eval(
        WITHDRAW,
        4,
        stateKey(approvalId),
        recordKey(approvalId),
        seenKey(approvalId),
        withdrawnKey(approvalId),
        userId,
        conversationId,
        reason,
      )) as ApprovalWithdrawal['outcome'] | null;
      if (outcome === 'withdrawn') logger.info({ approvalId, userId, conversationId, reason }, 'Approval withdrawn before it was used');
      return { approvalId, outcome: outcome === 'withdrawn' || outcome === 'settled' ? outcome : 'unknown' };
    },

    async confirmExpirySettled(approvalId, { userId, conversationId }) {
      const outcome = await redis.eval(
        CONFIRM,
        3,
        stateKey(approvalId),
        seenKey(approvalId),
        settledKey(approvalId),
        userId,
        conversationId,
        EXPIRED_APPROVAL_MEMORY_MS,
      );
      if (outcome === 'confirmed') logger.info({ approvalId, userId, conversationId }, 'Approval expiry stored in the conversation');
      if (outcome === 'unclaimed') {
        // The turn's claim had lapsed before it confirmed: another turn may have claimed and stored the expiry too.
        logger.warn({ approvalId, userId, conversationId }, 'Approval expiry confirmed with no live claim: the lease had lapsed, so it may be stored twice');
      }
      return outcome === 'confirmed' || outcome === 'unclaimed';
    },
  };
}
