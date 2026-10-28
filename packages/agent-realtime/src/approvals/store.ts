/**
 * The approval store, beside the UI action result store and on
 * the same Redis, so every realtime instance sees every approval:
 *
 *   approval:{id}           → the pending call as the worker stored it (JSON,
 *                             never rewritten), TTL until it expires
 *   approval:{id}:state     → hash: status (pending | approved), userId,
 *                             conversationId, tool, argsHash, expiresAt, the
 *                             receipt's audience (fixed here, empty for none),
 *                             the tool's kind (`ui` for an action on the
 *                             person's page) and, for one, the room of the
 *                             turn that asked; once approved the token's jti
 *                             and the channel
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
 *   approval:{id}:grant     → for an action on the person's page approved
 *                             by voice, on the phone or in chat: the
 *                             single-use grant pushed to its room (grantId,
 *                             userId, conversationId, room, argsHash,
 *                             expiresAt, channel, and the claiming socket once
 *                             claimed), written in the script that approves
 *                             it, until the grant expires (ADR-0284)
 *   approval:conversation:{conversationId}
 *                           → set of the conversation's approval ids, kept as
 *                             long as its longest-lived approval: what a
 *                             take-over withdraws (`withdrawOpen`). An id
 *                             whose approval has gone is removed then.
 *
 * Each decision, each claim and each redemption is one Lua script, so two
 * instances can never both approve one call, both hand one grant to a tab, or
 * both redeem one token. The stored call is
 * kept as the worker wrote it and never re-encoded inside Redis: Lua's JSON
 * would round numbers and turn `[]` into `{}`, and the redeemed call must be
 * exactly the one the user approved.
 *
 * With receipt keys, a redemption also signs a receipt for the call
 * (receipt.ts): for the audience fixed when the approval was stored, never one
 * chosen at redemption. A UI action gets none.
 */
