/**
 * How the worker hears a stop (ADR-0252 §2.1): one long-poll to the realtime
 * server for the life of the turn. It fails open: a turn never fails, and a
 * stop is never lost, because the server could not be asked for a moment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStopRecord } from '@ouispec/agent-core';
import { createHttpTurnStopClient, FIRST_CHECK_LIMIT_MS, TurnStopped, stopOf, watchTurnStop, type TurnStopClient } from '../stop/turn-stop.js';

const record: TurnStopRecord = { turnId: 't1', by: 'u1', reason: 'user_stop', at: 5 };

function answering(...answers: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => {
      calls.push(url);
      expect(init.headers['X-Api-Key']).toBe('key');
      const next = answers[Math.min(i++, answers.length - 1)];
      return next();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stop client', () => {
  const client = (onError?: (e: unknown, n: number) => void) =>
    createHttpTurnStopClient({ url: 'http://realtime', apiKey: 'key', maxPollMs: 50, maxBackoffMs: 20, onError });

  it('asks for its own turn and user, again and again until a stop is there', async () => {
    // The server holds each request open, then says "not yet".
    const held = () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 60));
    const calls = answering(held, held, () => Response.json(record));
    await expect(client().watch('t1', 'u1', new AbortController().signal)).resolves.toEqual(record);
    expect(calls).toHaveLength(3);
    // The first question does not wait: is there a stop already? The rest are held open.
    expect(calls[0]).toBe('http://realtime/internal/turns/t1/stop?userId=u1&waitMs=0');
    expect(calls[1]).toBe('http://realtime/internal/turns/t1/stop?userId=u1&waitMs=50');
  });

  it('fails open: a server that is restarting is asked again, and the stop is heard late, not lost', async () => {
    const errors: number[] = [];
    const calls = answering(
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('bad gateway', { status: 502 }),
      () => Response.json(record),
    );
    await expect(client((_e, attempt) => errors.push(attempt)).watch('t1', 'u1', new AbortController().signal)).resolves.toEqual(record);
    expect(calls).toHaveLength(3);
    expect(errors).toEqual([1, 2]);
  });

  it('stops asking a server that has no such route: said once, never retried, and the turn is not held up', async () => {
    const calls = answering(() => new Response('not found', { status: 404 }));
    const unsupported = vi.fn();
    const errors = vi.fn();
    const old = createHttpTurnStopClient({ url: 'http://realtime', apiKey: 'key', maxPollMs: 50, maxBackoffMs: 20, onUnsupported: unsupported, onError: errors });
    const watch = watchTurnStop(old, 't1', 'u1');
    await watch.checked();
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toHaveLength(1);
    expect(unsupported).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    expect(watch.current()).toBeNull();
    watch.close();
  });

  it('ends with nothing when the turn ends first, while waiting or while backing off', async () => {
    // A server that says "not yet" at once is not asked again in a spin.
    const calls = answering(() => new Response(null, { status: 204 }));
    const waiting = new AbortController();
    const first = client().watch('t1', 'u1', waiting.signal);
    setTimeout(() => waiting.abort(), 60);
    await expect(first).resolves.toBeNull();
    expect(calls.length).toBeLessThan(3);

    answering(() => {
      throw new TypeError('fetch failed');
    });
    const backingOff = new AbortController();
    const second = createHttpTurnStopClient({ url: 'http://realtime', apiKey: 'key', maxBackoffMs: 60_000 }).watch('t1', 'u1', backingOff.signal);
    setTimeout(() => backingOff.abort(), 20);
    await expect(second).resolves.toBeNull();
  });
});

describe('the first question', () => {
  const client = () => createHttpTurnStopClient({ url: 'http://realtime', apiKey: 'key', maxPollMs: 50, maxBackoffMs: 20 });

  it('is answered before the turn starts: a stop asked for while the turn waited in a queue is heard first', async () => {
    answering(() => Response.json(record));
    const watch = watchTurnStop(client(), 't1', 'u1');
    expect(watch.current()).toBeNull();
    await watch.checked();
    expect(watch.current()).toEqual(record);
    watch.close();
  });

  it('with no stop, lets the turn start as soon as the server has said so', async () => {
    const held = () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 60));
    answering(() => new Response(null, { status: 204 }), held);
    const watch = watchTurnStop(client(), 't1', 'u1');
    const started = Date.now();
    await watch.checked();
    expect(Date.now() - started).toBeLessThan(40);
    expect(watch.current()).toBeNull();
    watch.close();
  });

  it('never holds a turn up: a server that cannot be asked, or does not answer, lets it start', async () => {
    answering(() => {
      throw new TypeError('fetch failed');
    });
    const failing = watchTurnStop(client(), 't1', 'u1');
    await failing.checked();
    expect(failing.current()).toBeNull();
    failing.close();

    vi.useFakeTimers();
    try {
      answering(() => new Promise<Response>(() => {}));
      const silent = watchTurnStop(client(), 't1', 'u1');
      let started = false;
      void silent.checked().then(() => (started = true));
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_LIMIT_MS - 100);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(started).toBe(true);
      silent.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is answered at once without a client, and once the watch is closed', async () => {
    await watchTurnStop(undefined, 't1', 'u1').checked();
    answering(() => new Promise<Response>(() => {}));
    const watch = watchTurnStop(client(), 't1', 'u1');
    watch.close();
    await watch.checked();
  });
});

describe('a turn’s watch', () => {
  const clientThatHears = (after: number): TurnStopClient & { signal: AbortSignal | null } => {
    const c: TurnStopClient & { signal: AbortSignal | null } = {
      signal: null,
      watch: (_turnId, _userId, signal) => {
        c.signal = signal;
        return new Promise((resolve) => setTimeout(() => resolve(signal.aborted ? null : record), after));
      },
    };
    return c;
  };

  it('tells its listener once, and a listener that comes late is told at once', async () => {
    const watch = watchTurnStop(clientThatHears(10), 't1', 'u1');
    const early = vi.fn();
    watch.onStop(early);
    expect(watch.current()).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(early).toHaveBeenCalledExactlyOnceWith(record);
    expect(watch.current()).toEqual(record);

    const late = vi.fn();
    watch.onStop(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(record);
  });

  it('once closed, stops asking and ignores a stop that lands: the turn has begun its own end', async () => {
    const client = clientThatHears(20);
    const watch = watchTurnStop(client, 't1', 'u1');
    const listener = vi.fn();
    watch.onStop(listener);
    watch.close();
    expect(client.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(listener).not.toHaveBeenCalled();
    expect(watch.current()).toBeNull();
  });

  it('without a client a turn cannot be stopped, and runs as it always did', () => {
    const watch = watchTurnStop(undefined, 't1', 'u1');
    const listener = vi.fn();
    watch.onStop(listener);
    expect(watch.current()).toBeNull();
    watch.close();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the abort reason', () => {
  it('reads a stop from a signal aborted with one, and nothing from any other abort', () => {
    const stopped = new AbortController();
    stopped.abort(new TurnStopped('superseded', 9));
    expect(stopOf(stopped.signal)).toMatchObject({ reason: 'superseded', at: 9, cause: 'stopped' });

    const deadline = new AbortController();
    deadline.abort('Turn deadline exceeded');
    expect(stopOf(deadline.signal)).toBeNull();
    expect(stopOf(new AbortController().signal)).toBeNull();
    expect(stopOf(undefined)).toBeNull();
  });
});
