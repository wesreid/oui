/**
 * The worker's side of the approval store (ADR-0228 §2.4), which lives in the
 * realtime server beside the UI action result store. The worker stores a
 * pending approval when it stops a turn, redeems the token the next turn
 * carries, and reads a decline.
 */
import type {
  ApprovalOwner,
  ApprovalRedeemResult,
  ApprovalRefusalReason,
  ApprovalSettlement,
  ApprovalStatus,
  ApprovalWithdrawal,
  ApprovalWithdrawReason,
  ApprovedCall,
  PendingApprovalInput,
} from '@ouispec/agent-core';
import { requireRealtime } from '../emit/http-adapter.js';

export interface ApprovalStoreClient {
  /** Store a pending approval. Rejects when it was not stored: the call must then not wait on it. */
  create(pending: PendingApprovalInput): Promise<void>;
  /** The stored call for a valid, unexpired, unused token of this user and conversation; otherwise why not. Rejects when the store cannot be reached. */
  redeem(token: string, caller: { userId: string; conversationId: string }): Promise<ApprovalRedeemResult>;
  /** Where an approval of this user's stands, or null when there is none. */
  status(approvalId: string, userId: string): Promise<ApprovalStatus | null>;
  /**
   * Whether an approval the conversation still shows as waiting expired
   * undecided, claimed for the first turn that asks (see `ApprovalSettlement`).
   * Optional: a store without it settles nothing, and its calls keep reading
   * "waiting". Rejects when the store cannot be reached.
   */
  settleExpired?(approvalId: string, owner: ApprovalOwner): Promise<ApprovalSettlement>;
  /**
   * The claimed expiry has been stored in the conversation, so the claim no
   * longer lapses. Called after the host has persisted the turn's messages.
   */
  confirmExpirySettled?(approvalId: string, owner: ApprovalOwner): Promise<void>;
  /**
   * Expire an approval now, saying why (ADR-0252 §2.6): the turn that asked
   * for it was stopped, so its card must not stay live. Optional: a store
   * without it leaves the approval to its time limit. Rejects when the store
   * cannot be reached.
   */
  withdraw?(approvalId: string, owner: ApprovalOwner, reason: ApprovalWithdrawReason): Promise<ApprovalWithdrawal>;
}

export interface HttpApprovalStoreClientConfig {
  /** The realtime server's base URL. */
  url: string;
  /** Its internal key. */
  apiKey: string;
  /** Per request. Default 5 s. */
  timeoutMs?: number;
}

/** The store over the realtime server's internal HTTP API. */
export function createHttpApprovalStoreClient(config: HttpApprovalStoreClientConfig): ApprovalStoreClient {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const timeoutMs = config.timeoutMs ?? 5_000;

  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A non-JSON answer is reported by status below.
    }
    return { status: res.status, json };
  };

  return {
    async create(pending) {
      const { status, json } = await call('/internal/approvals', pending);
      if (status !== 201) {
        throw new Error(`[agent-sdk] The approval store did not keep approval ${pending.approvalId}: HTTP ${status} ${String(json.error ?? '')}`);
      }
    },

    async redeem(token, caller) {
      const { status, json } = await call('/internal/approvals/redeem', { token, ...caller });
      if (status === 200) return { ok: true, call: json.call as ApprovedCall };
      if (status >= 400 && status < 500 && typeof json.reason === 'string') {
        return { ok: false, reason: json.reason as ApprovalRefusalReason, error: String(json.error ?? json.reason) };
      }
      throw new Error(`[agent-sdk] The approval store could not redeem a token: HTTP ${status}`);
    },

    async settleExpired(approvalId, owner) {
      const { status, json } = await call(`/internal/approvals/${encodeURIComponent(approvalId)}/settle`, owner);
      if (status === 200 && typeof json.outcome === 'string') return json as unknown as ApprovalSettlement;
      // A realtime server from before this route: it cannot say, so nothing is settled.
      if (status === 404) return { approvalId, outcome: 'unknown' };
      throw new Error(`[agent-sdk] The approval store could not settle approval ${approvalId}: HTTP ${status}`);
    },

    async confirmExpirySettled(approvalId, owner) {
      const { status } = await call(`/internal/approvals/${encodeURIComponent(approvalId)}/settle`, { ...owner, confirm: true });
      if (status !== 200 && status !== 404) {
        throw new Error(`[agent-sdk] The approval store could not confirm approval ${approvalId} as settled: HTTP ${status}`);
      }
    },

    async withdraw(approvalId, owner, reason) {
      const { status, json } = await call(`/internal/approvals/${encodeURIComponent(approvalId)}/settle`, { ...owner, expire: reason });
      // A realtime server from before this: it answers as a plain settle would, which is not a withdrawal.
      if (status === 200 && (json.outcome === 'withdrawn' || json.outcome === 'settled' || json.outcome === 'unknown')) {
        return json as unknown as ApprovalWithdrawal;
      }
      if (status === 200 || status === 404) return { approvalId, outcome: 'unknown' };
      throw new Error(`[agent-sdk] The approval store could not withdraw approval ${approvalId}: HTTP ${status}`);
    },

    async status(approvalId, userId) {
      const { status, json } = await call(`/internal/approvals/${encodeURIComponent(approvalId)}?${new URLSearchParams({ userId })}`);
      if (status === 200) return json as unknown as ApprovalStatus;
      if (status === 404) return null;
      throw new Error(`[agent-sdk] The approval store could not report approval ${approvalId}: HTTP ${status}`);
    },
  };
}
