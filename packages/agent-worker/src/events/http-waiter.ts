/**
 * The worker's wait for a job to settle, through the SDK realtime server.
 *
 * The server keeps every declared completion or failure it emits as its job's
 * settlement (`GET /internal/events/settlements/:kind/:id`), so the worker
 * never joins a socket room: it asks, with the internal key, until the job
 * settles or its deadline passes.
 */
import type { EventWaiter, Settlement } from '@ouispec/agent-events';
import { requireRealtime } from '../emit/http-adapter.js';
import { longPoll } from '../realtime/long-poll.js';

export interface HttpEventWaiterConfig {
  /** The realtime server's base URL. */
  url: string;
  /** Its internal API key (the same key the emit adapter uses). */
  apiKey: string;
  /** Longest single wait the server is asked to hold open. Default 20 s. */
  maxPollMs?: number;
}

export function createHttpEventWaiter(config: HttpEventWaiterConfig): EventWaiter {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const maxPollMs = config.maxPollMs ?? 20_000;

  return {
    waitForSettlement({ binding, id, timeoutMs, signal }) {
      return longPoll<Settlement>({
        url: (waitMs) =>
          `${url}/internal/events/settlements/${encodeURIComponent(binding.kind)}/${encodeURIComponent(id)}?waitMs=${waitMs}`,
        apiKey,
        timeoutMs,
        maxPollMs,
        ...(signal ? { signal } : {}),
        describe: `the settlement of ${binding.kind} ${id} (${binding.usedBy})`,
      });
    },
  };
}
