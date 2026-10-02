/**
 * The worker's side of the approval store (ADR-0228 §2.4), which lives in the
 * realtime server beside the UI action result store. The worker stores a
 * pending approval when it stops a turn, redeems the token the next turn
 * carries, and reads a decline.
 */
import type {
  ApprovalRedeemResult,
  ApprovalRefusalReason,
  ApprovalStatus,
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

    async status(approvalId, userId) {
      const { status, json } = await call(`/internal/approvals/${encodeURIComponent(approvalId)}?${new URLSearchParams({ userId })}`);
      if (status === 200) return json as unknown as ApprovalStatus;
      if (status === 404) return null;
      throw new Error(`[agent-sdk] The approval store could not report approval ${approvalId}: HTTP ${status}`);
    },
  };
}
