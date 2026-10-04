import type { OUIActionApproval, OUIApprovalGrant } from 'oui-spec/spec';
import type { ActionRequestApproval, ApprovalChannel, ApprovalGrant } from '@ouispec/contract';

/**
 * Approvals (ADR-0228): the shapes the worker, the approval store in the
 * realtime server, the browser's approval card and a conversation engine
 * exchange. An irreversible action runs only on an approval the user gave,
 * bound to the exact call by a single-use token.
 */

/** The client event a user's socket sends when they click the approval card. */
export const APPROVAL_DECIDE_EVENT = 'approval:decide';

/** How long an approval lasts unless its action declares otherwise (ADR-0228 §2.3). */
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
 * - `claimed`: it expired undecided, and this caller holds the claim to store
 *   that, for `EXPIRY_CLAIM_LEASE_MS`. The caller stores the call's result as
 *   expired, then confirms; confirmed, the claim is permanent.
 * - `already`: it expired undecided, and another turn holds the claim or has
 *   confirmed it. The caller tells the model so for its own turn, and stores
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
  ApprovalContinuation,
  ApprovalDecidePayload,
  ApprovalDecideResult,
  ApprovalDecision,
  ApprovalEffect,
  ApprovalGrant,
  ApprovalPreview,
  ApprovalPreviewArgument,
  ApprovalRedeemResult,
  ApprovalRefusal,
  ApprovalRefusalReason,
  ApprovalRequiredEvent,
  ApprovalStatus,
  ApprovalTokenClaims,
  ApprovedCall,
  PendingApprovalInput,
} from '@ouispec/contract';

// What a UI action request carries, and what a tab's runtime holds, are OUI's
// own types too: the contract's must be exactly them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const requestIsOUIs: Same<ActionRequestApproval, OUIActionApproval> = true;
const grantIsOUIs: Same<ApprovalGrant, OUIApprovalGrant> = true;
void requestIsOUIs;
void grantIsOUIs;
