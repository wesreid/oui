/**
 * The realtime server, as one eval run needs it, in memory:
 * turn events kept for the assertions, approvals stored, decided and redeemed
 * as the realtime server's store does, and stops and conversation holds as its
 * stop record answers them; and the conversation store a product's own
 * replaces (`EvalHistory`). Nothing leaves the process.
 */
import { randomUUID } from 'node:crypto';
import type {
  ApprovalChannel,
  ApprovalDecideResult,
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
import {
  historyOf,
  type AgentRuntimeConfig,
  type ApprovalStoreClient,
  type HistoryRequest,
  type RealtimeEmitAdapter,
  type TurnHistory,
  type TurnHistoryMessage,
  type TurnMessage,
  type TurnStopClient,
  type UIActionChannel,
} from '@ouispec/agent-worker';

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
  /**
   * The customer's answer, on their channel: the card's click (`ui`) or a
   * conversation channel's confirmation. A token to redeem, or that they
   * declined. `decide` is the same answer, as a host's worker gives it on a
   * conversation channel.
   */
  answer(approvalId: string, by: { userId: string; decision: ApprovalDecision; channel: ApprovalChannel }): ApprovalDecideResult;
  decide(
    approvalId: string,
    by: { userId: string; decision: ApprovalDecision; channel: Exclude<ApprovalChannel, 'ui'> },
  ): Promise<ApprovalDecideResult>;
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
    answer(approvalId, by) {
      const stored = approvals.get(approvalId);
      if (!stored) return { ok: false, reason: 'unknown', error: 'no such approval' };
      if (stored.pending.userId !== by.userId) return { ok: false, reason: 'forbidden', error: 'another user’s approval' };
      if (stored.status !== 'pending') return { ok: false, reason: 'decided', error: `the approval is ${stored.status}` };
      if (by.decision === 'decline') {
        stored.status = 'declined';
        return { ok: true, decision: 'decline', approvalId };
      }
      stored.status = 'approved';
      stored.channel = by.channel;
      stored.token = `eval-${randomUUID()}`;
      return {
        ok: true,
        decision: 'approve',
        approvalId,
        token: stored.token,
        argsHash: stored.pending.argsHash,
        expiresAt: stored.pending.expiresAt,
        channel: by.channel,
      };
    },
    async decide(approvalId, by) {
      return this.answer(approvalId, by);
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
  /** A person on the staff holds the conversation from now. */
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

/**
 * A conversation channel has no page: a UI action reaching it is refused, as a
 * tab with nothing open refuses it. The harness runs it with no wait for an
 * answer, so a turn whose context carries a page snapshot and no fixture is
 * told at once that the page is not responding.
 */
export const NO_PAGE: UIActionChannel = {
  async dispatch() {
    return { acknowledged: 0, accepted: 0 };
  },
  async awaitResult() {
    return null;
  },
};

/**
 * A conversation store, as a product's worker reads and writes it: what the
 * harness hands the turn runner as `getHistory` and `persistMessages`, and
 * where it puts what no turn writes (the customer's message, which a
 * product's API stores before it runs the turn, and a person's on the staff).
 *
 * Give the product's own (its window that cuts old tool results, its summary,
 * its step context) to run later turns on what its worker really reads.
 */
export interface EvalHistory {
  /** A message no turn writes: the customer's, before their turn runs; a person's on the staff, as they act. */
  append(conversationId: string, entry: TurnHistoryMessage): void | Promise<void>;
  /** The worker's `getHistory`: what a turn reads. */
  getHistory(conversationId: string, turn: HistoryRequest): Promise<TurnHistoryMessage[] | TurnHistory>;
  /** The worker's `persistMessages`, with no database: how a turn's messages are stored. */
  persistMessages(input: Omit<Parameters<AgentRuntimeConfig<unknown>['persistMessages']>[0], 'db'>): Promise<void | { stored: false }>;
}

export interface MemoryHistoryOptions {
  /**
   * What a turn reads of the whole conversation: the product's own window
   * (the newest messages, old tool results cut, a summary in their place, a
   * step context beside them). Default: all of it.
   */
  window?: (messages: readonly TurnHistoryMessage[], turn: HistoryRequest & { conversationId: string }) => TurnHistoryMessage[] | TurnHistory | Promise<TurnHistoryMessage[] | TurnHistory>;
}

/** The conversation, kept whole in memory; a turn reads it through `window` when one is given. */
export function createMemoryHistory(options: MemoryHistoryOptions = {}): EvalHistory & { messages(conversationId: string): readonly TurnHistoryMessage[] } {
  const conversations = new Map<string, TurnHistoryMessage[]>();
  const of = (id: string) => {
    let messages = conversations.get(id);
    if (!messages) conversations.set(id, (messages = []));
    return messages;
  };
  return {
    messages: (conversationId) => of(conversationId),
    append(conversationId, entry) {
      of(conversationId).push(entry);
    },
    async getHistory(conversationId, turn) {
      const messages = [...of(conversationId)];
      return options.window ? await options.window(messages, { ...turn, conversationId }) : messages;
    },
    async persistMessages({ conversationId, messages }: { conversationId: string; messages: TurnMessage[] }) {
      of(conversationId).push(...historyOf(messages));
    },
  };
}