import crypto from 'node:crypto';
import {
  APPROVAL_GRANT_TTL_MS,
  APPROVAL_PUSH_EVENTS,
  APPROVAL_WITHDRAW_REASONS,
  approvalReceiptAudience,
  approvesUIByReadback,
  argsHash as hashOf,
  EXPIRED_APPROVAL_MEMORY_MS,
  EXPIRY_CLAIM_LEASE_MS,
  MAX_APPROVAL_TTL_MS,
  type ApprovalChannel,
  type ApprovalClaimResult,
  type ApprovalDecideResult,
  type ApprovalDeclinedEvent,
  type ApprovalGrantedEvent,
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
import type { ApprovalReceiptSigner } from './receipt.js';

/** The Redis command the store uses. ioredis satisfies it. */
export interface ApprovalRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ApprovalStore {
  /** Keep a pending approval until it expires. */
  create(input: PendingApprovalInput): Promise<{ ok: true; approvalId: string; argsHash: string; expiresAt: number } | ApprovalRefusal>;
  /**
   * The user's decision. An approval's token is returned only here, to the
   * decider. An action on the person's page approved on `voice`, `phone` or
   * `chat` also gets a single-use grant, pushed to the room stored with it
   * (`agent:approval_granted`); declined in any conversation channel, the
   * decline is pushed there (`agent:approval_declined`).
   */
  decide(approvalId: string, by: { userId: string; decision: ApprovalDecision; channel: ApprovalChannel }): Promise<ApprovalDecideResult>;
  /**
   * A tab takes the grant pushed to its room: answered with the grant only for
   * the first claim, from a socket of the approval's user that is in the
   * grant's room, before the grant expires.
   */
  claim(approvalId: string, grantId: string, claimer: ApprovalClaimer): Promise<ApprovalClaimResult>;
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
   * Expire an approval now instead of at its time limit: the
   * person sent a new message while its card waited, or the turn that asked
   * was stopped. One script, with decide and redeem, so it cannot interleave
   * with either: a pending approval, or an approved one not yet used, is gone
   * from that moment, its memory kept with why. A later turn then settles it
   * as any expiry (`settleExpired`), and is told it was withdrawn.
   */
  withdraw(approvalId: string, owner: ApprovalOwner, reason: ApprovalWithdrawReason): Promise<ApprovalWithdrawal>;
  /**
   * Withdraw every approval of a conversation that is still waiting, or
   * approved and not yet used, whoever's turn asked for it: a person on the
   * staff took the conversation over, and did not ask for any of them. Each
   * as `withdraw` does it. Resolves with the ids withdrawn.
   */
  withdrawOpen(conversationId: string, reason: ApprovalWithdrawReason): Promise<string[]>;
}

/** Who claims a pushed grant: the socket's verified user, the socket, and the rooms it is in now. */
export interface ApprovalClaimer {
  userId: string;
  socketId: string;
  rooms: readonly string[];
}

/** How long a decline is remembered for the turn that follows it. */
export const DECLINED_TTL_SEC = 30 * 60;

const recordKey = (id: string) => `approval:${id}`;
const stateKey = (id: string) => `approval:${id}:state`;
const declinedKey = (id: string) => `approval:declined:${id}`;
const seenKey = (id: string) => `approval:${id}:seen`;
const settledKey = (id: string) => `approval:${id}:settled`;
const withdrawnKey = (id: string) => `approval:${id}:withdrawn`;
const grantKey = (id: string) => `approval:${id}:grant`;
const conversationKey = (conversationId: string) => `approval:conversation:${conversationId}`;

// KEYS: record, state, declined, seen, settled, withdrawn, conversation. ARGV: record JSON, ttl ms, userId,
// conversationId, tool, argsHash, expiresAt, seen JSON, seen ttl ms, receipt audience ('' for none), tool kind,
// approval id, room ('' for none).
// A new approval supersedes an old decline under the same id, an old expiry's settlement, and an old withdrawal.
// The conversation's set of approvals lasts as long as its longest-lived one.
const CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 'exists' end
redis.call('DEL', KEYS[3], KEYS[5], KEYS[6])
redis.call('SET', KEYS[4], ARGV[8], 'PX', ARGV[9])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('HSET', KEYS[2], 'status', 'pending', 'userId', ARGV[3], 'conversationId', ARGV[4], 'tool', ARGV[5], 'argsHash', ARGV[6], 'expiresAt', ARGV[7], 'audience', ARGV[10], 'toolKind', ARGV[11], 'room', ARGV[13])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[7], ARGV[12])
if redis.call('PTTL', KEYS[7]) < tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[7], ARGV[2]) end
return 'ok'`;

// KEYS: state, record, declined, seen, grant. ARGV: userId, decision, now ms, jti, channel, declined ttl s, declined
// JSON, seen JSON once approved, whether this channel may approve an action on the person's page by its readback
// ('1' or '0'), grant id, grant ttl ms.
// A decline decides it: it is no longer something that can expire. An approval is recorded in the
// memory (same TTL), so if the approved call is never run its expiry is not told as "undecided".
// An action on the person's page is approved by its card, or by its readback on a channel that may (ADR-0284): then
// only with the room stored with it, where the single-use grant is written for the tab to claim. The grant lasts
// until the approval expires or its own ttl runs out, whichever is first. Answers the room for the store to push to.
const DECIDE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'unknown'} end
local s = redis.call('HMGET', KEYS[1], 'status', 'userId', 'expiresAt', 'toolKind', 'room', 'conversationId', 'argsHash')
if s[2] ~= ARGV[1] then return {'forbidden'} end
if s[1] ~= 'pending' then return {'decided'} end
local now = tonumber(ARGV[3])
if now >= tonumber(s[3]) then return {'expired'} end
local onPage = s[4] == 'ui' and ARGV[5] ~= 'ui'
local room = s[5] or ''
if ARGV[2] == 'approve' and onPage and (ARGV[9] ~= '1' or room == '') then return {'channel'} end
local record = redis.call('GET', KEYS[2])
if ARGV[2] == 'approve' then
  redis.call('HSET', KEYS[1], 'status', 'approved', 'jti', ARGV[4], 'channel', ARGV[5])
  if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('SET', KEYS[4], ARGV[8], 'KEEPTTL') end
  if not onPage then return {'approved', record} end
  local until_ = math.min(now + tonumber(ARGV[11]), tonumber(s[3]))
  redis.call('DEL', KEYS[5])
  redis.call('HSET', KEYS[5], 'grantId', ARGV[10], 'userId', s[2], 'conversationId', s[6], 'room', room, 'argsHash', s[7], 'expiresAt', tostring(until_), 'channel', ARGV[5], 'claimed', '')
  -- Kept a minute past its end, so a late or replayed claim is told why.
  redis.call('PEXPIRE', KEYS[5], until_ - now + 60000)
  return {'approved', record, room, tostring(until_)}
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[4])
redis.call('SET', KEYS[3], ARGV[7], 'EX', ARGV[6])
if onPage then return {'declined', record, room} end
return {'declined', record}`;

