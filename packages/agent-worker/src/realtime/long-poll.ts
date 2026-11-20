/**
 * Asking the realtime server for something it holds until it arrives: a UI
 * action's answer, a job's settlement. Each request waits server-side for at
 * most `maxPollMs`; the caller asks again until its own deadline.
 *
 * 200 is the answer; 204 is "not yet", so ask again; a dropped request or a
 * 5xx is retried after a short pause, since the server keeps what it holds; a
 * refused key (401, 403) is asked again at once when the key source then holds
 * a newer key (a rotation); any other 4xx is configuration, not timing, and
 * throws rather than wait it out.
 */
import { isKeyRefusal, type RealtimeKeySource } from './api-key.js';

export interface LongPollOptions {
  /** The URL for one request that waits server-side up to `waitMs`. */
  url: (waitMs: number) => string;
  /** The realtime server's internal key, read before each request. */
  apiKey: RealtimeKeySource;
  timeoutMs: number;
  maxPollMs: number;
  signal?: AbortSignal;
  /** What is being collected, for the error a 4xx throws. */
  describe: string;
}

export async function longPoll<T>(options: LongPollOptions): Promise<T | null> {
  const { apiKey, maxPollMs, signal } = options;
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const waitMs = Math.max(0, Math.min(maxPollMs, deadline - Date.now()));

    // No key at all (the host's getter failed before it ever answered) is an error to report, not
    // a dropped request to wait out.
    const key = await apiKey.get();
    let res: Response;
    try {
      res = await fetch(options.url(waitMs), {
        headers: { 'X-Api-Key': key },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(waitMs + 5_000)]) : AbortSignal.timeout(waitMs + 5_000),
      });
    } catch {
      if (signal?.aborted) return null;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      continue;
    }

    if (res.status === 200) return (await res.json()) as T;
    if (res.status === 204) continue;
    if (res.status >= 500) {
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (isKeyRefusal(res.status) && (await apiKey.refused(key))) {
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    throw new Error(`[agent-sdk] Collecting ${options.describe} failed: HTTP ${res.status}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
