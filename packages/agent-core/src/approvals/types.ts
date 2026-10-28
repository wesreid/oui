import type { OUIActionApproval, OUIApprovalGrant } from 'oui-spec/spec';
import { AGENT_APPROVAL_EVENTS } from '@ouispec/agent-events';
import type { ActionRequestApproval, ApprovalChannel, ApprovalGrant, ReadbackUIApprovalChannel } from '@ouispec/contract';

/**
 * Approvals: the shapes the worker, the approval store in the
 * realtime server, the browser's approval card and a conversation engine
 * exchange. An irreversible action runs only on an approval the user gave,
 * bound to the exact call by a single-use token.
 */

/** The client event a user's socket sends when they click the approval card. */
export const APPROVAL_DECIDE_EVENT = 'approval:decide';

/**
 * What the approval store pushes to the room of the turn that asked, when the
 * person decides an action on their page in a conversation channel: the grant
 * (`ApprovalGrantedEvent`) or the decline (`ApprovalDeclinedEvent`). Only the
 * store sends them; the realtime server's emit API refuses them.
 */
export const APPROVAL_PUSH_EVENTS = AGENT_APPROVAL_EVENTS;

/**
 * The client event a tab's socket sends to take a grant the approval store
 * pushed it (`agent:approval_granted`): only the first claim gets the grant.
 */
export const APPROVAL_CLAIM_EVENT = 'approval:claim';

/**
 * The conversation channels on which an action on the person's page is
 * approved by its verbatim readback and an affirmative next turn, as well as
 * by its card: a call in the product's page, a call through a
 * carrier, and a chat that sends the readback as text. Never SMS, which has
 * no page beside it, and never `ui`, where a typed yes is a message.
 */
export const READBACK_UI_APPROVAL_CHANNELS: ReadonlySet<ApprovalChannel> = new Set<ReadbackUIApprovalChannel>(['voice', 'phone', 'chat']);

/** Whether a decision on `channel` may approve an action on the person's page by its readback. */
export function approvesUIByReadback(channel: ApprovalChannel): channel is ReadbackUIApprovalChannel {
  return READBACK_UI_APPROVAL_CHANNELS.has(channel);
}

/**
 * How long a grant pushed to the tab for an approval given by voice or in
 * chat lasts, at most: long enough for the turn that redeems the token to
 * dispatch the action, short enough that an unclaimed grant does not linger.
 * It never outlasts the approval itself.
 */
export const APPROVAL_GRANT_TTL_MS = 2 * 60_000;

/**
 * The longest each part of an approval's preview may be, in characters: what
 * the approval store accepts, and what the worker holds a host's own preview
 * (`approvals.preview`) to before it stores or shows it.
 */
export const APPROVAL_PREVIEW_LIMITS = {
  title: 500,
  consequence: 2000,
  arguments: 50,
  argumentName: 200,
  argumentLabel: 500,
  argumentValue: 4000,
  readback: 8000,
} as const;

/** How long an approval lasts unless its action declares otherwise. */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
/** The longest an action may declare an approval lasts. */
export const MAX_APPROVAL_TTL_MS = 30 * 60_000;

export const APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['ui', 'voice', 'phone', 'sms', 'chat'];

/**
 * How long the store remembers that an approval was asked for and never
 * decided, after it has expired: long enough for a conversation picked up
 * days later to be told its call expired, rather than that it still waits.
 */
export const EXPIRED_APPROVAL_MEMORY_MS = 30 * 24 * 60 * 60_000;

/**
 * How long a turn that claimed an expiry has to store it and confirm. A turn
 * that dies in between confirms nothing, and cannot release anything either:
 * its claim lapses on the store's clock and the next turn claims again, so the
 * stored conversation does not say "waiting" for good.
 */
export const EXPIRY_CLAIM_LEASE_MS = 2 * 60_000;

