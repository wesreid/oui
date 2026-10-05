/**
 * The turn after a decision (ADR-0228 §2.2.5). It carries, outside the
 * message text, the token to redeem or that the user declined. The worker
 * asks the store — never the client — what was decided, runs exactly the
 * stored call when there is one, and tells the model what happened in an
 * `<approval>` block on the user's message.
 */
import type { ApprovalContinuation, ApprovalRefusalReason, ApprovalWithdrawReason, ApprovedCall } from '@ouispec/agent-core';
import type { ApprovalStoreClient } from './client.js';

export type ContinuationOutcome =
  /** Approved and redeemed: run this call, exactly. */
  | { kind: 'run'; call: ApprovedCall }
  /**
   * Nothing runs; the model is told why. `settled`: the person's decision, or
   * the approval's expiry, ended the call for good, so the call's stored result
   * says so in place of "waiting for approval".
   */
  | { kind: 'note'; note: string; settled?: Exclude<ApprovalDecided, 'approved'> };

/** How a call that waited for approval ended. */
export type ApprovalDecided = 'approved' | 'declined' | 'expired';

/**
 * What a stored result says of the approval its call waited for, so that no
 * later turn has to guess (dev, 2026-10-03: with "waiting for approval"
 * replaced by the plain result, the assistant on the next turn could no longer
 * tell the person had approved anything, and took back having said so).
 */
export interface ApprovalMarker {
  decided: ApprovalDecided;
  /** Who decided: the person, on the approval card. Absent for an expiry, which nobody decided. */
  by?: 'user';
  /** When the worker learned of it, ISO 8601. */
  at: string;
  /** Whether the call ran: once, when approved and not refused; never otherwise. */
  ran: boolean;
  /** The user approved it, and the approval expired before the call ran. */
  expired?: true;
  /**
   * The approval did not run out of time: it was withdrawn (ADR-0252 §2.6),
   * because the user sent a new message while it waited, or stopped the turn
   * that asked for it.
   */
  withdrawn?: ApprovalWithdrawReason;
  /** The same, in words: what the model reads. */
  summary: string;
}

const SUMMARY = {
  approvedRan: 'Approved by the user on the approval card, and run once.',
  approvedNotRun: 'Approved by the user on the approval card, but it did not run.',
  declined: 'Declined by the user on the approval card. It was not run.',
  expired: 'The approval expired before it was used. It was not run.',
  approvedExpired: 'Approved by the user on the approval card, but the approval expired before it ran. It was not run.',
} as const;

export function approvalMarker(decided: ApprovalDecided, ran: boolean, now: Date = new Date()): ApprovalMarker {
  const summary =
    decided === 'approved' ? (ran ? SUMMARY.approvedRan : SUMMARY.approvedNotRun) : decided === 'declined' ? SUMMARY.declined : SUMMARY.expired;
  return { decided, ...(decided === 'expired' ? {} : { by: 'user' as const }), at: now.toISOString(), ran: decided === 'approved' && ran, summary };
}

/**
 * The user approved it, and it expired before it ran: the turn that would have
 * run it never did. Not "undecided": the person did decide.
 */
export function approvedExpiredMarker(now: Date = new Date()): ApprovalMarker {
  return { decided: 'approved', by: 'user', at: now.toISOString(), ran: false, expired: true, summary: SUMMARY.approvedExpired };
}

const WITHDRAWN_BECAUSE: Record<ApprovalWithdrawReason, string> = {
  superseded: 'the user sent a new message',
  stopped: 'the user stopped the turn that asked for it',
};

/**
 * An approval that was withdrawn before it was used: said as what happened,
 * not as time running out. One the user had approved keeps that they did.
 */
export function withdrawnMarker(reason: ApprovalWithdrawReason, approved: boolean, now: Date = new Date()): ApprovalMarker {
  const because = WITHDRAWN_BECAUSE[reason];
  return approved
    ? {
        decided: 'approved',
        by: 'user',
        at: now.toISOString(),
        ran: false,
        expired: true,
        withdrawn: reason,
        summary: `Approved by the user on the approval card, but withdrawn before it ran because ${because}. It was not run.`,
      }
    : {
        decided: 'expired',
        at: now.toISOString(),
        ran: false,
        withdrawn: reason,
        summary: `The approval was withdrawn before the user decided it, because ${because}. It was not run.`,
      };
}

/** A call's result with its approval said first: an object gains `approval`; anything else is put beside it as `result`. */
export function markedResult(text: string, marker: ApprovalMarker): string {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: kept as the text it is.
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? JSON.stringify({ approval: marker, ...(value as Record<string, unknown>) })
    : JSON.stringify({ approval: marker, result: value });
}

/** The stored result of a call that will never run: declined, expired, or approved where it could not run. */
export function notRunResult(marker: ApprovalMarker, why?: string): string {
  // An approval that lapsed after the user gave it is not a refusal: they may still want it, so the model asks.
  const advice = marker.expired ? 'Ask the user before running it again.' : 'Do not run it again unless the user asks for it again.';
  return JSON.stringify({
    approval: marker,
    success: false,
    notRun: true,
    message: `${marker.summary}${why ? ` ${why}` : ''} ${advice}`,
  });
}

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

