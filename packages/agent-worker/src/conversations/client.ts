/**
 * The product API's side of a conversation's hold (ADR-0260 §2.2): take a
 * conversation over, hand it back, announce a stored message, ask who holds
 * it. The realtime server keeps the hold and enforces it; the product calls
 * these from its own routes, after its own check that this person may.
 *
 * It ships beside the clients of the approval store and the stop record,
 * which the worker uses; a product's API imports it from here.
 */
import type {
  AnnounceMessageRequest,
  AnnounceMessageResult,
  ConversationHold,
  HandBackRequest,
  HandBackResult,
  TakeOverRequest,
  TakeOverResult,
} from '@ouispec/agent-core';
import { requireRealtime } from '../emit/http-adapter.js';

export interface ConversationClient {
  /** Who holds the conversation, or null when the agent answers it. */
  hold(conversationId: string): Promise<ConversationHold | null>;
  /**
   * Take it over for `request.holder`: `taken_over` (the rooms are told, and
   * its running turn stops), `already` (this holder had it), or refused with
   * who holds it. Call it after the product's own permission check.
   */
  takeOver(conversationId: string, request: TakeOverRequest): Promise<TakeOverResult>;
  /**
   * Hand it back: with `userId`, as that holder; without it, on the product's
   * own authority (an idle policy, a manager). Refused when `userId` does not
   * hold it.
   */
  handBack(conversationId: string, request: HandBackRequest): Promise<HandBackResult>;
  /**
   * Announce a message the product has stored, to the people watching the
   * conversation. A `staff` message is refused unless its speaker holds it.
   */
  announce(conversationId: string, request: AnnounceMessageRequest): Promise<AnnounceMessageResult>;
}

export interface HttpConversationClientConfig {
  /** The realtime server's base URL. */
  url: string;
  /** Its internal key. */
  apiKey: string;
  /** Per request. Default 5 s. */
  timeoutMs?: number;
}

/** The conversation routes over the realtime server's internal HTTP API. Throws on anything but an answer. */
export function createHttpConversationClient(config: HttpConversationClientConfig): ConversationClient {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const timeoutMs = config.timeoutMs ?? 5_000;

  const call = async (conversationId: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${url}/internal/conversations/${encodeURIComponent(conversationId)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON answer is reported by status below.
    }
    return { status: res.status, json };
  };

  /** A 200 or a 409 is the server's answer; anything else is a failure to ask. */
  const answer = <T>(what: string, conversationId: string, { status, json }: { status: number; json: unknown }): T => {
    if (status === 200 || status === 409) return json as T;
    const error = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : '';
    throw new Error(`[agent-sdk] The realtime server could not ${what} conversation ${conversationId}: HTTP ${status} ${error}`.trim());
  };

  return {
    async hold(conversationId) {
      const res = await call(conversationId, '/hold');
      if (res.status === 204) return null;
      return answer<ConversationHold>('read the hold of', conversationId, res);
    },
    async takeOver(conversationId, request) {
      return answer<TakeOverResult>('take over', conversationId, await call(conversationId, '/hold', request));
    },
    async handBack(conversationId, request) {
      return answer<HandBackResult>('hand back', conversationId, await call(conversationId, '/hold/release', request));
    },
    async announce(conversationId, request) {
      return answer<AnnounceMessageResult>('announce a message of', conversationId, await call(conversationId, '/messages', request));
    },
  };
}
