/**
 * Hearing that a turn has been asked to stop (ADR-0252 §2.1).
 *
 * The worker has no socket. The realtime server keeps a stop request (the
 * person's Stop, or the host's when a newer message supersedes the turn), and
 * the worker asks for it for as long as the turn runs, as it asks for UI
 * answers and approvals.
 */
import type { TurnStopReason, TurnStopRecord } from '@ouispec/agent-core';
import { requireRealtime } from '../emit/http-adapter.js';

/**
 * Why a turn's work was aborted, as its abort signal's reason. The stop path
 * is written against this type, so another cause that should also keep what
 * the turn produced (its deadline) is one more value of `cause`.
 */
export class TurnStopped extends Error {
  readonly cause = 'stopped' as const;
  constructor(
    readonly reason: TurnStopReason,
    /** When it was asked for, epoch ms. */
    readonly at: number,
  ) {
    super(reason === 'superseded' ? 'The turn was superseded by a newer message' : 'The turn was stopped by the person');
    this.name = 'TurnStopped';
  }
}

/** The stop a signal was aborted with, or null when it was not aborted, or was for another cause. */
export function stopOf(signal: AbortSignal | undefined): TurnStopped | null {
  return signal?.aborted && signal.reason instanceof TurnStopped ? signal.reason : null;
}

/**
 * What a tool is told of a stop: set on its context for the whole turn, and
 * answering null until the turn is asked to stop. A tool that was waiting on
 * something it sent uses `graceSignal`, never the turn's aborted signal, for
 * the one last look it takes.
 */
export interface TurnStopState {
  /** Why the turn was stopped, or null while it has not been. */
  reason(): TurnStopReason | null;
  /** Aborts when the grace after a stop is over. A fresh signal: the turn's own is already aborted. */
  graceSignal(): AbortSignal;
  /** How long after a stop an answer already on its way is still waited for. */
  graceMs: number;
}

/** How long after a stop an answer already on its way is still waited for (ADR-0252 §2.2). */
export const DEFAULT_STOP_GRACE_MS = 2_000;

export interface TurnStopClient {
  /**
   * The stop asked for on `turnId` by `userId`, waiting for one until `signal`
   * aborts. Resolves null when the signal aborts first. Never rejects: a
   * failure to ask is retried, since the request is kept and is heard late
   * rather than lost.
   */
  watch(turnId: string, userId: string, signal: AbortSignal): Promise<TurnStopRecord | null>;
}

export interface HttpTurnStopClientConfig {
  /** The realtime server's base URL. */
  url: string;
  /** Its internal key. */
  apiKey: string;
  /** Longest single wait the realtime server is asked to hold open. Default 25 s. */
  maxPollMs?: number;
  /** The longest pause between attempts while the server cannot be reached. Default 5 s. */
  maxBackoffMs?: number;
  /** Where a failed attempt is reported. */
  onError?: (error: unknown, attempt: number) => void;
}

const FIRST_BACKOFF_MS = 250;
/** A "not yet" sooner than this was not a held request. */
const UNHELD_ANSWER_MS = 50;

/**
 * The stop record over the realtime server's internal HTTP API:
 * `GET {url}/internal/turns/{turnId}/stop?userId=&waitMs=` (200 with the
 * record, 204 when none was asked for in `waitMs`).
 *
 * It fails open. Any failure (the server restarting, a 5xx, an older server
 * without the route answering 404) is retried with a growing pause, and the
 * turn runs on meanwhile: a turn must never fail because it could not ask
 * whether to stop.
 */
export function createHttpTurnStopClient(config: HttpTurnStopClientConfig): TurnStopClient {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const maxPollMs = config.maxPollMs ?? 25_000;
  const maxBackoffMs = config.maxBackoffMs ?? 5_000;

  return {
    async watch(turnId, userId, signal) {
      let backoff = FIRST_BACKOFF_MS;
      let attempt = 0;
      while (!signal.aborted) {
        attempt++;
        const asked = Date.now();
        try {
          const query = new URLSearchParams({ userId, waitMs: String(maxPollMs) });
          const res = await fetch(`${url}/internal/turns/${encodeURIComponent(turnId)}/stop?${query}`, {
            headers: { 'X-Api-Key': apiKey },
            signal: AbortSignal.any([signal, AbortSignal.timeout(maxPollMs + 5_000)]),
          });
          if (res.status === 200) return (await res.json()) as TurnStopRecord;
          if (res.status === 204) {
            backoff = FIRST_BACKOFF_MS;
            // A server that answers "not yet" at once is not holding the request open:
            // asked again without a pause, this would spin.
            if (Date.now() - asked < UNHELD_ANSWER_MS) await pause(FIRST_BACKOFF_MS, signal);
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          if (signal.aborted) return null;
          config.onError?.(err, attempt);
          await pause(backoff, signal);
          backoff = Math.min(backoff * 2, maxBackoffMs);
        }
      }
      return null;
    },
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * One turn's watch for a stop: open from before the turn reads its history
 * until the turn ends, so a stop asked for while the turn waited in a queue
 * is the first thing it hears.
 */
export interface TurnStopWatch {
  /** The stop, once one has been heard; null until then. */
  current(): TurnStopRecord | null;
  /**
   * Calls `listener` when a stop is heard, at once if one already was. At most
   * once, and never after `close`.
   */
  onStop(listener: (record: TurnStopRecord) => void): void;
  /**
   * Stop watching, and ignore a stop that is heard from now on: the turn has
   * begun its own end, and a stop that lands now is not one (ADR-0252 §2.4).
   */
  close(): void;
}

export function watchTurnStop(client: TurnStopClient | undefined, turnId: string, userId: string): TurnStopWatch {
  const controller = new AbortController();
  let heard: TurnStopRecord | null = null;
  let closed = false;
  let listener: ((record: TurnStopRecord) => void) | null = null;

  if (client) {
    void client.watch(turnId, userId, controller.signal).then(
      (record) => {
        if (!record || closed) return;
        heard = record;
        listener?.(record);
      },
      () => {
        // `watch` does not reject; a client that does is treated as hearing nothing.
      },
    );
  }

  return {
    current: () => (closed ? null : heard),
    onStop(next) {
      if (closed) return;
      listener = next;
      if (heard) next(heard);
    },
    close() {
      closed = true;
      listener = null;
      controller.abort();
    },
  };
}