// KEYS: grant. ARGV: grant id, userId, now ms, socket id, the socket's rooms (JSON array).
// The first claim from the approval's user, on a socket in the grant's room, before it expires, takes it. The grant
// is kept until it expires, so a replayed claim is refused as used.
const CLAIM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'unknown'} end
local g = redis.call('HMGET', KEYS[1], 'grantId', 'userId', 'room', 'expiresAt', 'claimed', 'argsHash', 'channel')
if g[1] ~= ARGV[1] then return {'mismatch'} end
if g[2] ~= ARGV[2] then return {'forbidden'} end
if tonumber(ARGV[3]) >= tonumber(g[4]) then return {'expired'} end
local inRoom = false
for _, r in ipairs(cjson.decode(ARGV[5])) do if r == g[3] then inRoom = true end end
if not inRoom then return {'forbidden'} end
if g[5] ~= '' then return {'used'} end
redis.call('HSET', KEYS[1], 'claimed', ARGV[4])
return {'ok', g[6], g[4], g[7], g[3]}`;

// KEYS: state, record, seen. ARGV: jti, argsHash, tool, userId, conversationId.
// A redemption uses it: it did not expire undecided. It answers the receipt audience fixed at creation.
const REDEEM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'used'} end
local s = redis.call('HMGET', KEYS[1], 'status', 'jti', 'argsHash', 'tool', 'userId', 'conversationId', 'channel', 'audience')
if s[1] ~= 'approved' or s[2] ~= ARGV[1] or s[3] ~= ARGV[2] or s[4] ~= ARGV[3] or s[5] ~= ARGV[4] or s[6] ~= ARGV[5] then
  return {'mismatch'}
end
local record = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {'ok', record, s[7], s[8] or ''}`;

// KEYS: state, record, seen, withdrawn, grant, and the conversation's set when the hold withdraws it. ARGV: userId (''
// for any user of the conversation: the server's own authority, on a take-over), conversationId, reason, approval id.
// Expire-now. A pending approval, or an approved one not yet redeemed, loses its state and record,
// which is exactly what its time running out does: a decision is then refused, a token redeemed
// after it answers 'used', and SETTLE finds "state gone, seen present". The memory (seen) is left
// as it is, so one the person had approved still says 'approved'; why it was withdrawn is kept
// beside it for as long as the memory lasts. A grant pushed for it and not yet claimed can no longer be claimed.
const WITHDRAW = `
if KEYS[6] then redis.call('SREM', KEYS[6], ARGV[4]) end
if redis.call('EXISTS', KEYS[1]) == 0 then
  local seen = redis.call('GET', KEYS[3])
  if not seen then return 'unknown' end
  local m = cjson.decode(seen)
  if (ARGV[1] ~= '' and m['userId'] ~= ARGV[1]) or m['conversationId'] ~= ARGV[2] then return 'unknown' end
  return 'settled'
end
local o = redis.call('HMGET', KEYS[1], 'userId', 'conversationId')
if (ARGV[1] ~= '' and o[1] ~= ARGV[1]) or o[2] ~= ARGV[2] then return 'unknown' end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[5])
local left = redis.call('PTTL', KEYS[3])
if left > 0 then redis.call('SET', KEYS[4], ARGV[3], 'PX', left) end
return 'withdrawn'`;

// KEYS: conversation set. The conversation's approval ids.
const OPEN_IN_CONVERSATION = `return redis.call('SMEMBERS', KEYS[1])`;

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
  channel:
    "an action on the person's page is approved on its card, or by its readback by voice, on the phone or in chat when it was stored with its turn's room; never by SMS",
};

const CLAIM_REFUSALS: Partial<Record<string, string>> = {
  unknown: 'no such grant is waiting: it was never pushed, was withdrawn, or has expired',
  mismatch: 'this is not the grant that was pushed',
  forbidden: "this grant is another user's, or this tab is not in its room",
  expired: 'this grant has expired',
  used: 'another tab has already taken this grant',
};

type Seen =
  | { kind: 'open'; status: 'pending' | 'approved'; pending: PendingApprovalInput }
  | { kind: 'declined'; declined: Declined }
  | { kind: 'unknown' };

export interface ApprovalStoreOptions {
  /** How long a turn's claim on an expiry lasts unconfirmed. Default `EXPIRY_CLAIM_LEASE_MS`; shorter in tests. */
  expiryClaimLeaseMs?: number;
  /**
   * Receipts: the signer, and the audience of a host tool that names none.
   * Without them no audience is stored and no receipt is issued.
   */
  receipts?: { signer: ApprovalReceiptSigner; defaultAudience: string };
  /**
   * Sends a server event to a room: how a grant or a decline reaches the tab
   * of an action on the person's page decided in a conversation channel. The
   * realtime server passes its socket.io server's. Without it, nothing is
   * pushed, and an action on the person's page is approved only on its card.
   */
  push?: (room: string, event: string, payload: ApprovalGrantedEvent | ApprovalDeclinedEvent) => void;
}

