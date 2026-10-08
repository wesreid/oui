/**
 * The realtime server, as one eval run needs it, in memory (ADR-0260 §3.4):
 * turn events kept for the assertions, approvals stored, decided and redeemed
 * as the realtime server's store does, and stops and conversation holds as its
 * stop record answers them. Nothing leaves the process.
 */
import { randomUUID } from 'node:crypto';
import type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalOwner,
  ApprovalRedeemResult,
  ApprovalSettlement,
  ApprovalStatus,
  ApprovalWithdrawal,
  ConversationHold,
  PendingApprovalInput,
  StaffSpeaker,
  TurnStopRecord,
} from '@ouispec/agent-core';
import type { ApprovalStoreClient, RealtimeEmitAdapter, TurnStopClient, UIActionChannel } from '@ouispec/agent-worker';

/** One event the worker sent a turn's room. */
export interface EmittedEvent {
  room: string;
  event: string;
  data: Record<string, unknown>;
}

export function createMemoryEmit(): RealtimeEmitAdapter & { events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    async emit(room, event, data) {
      events.push({ room, event, data: (data ?? {}) as Record<string, unknown> });
    },
  };
}

interface StoredApproval {
  pending: PendingApprovalInput;
  status: 'pending' | 'approved' | 'declined' | 'used' | 'withdrawn';
  token?: string;
  channel?: ApprovalChannel;
}

export interface MemoryApprovalStore extends ApprovalStoreClient {
  /** The approvals asked for, in order. */
  readonly asked: readonly PendingApprovalInput[];
  /** The customer's answer, on their channel: a token to redeem, or that they declined. */
  decide(
    approvalId: string,
    by: { userId: string; decision: ApprovalDecision; channel: ApprovalChannel },
  ): { ok: true; token?: string } | { ok: false; reason: string };
}

/** The approval store, in memory: single use, bound to the user, the conversation and the stored call. */
export function createMemoryApprovalStore(): MemoryApprovalStore {
  const approvals = new Map<string, StoredApproval>();
  const asked: PendingApprovalInput[] = [];
  return {
    asked,
    async create(pending) {
      approvals.set(pending.approvalId, { pending, status: 'pending' });
      asked.push(pending);
    },
    decide(approvalId, by) {
      const stored = approvals.get(approvalId);
      if (!stored) return { ok: false, reason: 'unknown' };
      if (stored.pending.userId !== by.userId) return { ok: false, reason: 'forbidden' };
      if (stored.status !== 'pending') return { ok: false, reason: 'decided' };
      if (by.decision === 'decline') {
        stored.status = 'declined';
        return { ok: true };
      }
      stored.status = 'approved';
      stored.channel = by.channel;
      stored.token = `eval-${randomUUID()}`;
      return { ok: true, token: stored.token };
    },
    async redeem(token, caller): Promise<ApprovalRedeemResult> {
      const stored = [...approvals.values()].find((a) => a.token === token);
      if (!stored) return { ok: false, reason: 'invalid', error: 'not a token this store issued' };
      if (stored.status === 'used') return { ok: false, reason: 'used', error: 'already redeemed' };
      if (stored.status !== 'approved') return { ok: false, reason: 'expired', error: `the approval is ${stored.status}` };
      const { pending } = stored;
      if (pending.userId !== caller.userId || pending.conversationId !== caller.conversationId) {
        return { ok: false, reason: 'forbidden', error: 'another user’s or another conversation’s approval' };
      }
      stored.status = 'used';
      return {
        ok: true,
        call: {
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          conversationId: pending.conversationId,
          turnId: pending.turnId,
          userId: pending.userId,
          tool: pending.tool,
          args: pending.args,
          argsHash: pending.argsHash,
          effect: pending.effect,
          destructive: pending.destructive,
          channel: stored.channel ?? 'ui',
        },
      };
    },
    async status(approvalId, userId): Promise<ApprovalStatus | null> {
      const stored = approvals.get(approvalId);
      if (!stored || stored.pending.userId !== userId) return null;
      const status = stored.status === 'declined' ? 'declined' : stored.status === 'pending' ? 'pending' : 'approved';
      return { approvalId, status, tool: stored.pending.tool, title: stored.pending.preview.title };
    },
    async settleExpired(approvalId): Promise<ApprovalSettlement> {
      // Nothing expires within one eval run.
      return { approvalId, outcome: approvals.get(approvalId)?.status === 'pending' ? 'open' : 'unknown' };
    },
    async confirmExpirySettled() {},
    async withdraw(approvalId, owner: ApprovalOwner): Promise<ApprovalWithdrawal> {
      const stored = approvals.get(approvalId);
      if (!stored || stored.pending.userId !== owner.userId) return { approvalId, outcome: 'unknown' };
      if (stored.status !== 'pending' && stored.status !== 'approved') return { approvalId, outcome: 'settled' };
      stored.status = 'withdrawn';
      return { approvalId, outcome: 'withdrawn' };
    },
  };
}

export interface MemoryStops extends TurnStopClient {
  /** A person on the staff holds the conversation from now (ADR-0260 §2.3). */
  hold(conversationId: string, holder: StaffSpeaker): ConversationHold;
  /** The hold ends. */
  release(conversationId: string): ConversationHold | null;
  holdOf(conversationId: string): ConversationHold | null;
}

/**
 * Stops as the realtime server's stop record answers them: a conversation a
 * person holds stops every turn of it, `taken_over`, on the turn's first
 * question. Nobody presses Stop in an eval.
 */
export function createMemoryStops(): MemoryStops {
  const holds = new Map<string, ConversationHold>();
  return {
    hold(conversationId, holder) {
      const hold = { conversationId, holder, since: Date.now() };
      holds.set(conversationId, hold);
      return hold;
    },
    release(conversationId) {
      const hold = holds.get(conversationId) ?? null;
      holds.delete(conversationId);
      return hold;
    },
    holdOf: (conversationId) => holds.get(conversationId) ?? null,
    async watch(turnId, _userId, signal, onChecked, conversationId): Promise<TurnStopRecord | null> {
      onChecked?.();
      const hold = conversationId ? holds.get(conversationId) : undefined;
      if (hold) return { turnId, by: hold.holder.userId, reason: 'taken_over', at: hold.since };
      if (signal.aborted) return null;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    },
  };
}

/** A conversation channel has no page: a UI action reaching it is refused, as a tab with nothing open refuses it. */
export const NO_PAGE: UIActionChannel = {
  async dispatch() {
    return { acknowledged: 0, accepted: 0 };
  },
  async awaitResult() {
    return null;
  },
};
