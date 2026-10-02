/**
 * The approval card's own channel to the provider: the pending approval and
 * the user's decision on it. Deliberately not part of `useAgent()` and not
 * exported from the package, so the only thing in a page that can approve is
 * `ApprovalCard`, which no build may bind for the assistant (ADR-0228 §2.2.3).
 */
import { createContext } from 'react';
import type { ApprovalDecision, ApprovalRefusal } from '@ouispec/agent-core';
import type { AgentApprovalRequest } from '../provider/types.js';

export interface ApprovalDecisionState {
  pending: AgentApprovalRequest | null;
  /** True while the approval store answers the click. */
  deciding: boolean;
  /** Why the last decision was refused, for the user. */
  error: string | null;
  /** The user's click: decides on their own socket, then continues the turn. */
  decide: (decision: ApprovalDecision) => Promise<void>;
  /** Puts the card away after a refusal; nothing is decided. */
  dismiss: () => void;
}

export const ApprovalDecisionContext = createContext<ApprovalDecisionState | null>(null);

/** What the user is told when the store refuses their decision. */
export function approvalRefusalText(refusal: ApprovalRefusal): string {
  switch (refusal.reason) {
    case 'expired':
      return 'This approval has expired. Ask the assistant again if you still want it done.';
    case 'decided':
    case 'used':
      return 'This has already been decided.';
    case 'unknown':
      return 'This approval is no longer waiting. Ask the assistant again if you still want it done.';
    case 'forbidden':
      return 'This approval belongs to someone else.';
    default:
      return `Your decision could not be recorded: ${refusal.error}.`;
  }
}
