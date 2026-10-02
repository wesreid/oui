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