/**
 * Where an approval stands when a later turn finds its call still stored as
 * waiting, and asks to settle it (`POST /internal/approvals/:id/settle`):
 *
 * - `claimed`: it expired without having run — undecided, or approved and
 *   never used (`decided`) — and this caller holds the claim to store
 *   that, for `EXPIRY_CLAIM_LEASE_MS`. The caller stores the call's result as
 *   expired, then confirms; confirmed, the claim is permanent.
 * - `already`: it expired without having run, and another turn holds the claim
 *   or has confirmed it. The caller tells the model so for its own turn, and stores
 *   nothing.
 * - `open`: it is still pending, or approved and not yet used. The card is live.
 * - `unknown`: the store cannot say it expired undecided — it was declined, or
 *   approved and used, it is another user's or another conversation's, it was
 *   asked for before the store kept this memory, or the memory has lapsed.
 *   Nothing is changed.
 * - `confirmed`: the answer to a confirmation.
 *
 * Only the store's own clock decides that an approval has expired.
 */
export type ApprovalSettleOutcome = 'claimed' | 'already' | 'open' | 'unknown' | 'confirmed';

export interface ApprovalSettlement {
  approvalId: string;
  outcome: ApprovalSettleOutcome;
  /** When it expired (epoch ms), for `claimed` and `already`. */
  expiresAt?: number;
  /**
   * For `claimed` and `already`: the user had approved it, and it expired
   * before it was used (the turn that would have run it never did). Absent
   * when nobody decided it.
   */
  decided?: 'approved';
  /**
   * For `claimed` and `already`: set when the approval did not run out of
   * time but was withdrawn. Absent when its time ran out.
   */
  withdrawn?: ApprovalWithdrawReason;
}

/**
 * Why an approval was expired before its time:
 * - `superseded`: the person sent a new message while the card waited.
 * - `stopped`: the turn that asked for it was stopped as it asked.
 * - `taken_over`: a person on the staff took the conversation over while it
 *   waited: the person now answering did not ask for it.
 *
 * A withdrawn approval is expired from that moment: its card is dead and its
 * token answers `used`. What is stored and told to the model says why, so it
 * reads "withdrawn because you sent a new message", not "it timed out".
 */
export type ApprovalWithdrawReason = 'superseded' | 'stopped' | 'taken_over';

export const APPROVAL_WITHDRAW_REASONS: readonly ApprovalWithdrawReason[] = ['superseded', 'stopped', 'taken_over'];

/** The answer to withdrawing an approval (`POST /internal/approvals/:id/settle` with `expire`). */
export interface ApprovalWithdrawal {
  approvalId: string;
  /**
   * - `withdrawn`: it was pending, or approved and not yet used, and is now expired.
   * - `settled`: it had already ended (declined, used, expired or withdrawn); nothing changed.
   * - `unknown`: the store holds no such approval for this owner.
   */
  outcome: 'withdrawn' | 'settled' | 'unknown';
}

/** Whose approval is asked about: the same ownership the other approval routes check. */
export interface ApprovalOwner {
  userId: string;
  conversationId: string;
}

// The messages are the contract's (`approvals.json`), generated from its schema,
// so the worker, the store, the card and a gateway in another language read one
// definition.
export type {
  ActionRequestApproval,
  ApprovalChannel,
  ApprovalClaimPayload,
  ApprovalClaimResult,
  ApprovalContinuation,
  ApprovalDecidePayload,
  ApprovalDecideResult,
  ApprovalDecision,
  ApprovalEffect,
  ApprovalDeclinedEvent,
  ApprovalGrant,
  ApprovalGrantedEvent,
  ApprovalPreview,
  ApprovalPreviewArgument,
  ApprovalRedeemResult,
  ApprovalRefusal,
  ApprovalRefusalReason,
  ApprovalRequiredEvent,
  ApprovalStatus,
  ApprovalReceiptClaims,
  ApprovalTokenClaims,
  ApprovedCall,
  PendingApprovalInput,
  ReadbackUIApprovalChannel,
} from '@ouispec/contract';

// What a UI action request carries, and what a tab's runtime holds, are OUI's
// own types too: the contract's must be exactly them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const requestIsOUIs: Same<ActionRequestApproval, OUIActionApproval> = true;
const grantIsOUIs: Same<ApprovalGrant, OUIApprovalGrant> = true;
void requestIsOUIs;
void grantIsOUIs;