/**
 * Where the model finds the approved call's outcome (the duplicate-call
 * confusion, dev 2026-10-03: shown a second call beside the one it had made,
 * the assistant warned of a duplicate save):
 * - `replaced`: the outcome is now the result of the call the model itself
 *   made, in place of "waiting for approval". One call, one result.
 * - `follows`: that call is no longer in the history the model is given, so
 *   the outcome follows the user's message as a call of its own, and the note
 *   says it is the same call.
 */
export type ApprovedResultPlace = 'replaced' | 'follows';

const WHERE: Record<ApprovedResultPlace, string> = {
  replaced:
    'Its result is now the result of that call, above, in place of "waiting for approval": it is one call, run once. ' +
    'Report what the result says, including a failure, and do not call it again.',
  follows:
    'Its result follows, as the call you asked for earlier: it is that same call, now approved and run once, not a second call. ' +
    'Report what the result says, including a failure, and do not call it again.',
};

export function ranNote(title: string, place: ApprovedResultPlace): string {
  return approvalNote(`The user approved "${title}" on the approval card, and it was run once, with the arguments they approved. ${WHERE[place]}`);
}

/** Approved, and refused when it ran: said in the note, and in the call's result too. */
export function refusedNote(title: string, refusal: string): string {
  return approvalNote(`The user approved "${title}" on the approval card, but it did not run: ${refusal}`);
}

export function unavailableNote(title: string): string {
  return approvalNote(`The user approved "${title}" on the approval card, but it did not run: it is not available where they are now.`);
}

/** A call the conversation still holds as waiting for the user's approval. */
export interface WaitingCall {
  approvalId: string;
  /** The tool name its result is stored under. */
  name?: string;
}

/**
 * The calls a history still shows as waiting: those whose LAST stored result
 * is the "waiting for approval" placeholder the worker wrote when the turn
 * stopped. A call decided since has a later result, and is not one. Newest
 * first.
 */
export function waitingCalls(
  history: ReadonlyArray<{ role: string; content?: string | null; tool_call_id?: string; name?: string }>,
): WaitingCall[] {
  const last = new Map<string, { content: string; name?: string }>();
  for (const m of history) {
    if (m.role !== 'tool' || !m.tool_call_id || typeof m.content !== 'string') continue;
    // Re-inserted so the map's order is the order of each call's latest result.
    last.delete(m.tool_call_id);
    last.set(m.tool_call_id, { content: m.content, name: m.name });
  }
  const waiting: WaitingCall[] = [];
  for (const [callId, { content, name }] of last) {
    if (!content.includes('"awaitingApproval"')) continue;
    try {
      const parsed = JSON.parse(content) as { awaitingApproval?: unknown; approvalId?: unknown };
      if (parsed.awaitingApproval === true && parsed.approvalId === callId) waiting.push({ approvalId: callId, name });
    } catch {
      // Not the placeholder.
    }
  }
  return waiting.reverse();
}

/**
 * What the model is told of calls whose approval expired without the call
 * having run: `undecided` nobody decided, `approved` the user had approved and
 * the call was never run.
 */
export function expiredNote(expired: { undecided: number; approved: number; withdrawn?: number }): string {
  const parts: string[] = [];
  const withdrawn = expired.withdrawn ?? 0;
  if (withdrawn === 1) {
    parts.push('An approval asked for earlier in this conversation was withdrawn before it ran, because the user sent a new message or stopped that turn; that action did not run. Run it again only if the user asks for it again.');
  } else if (withdrawn > 1) {
    parts.push(`${withdrawn} approvals asked for earlier in this conversation were withdrawn before they ran, because the user sent a new message or stopped that turn; those actions did not run. Run one again only if the user asks for it again.`);
  }
  if (expired.undecided === 1) {
    parts.push('An approval asked for earlier in this conversation expired before the user decided it, so that action did not run. Run it again only if the user asks for it again.');
  } else if (expired.undecided > 1) {
    parts.push(`${expired.undecided} approvals asked for earlier in this conversation expired before the user decided them, so those actions did not run. Run one again only if the user asks for it again.`);
  }
  if (expired.approved === 1) {
    parts.push('The user approved an action earlier in this conversation, but the approval expired before it ran; it did not run, so ask before running it again.');
  } else if (expired.approved > 1) {
    parts.push(`The user approved ${expired.approved} actions earlier in this conversation, but the approvals expired before they ran; they did not run, so ask before running one again.`);
  }
  return approvalNote(`${parts.join(' ')} The result of each call, above, says so.`);
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
      settled: 'declined',
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
    return {
      kind: 'note',
      note: approvalNote(`An approval arrived, but the approved action did not run: ${WHY_NOT[redeemed.reason]}.`),
      // Only an expiry ends the call: an approval already used ran it, and the other refusals say nothing of the call itself.
      ...(redeemed.reason === 'expired' ? { settled: 'expired' as const } : {}),
    };
  }
  return { kind: 'run', call: redeemed.call };
}