export function createApprovalStore(
  redis: ApprovalRedis,
  signer: ApprovalTokenSigner,
  logger: RealtimeLogger,
  options: ApprovalStoreOptions = {},
): ApprovalStore {
  const expiryClaimLeaseMs = options.expiryClaimLeaseMs ?? EXPIRY_CLAIM_LEASE_MS;
  const receipts = options.receipts ?? null;
  const push = options.push ?? null;

  /**
   * The receipt audience, fixed as the approval is stored: none for a UI action
   * (the browser checks its own grant), the tool's own for a host or API tool,
   * else the product's default. None at all without receipt keys.
   */
  const audienceOf = (input: PendingApprovalInput): { ok: true; audience: string } | ApprovalRefusal => {
    if (input.audience !== undefined && approvalReceiptAudience(input.audience) !== input.audience) {
      return refusal('invalid', `audience "${input.audience}" is not an origin (scheme, host and port)`);
    }
    if (input.toolKind === 'ui') {
      return input.audience === undefined ? { ok: true, audience: '' } : refusal('invalid', 'a UI action gets no receipt, so it names no audience');
    }
    if (input.room !== undefined) return refusal('invalid', "only an action on the person's page names the room of its turn");
    if (!receipts) return { ok: true, audience: '' };
    return { ok: true, audience: input.audience ?? receipts.defaultAudience };
  };
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

  /**
   * The receipt for a redeemed call. The call is already used when this runs,
   * so a signing failure loses only the receipt: the call is still returned,
   * the tool refuses it for want of one, and the failure is logged.
   */
  const issueReceipt = (p: PendingApprovalInput, channel: ApprovalChannel, audience: string) => {
    if (!receipts) return null;
    try {
      return receipts.signer.issue({
        aud: audience,
        approvalId: p.approvalId,
        argsHash: p.argsHash,
        tool: p.tool,
        ...(p.operationId ? { operationId: p.operationId } : {}),
        conversationId: p.conversationId,
        userId: p.userId,
        ...(p.accountId ? { accountId: p.accountId } : {}),
        channel,
      });
    } catch (err) {
      logger.error({ ...audit(p, { channel }), audience, error: err instanceof Error ? err.message : String(err) }, 'Approval receipt could not be signed');
      return null;
    }
  };

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
      const audience = audienceOf(input);
      if (!audience.ok) return audience;

      const seen = { userId: input.userId, conversationId: input.conversationId, expiresAt: input.expiresAt };
      const result = await redis.eval(
        CREATE,
        7,
        recordKey(input.approvalId),
        stateKey(input.approvalId),
        declinedKey(input.approvalId),
        seenKey(input.approvalId),
        settledKey(input.approvalId),
        withdrawnKey(input.approvalId),
        conversationKey(input.conversationId),
        JSON.stringify(input),
        input.expiresAt - now,
        input.userId,
        input.conversationId,
        input.tool,
        input.argsHash,
        input.expiresAt,
        JSON.stringify(seen),
        input.expiresAt - now + EXPIRED_APPROVAL_MEMORY_MS,
        audience.audience,
        input.toolKind ?? 'backend',
        input.approvalId,
        input.room ?? '',
      );
      if (result !== 'ok') return refusal('decided', `an approval ${input.approvalId} already exists`);
      logger.info(
        audit(input, { expiresAt: input.expiresAt, ...(audience.audience ? { audience: audience.audience } : {}), ...(input.room ? { room: input.room } : {}) }),
        'Approval stored',
      );
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

      const grantId = crypto.randomUUID();
      const [outcome, raw, room, grantUntil] = (await redis.eval(
        DECIDE,
        5,
        stateKey(approvalId),
        recordKey(approvalId),
        declinedKey(approvalId),
        seenKey(approvalId),
        grantKey(approvalId),
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
        // A grant can reach the tab only when the server can push it.
        push && approvesUIByReadback(channel) ? '1' : '0',
        grantId,
        APPROVAL_GRANT_TTL_MS,
      )) as [string, string | undefined, string | undefined, string | undefined];

      if (outcome !== 'approved' && outcome !== 'declined') {
        logger.warn({ approvalId, userId, decision, channel, reason: outcome }, 'Approval decision refused');
        return refusal(outcome as ApprovalRefusalReason, REFUSALS[outcome] ?? outcome);
      }
      const pending = JSON.parse(raw!) as PendingApprovalInput;
      if (outcome === 'declined') {
        logger.info(audit(pending, { channel, ...(room ? { room } : {}) }), 'Approval declined');
        // The card on the person's page says it was declined where they said so.
        if (room && push && channel !== 'ui') {
          push(room, APPROVAL_PUSH_EVENTS.DECLINED, { approvalId, conversationId: pending.conversationId, channel, timestamp: Date.now() });
        }
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
      if (room && grantUntil && push && approvesUIByReadback(channel)) {
        // Written in the script that approved it: the tab on the room claims it, once.
        const grant: ApprovalGrantedEvent = {
          approvalId,
          grantId,
          argsHash: pending.argsHash,
          expiresAt: Number(grantUntil),
          conversationId: pending.conversationId,
          room,
          channel,
          timestamp: Date.now(),
        };
        push(room, APPROVAL_PUSH_EVENTS.GRANTED, grant);
        logger.info(audit(pending, { channel, expiresAt: pending.expiresAt, room, grantId, grantExpiresAt: grant.expiresAt }), 'Approval approved; grant pushed to the room');
      } else {
        logger.info(audit(pending, { channel, expiresAt: pending.expiresAt }), 'Approval approved');
      }
      return { ok: true, decision: 'approve', approvalId, token, argsHash: pending.argsHash, expiresAt: pending.expiresAt, channel };
    },

    async claim(approvalId, grantId, claimer) {
      const [outcome, hash, until, channel, room] = ((await redis.eval(
        CLAIM,
        1,
        grantKey(approvalId),
        grantId,
        claimer.userId,
        Date.now(),
        claimer.socketId,
        JSON.stringify(claimer.rooms),
      )) ?? []) as [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined];
      if (outcome !== 'ok' || !hash || !until || !channel) {
        const reason = (outcome ?? 'unknown') as ApprovalRefusalReason;
        logger.warn({ approvalId, grantId, userId: claimer.userId, socketId: claimer.socketId, reason }, 'Approval grant claim refused');
        return refusal(reason, CLAIM_REFUSALS[reason] ?? reason);
      }
      logger.info({ approvalId, grantId, userId: claimer.userId, socketId: claimer.socketId, room, channel }, 'Approval grant claimed');
      return { ok: true, approvalId, argsHash: hash, expiresAt: Number(until), channel: channel as ApprovalGrantedEvent['channel'] };
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
      const [outcome, raw, channel, audience] = (await redis.eval(
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
      )) as [string, string | undefined, string | undefined, string | undefined];
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
      const receipt = audience ? issueReceipt(p, call.channel, audience) : null;
      logger.info(audit(p, { channel, ...(receipt ? { receipt: { kid: receipt.kid, jti: receipt.jti, audience, exp: receipt.exp } } : {}) }), 'Approval redeemed');
      return { ok: true, call, ...(receipt ? { receipt: receipt.receipt } : {}) };
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
        5,
        stateKey(approvalId),
        recordKey(approvalId),
        seenKey(approvalId),
        withdrawnKey(approvalId),
        grantKey(approvalId),
        userId,
        conversationId,
        reason,
        approvalId,
      )) as ApprovalWithdrawal['outcome'] | null;
      if (outcome === 'withdrawn') logger.info({ approvalId, userId, conversationId, reason }, 'Approval withdrawn before it was used');
      return { approvalId, outcome: outcome === 'withdrawn' || outcome === 'settled' ? outcome : 'unknown' };
    },

    async withdrawOpen(conversationId, reason) {
      const ids = ((await redis.eval(OPEN_IN_CONVERSATION, 1, conversationKey(conversationId))) ?? []) as string[];
      const withdrawn: string[] = [];
      for (const approvalId of ids) {
        const outcome = await redis.eval(
          WITHDRAW,
          6,
          stateKey(approvalId),
          recordKey(approvalId),
          seenKey(approvalId),
          withdrawnKey(approvalId),
          grantKey(approvalId),
          conversationKey(conversationId),
          '',
          conversationId,
          reason,
          approvalId,
        );
        if (outcome === 'withdrawn') withdrawn.push(approvalId);
      }
      if (withdrawn.length > 0) logger.info({ conversationId, reason, approvalIds: withdrawn }, 'Approvals of the conversation withdrawn before they were used');
      return withdrawn;
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
