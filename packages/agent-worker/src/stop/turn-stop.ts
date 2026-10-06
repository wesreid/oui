/**
 * Hearing that a turn has been asked to stop (ADR-0252 §2.1).
 *
 * The worker has no socket. The realtime server keeps a stop request (the
 * person's Stop, or the host's when a newer message supersedes the turn), and
 * the worker asks for it for as long as the turn runs, as it asks for UI
 * answers and approvals.
 */
import type { TurnStoppedReason, TurnStopRecord } from '@ouispec/agent-core';
import { requireRealtime } from '../emit/http-adapter.js';

/**
 * Why a turn's work was aborted, as its abort signal's reason. The stop path
 * is written against this type, so another cause that should also keep what
 * the turn produced (its deadline) is one more value of `cause`.
 */
export class TurnStopped extends Error {
  readonly cause = 'stopped' as const;
  constructor(
    readonly reason: TurnStoppedReason,
    /** When it was asked for, or the deadline passed: epoch ms. */
    readonly at: number,
  ) {
    super(
      reason === 'superseded'
        ? 'The turn was superseded by a newer message'
        : reason === 'deadline'
          ? 'The turn ran out of time'
          : 'The turn was stopped by the person',
    );
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
  reason(): TurnStoppedReason | null;
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
   *
   * The first question is asked without waiting, and `onChecked` is called
   * once it is answered, whatever the answer, or has failed: from then a stop
   * that was asked for before the watch began has been heard.
   */
  watch(turnId: string, userId: string, signal: AbortSignal, onChecked?: () => void): Promise<TurnStopRecord | null>;
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
  /**
   * Called once when the server answers that it has no such route (404): a
   * realtime server from before stops were kept. The watch then ends, since
   * asking again cannot help; the turn runs on and cannot be stopped.
   */
  onUnsupported?: () => void;
}

const FIRST_BACKOFF_MS = 250;
/** The longest a turn waits for the answer to its first question before it starts anyway. */
export const FIRST_CHECK_LIMIT_MS = 1_500;
/** A "not yet" sooner than this was not a held request. */
const UNHELD_ANSWER_MS = 50;

/**
 * The stop record over the realtime server's internal HTTP API:
 * `GET {url}/internal/turns/{turnId}/stop?userId=&waitMs=` (200 with the
 * record, 204 when none was asked for in `waitMs`).
 *
 * It fails open. A failure (the server restarting, a 5xx) is retried with a
 * growing pause, and the turn runs on meanwhile: a turn must never fail
 * because it could not ask whether to stop. A 404 is not a failure to retry:
 * it is a server that keeps no stops, said once, and the watch ends.
 */
export function createHttpTurnStopClient(config: HttpTurnStopClientConfig): TurnStopClient {
  const { url, apiKey } = config;
  requireRealtime(url, apiKey);
  const maxPollMs = config.maxPollMs ?? 25_000;
  const maxBackoffMs = config.maxBackoffMs ?? 5_000;

  return {
    async watch(turnId, userId, signal, onChecked) {
      let backoff = FIRST_BACKOFF_MS;
      let attempt = 0;
      let checked = false;
      const firstAnswered = () => {
        if (checked) return;
        checked = true;
        onChecked?.();
      };
      while (!signal.aborted) {
        attempt++;
        const asked = Date.now();
        // The first question does not wait: is there a stop already?
        const waitMs = checked ? maxPollMs : 0;
        try {
          const query = new URLSearchParams({ userId, waitMs: String(waitMs) });
          const res = await fetch(`${url}/internal/turns/${encodeURIComponent(turnId)}/stop?${query}`, {
            headers: { 'X-Api-Key': apiKey },
            signal: AbortSignal.any([signal, AbortSignal.timeout(waitMs + 5_000)]),
          });
          if (res.status === 200) return (await res.json()) as TurnStopRecord;
          if (res.status === 204) {
            backoff = FIRST_BACKOFF_MS;
            // A server that answers "not yet" at once to a question that asked it to wait is not
            // holding the request open: asked again without a pause, this would spin.
            if (waitMs > 0 && Date.now() - asked < UNHELD_ANSWER_MS) await pause(FIRST_BACKOFF_MS, signal);
            firstAnswered();
            continue;
          }
          if (res.status === 404) {
            // A realtime server from before stops were kept: there is nothing to wait for.
            firstAnswered();
            config.onUnsupported?.();
            return null;
          }
          throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          firstAnswered();
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
   * Resolves once the watch has asked its first question and has the answer:
   * a stop asked for before the turn started (while it waited in a queue) has
   * been heard by then. It also resolves if the question failed, or took
   * longer than `FIRST_CHECK_LIMIT_MS`: a turn is never held up, or failed,
   * by not being able to ask.
   */
  checked(): Promise<void>;
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

  let markChecked!: () => void;
  const firstCheck = new Promise<void>((resolve) => {
    markChecked = resolve;
  });
  if (client) {
    const limit = setTimeout(markChecked, FIRST_CHECK_LIMIT_MS);
    void firstCheck.then(() => clearTimeout(limit));
    void client.watch(turnId, userId, controller.signal, markChecked).then(
      (record) => {
        if (record && !closed) {
          heard = record;
          listener?.(record);
        }
        markChecked();
      },
      () => {
        // `watch` does not reject; a client that does is treated as hearing nothing.
        markChecked();
      },
    );
  } else {
    markChecked();
  }

  return {
    current: () => (closed ? null : heard),
    checked: () => firstCheck,
    onStop(next) {
      if (closed) return;
      listener = next;
      if (heard) next(heard);
    },
    close() {
      closed = true;
      listener = null;
      controller.abort();
      markChecked();
    },
  };
}
