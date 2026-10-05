/**
 * How the worker hears a stop (ADR-0252 §2.1): one long-poll to the realtime
 * server for the life of the turn. It fails open: a turn never fails, and a
 * stop is never lost, because the server could not be asked for a moment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStopRecord } from '@ouispec/agent-core';
import { createHttpTurnStopClient, TurnStopped, stopOf, watchTurnStop, type TurnStopClient } from '../stop/turn-stop.js';

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
    expect(calls[0]).toBe('http://realtime/internal/turns/t1/stop?userId=u1&waitMs=50');
  });

  it('fails open: a server that is restarting is asked again, and the stop is heard late, not lost', async () => {
    const errors: number[] = [];
    const calls = answering(
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('bad gateway', { status: 502 }),
      // An older realtime server has no such route.
      () => new Response('not found', { status: 404 }),
      () => Response.json(record),
    );
    await expect(client((_e, attempt) => errors.push(attempt)).watch('t1', 'u1', new AbortController().signal)).resolves.toEqual(record);
    expect(calls).toHaveLength(4);
    expect(errors).toEqual([1, 2, 3]);
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
