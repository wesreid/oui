/**
 * The turn after a decision (ADR-0228 §2.2.5). It carries, outside the
 * message text, the token to redeem or that the user declined. The worker
 * asks the store — never the client — what was decided, runs exactly the
 * stored call when there is one, and tells the model what happened in an
 * `<approval>` block on the user's message.
 */
import type { ApprovalContinuation, ApprovalRefusalReason, ApprovedCall } from '@ouispec/agent-core';
import type { ApprovalStoreClient } from './client.js';

export type ContinuationOutcome =
  /** Approved and redeemed: run this call, exactly. */
  | { kind: 'run'; call: ApprovedCall }
  /** Nothing runs; the model is told why. */
  | { kind: 'note'; note: string };

const WHY_NOT: Record<ApprovalRefusalReason, string> = {
  used: 'this approval has already been used',
  expired: 'the approval expired before it was used',
  invalid: 'the approval is not valid',
  forbidden: 'the approval belongs to another user or conversation',
  mismatch: 'the approval is not for that call',
  unknown: 'no such approval is waiting',
  decided: 'the approval could not be used',
  channel: 'the approval could not be used',
};

export const approvalNote = (text: string) => `<approval>${text}</approval>`;

export function ranNote(title: string): string {
  return approvalNote(`The user approved "${title}" on the approval card, and it was run once, with the arguments they approved. Its result follows: report what it says, including a failure.`);
}

export function unavailableNote(title: string): string {
  return approvalNote(`The user approved "${title}" on the approval card, but it did not run: it is not available where they are now.`);
}

export async function resolveContinuation(
  store: ApprovalStoreClient | undefined,
  continuation: ApprovalContinuation,
  turn: { userId: string; conversationId: string },
): Promise<ContinuationOutcome> {
  if (!store) return { kind: 'note', note: approvalNote('An approval arrived, but the approved action did not run: this worker has no approval store.') };

  if (continuation.decision === 'decline') {
    const status = await store.status(continuation.approvalId, turn.userId).catch(() => null);
    const what = status?.title ? `"${status.title}"` : 'the action';
    return {
      kind: 'note',
      note:
        status?.status === 'declined'
          ? approvalNote(`The user declined ${what} on the approval card, so it did not run. Do not run it again unless they ask for it again.`)
          : approvalNote(`The user did not approve ${what}, so it did not run.`),
    };
  }

  let redeemed;
  try {
    redeemed = await store.redeem(continuation.token, turn);
  } catch {
    return { kind: 'note', note: approvalNote('An approval arrived, but the approved action did not run: the approval could not be checked.') };
  }
  if (!redeemed.ok) {
    return { kind: 'note', note: approvalNote(`An approval arrived, but the approved action did not run: ${WHY_NOT[redeemed.reason]}.`) };
  }
  return { kind: 'run', call: redeemed.call };
}
