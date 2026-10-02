/**
 * The UI action channel: how the worker sends a UI action to the client that
 * sent the turn, and how it gets the client's answer (ADR-0209 D2).
 *
 * The worker is not on the client's socket. It reaches the client through the
 * realtime service: the request is emitted to the turn's room, the client
 * answers on OUI's result event, and the realtime service holds that answer
 * until the worker collects it.
 */
import type { OUIActionRequest, OUIActionResult } from 'oui-spec/spec';
import { createWebSocketTransport, type SocketLike } from 'oui-spec/transport';
import { requireRealtime } from '../emit/http-adapter.js';
import { longPoll } from '../realtime/long-poll.js';

/**
 * Who received a request: how many of the room's tabs acknowledged it, and how
 * many accepted it (oui-spec §7.3.7). Null from a realtime service that does
 * not report receipts.
 */
export interface UIDispatchReceipt {
  acknowledged: number;
  accepted: number;
}

export interface UIActionChannel {
  /**
   * Deliver a request to the turn's room, and say who received it when the
   * realtime service reports receipts. Rejects when it could not be delivered.
   */
  dispatch(room: string, request: OUIActionRequest): Promise<UIDispatchReceipt | null | void>;

  /**
   * Resolve with the client's first answer to `requestId`, or null if none
   * arrives by the deadline. Only an answer from a client authenticated as
   * `userId` counts. With `final`, the final answer instead: for an async
   * action, the one sent once its work is done or has failed, never its
   * acknowledgment.
   */
  awaitResult(
    requestId: string,
    options: { userId: string; timeoutMs: number; signal?: AbortSignal; final?: boolean },
  ): Promise<OUIActionResult | null>;
}

export interface HttpUIActionChannelConfig {
  /** The realtime service's base URL. */
  url: string;
  /** Its internal API key (the same key the emit adapter uses). */
  apiKey: string;
  /** Longest single wait the realtime service is asked to hold open. Default 20 s. */
  maxPollMs?: number;
  /** Timeout for delivering a request. Default 5 s. */
  dispatchTimeoutMs?: number;
  /**
   * How long the realtime service waits for the tabs' receipts of a request
   * before answering the delivery (oui-spec §7.3.7). Default 1.5 s; 0 asks for
   * none.
   */
  receiptTimeoutMs?: number;
}

/**
 * The OUI wire name for a dispatch, taken from OUI's own transport rather than
 * written here: OUI owns its event names, and a copy of one here is how the
 * two ends drift apart.
 */
function ouiDispatchEvent(request: OUIActionRequest): { event: string; data: unknown } {
  let captured: { event: string; data: unknown } | null = null;
  const capture: SocketLike = {
    connected: true,
    emit(event, data) {
      captured = { event, data };
    },
    on() {},
    off() {},
    once() {},
  };
  const transport = createWebSocketTransport(capture);
  transport.dispatch(request);
  transport.dispose();
  if (!captured) throw new Error('[agent-sdk] OUI transport emitted nothing for a dispatch');
  return captured;
}

/**
 * The channel over the realtime service's HTTP API:
 * - `POST {url}/api/emit` delivers the request to the turn's room;
 * - `GET {url}/internal/oui/action-results/{requestId}?userId=&waitMs=` waits
 *   for the answer (200 with the result, 204 when none arrived in `waitMs`);
 *   with `&final=1`, for the final answer of an async action.
 */
export function createHttpUIActionChannel(config: HttpUIActionChannelConfig): UIActionChannel {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const maxPollMs = config.maxPollMs ?? 20_000;
  const dispatchTimeoutMs = config.dispatchTimeoutMs ?? 5_000;
  const receiptTimeoutMs = config.receiptTimeoutMs ?? 1_500;

  return {
    async dispatch(room, request) {
      const { event, data } = ouiDispatchEvent(request);
      const res = await fetch(`${url}/api/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          event,
          data,
          rooms: [room],
          ...(receiptTimeoutMs > 0 ? { ackTimeoutMs: receiptTimeoutMs } : {}),
        }),
        signal: AbortSignal.timeout(dispatchTimeoutMs + receiptTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`[agent-sdk] Delivering UI action ${request.actionId} failed: HTTP ${res.status}`);
      }
      return receiptsOf(await res.json().catch(() => null));
    },

    awaitResult(requestId, { userId, timeoutMs, signal, final }) {
      return longPoll<OUIActionResult>({
        url: (waitMs) => {
          const query = new URLSearchParams({ userId, waitMs: String(waitMs), ...(final ? { final: '1' } : {}) });
          return `${url}/internal/oui/action-results/${encodeURIComponent(requestId)}?${query}`;
        },
        apiKey,
        timeoutMs,
        maxPollMs,
        ...(signal ? { signal } : {}),
        describe: `the result of UI action ${requestId}`,
      });
    },
  };
}

/** The receipts in an emit's response, or null when the realtime service reported none. */
function receiptsOf(body: unknown): UIDispatchReceipt | null {
  const receipts = (body as { receipts?: { acknowledged?: unknown; accepted?: unknown } } | null)?.receipts;
  if (!receipts || typeof receipts.acknowledged !== 'number' || typeof receipts.accepted !== 'number') return null;
  return { acknowledged: receipts.acknowledged, accepted: receipts.accepted };
}
