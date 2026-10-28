/**
 * The pieces a live-call turn is built from, one at a time: the shared turn
 * slots, a stop heard from this process, the tee that shows the host a turn's
 * events, and the event stream with its keep-alive.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { TurnStopRecord } from '@ouispec/agent-core';
import { createTurnSlots } from '../runtime/turn-slots.js';
import { withLocalStop, watchTurnStop, type TurnStopClient } from '../stop/turn-stop.js';
import { teeEmitAdapter } from '../emit/tee.js';
import { openLiveCallEventStream } from '../live-call/event-stream.js';

describe('createTurnSlots', () => {
  it('runs a turn id once at a time, refuses past capacity, and frees a slot when its work settles', async () => {
    const slots = createTurnSlots(2);
    let finishA!: () => void;
    const a = new Promise<void>((resolve) => (finishA = resolve));
    expect(slots.take('a', () => a)).toBeNull();
    expect(slots.take('a', async () => {})).toEqual({ status: 409, error: 'turn a is already running' });
    expect(slots.take('b', () => Promise.reject(new Error('b failed')))).toBeNull();
    expect(slots.running()).toBe(2);
    expect(slots.take('c', async () => {})).toEqual({ status: 503, error: 'at capacity' });
    await vi.waitFor(() => expect(slots.has('b')).toBe(false));
    finishA();
    await vi.waitFor(() => expect(slots.running()).toBe(0));
    expect(slots.take('a', async () => {})).toBeNull();
  });

  it('drains: takes no more turns, and resolves once the running ones end', async () => {
    const slots = createTurnSlots(4);
    let finish!: () => void;
    slots.take('long', () => new Promise<void>((resolve) => (finish = resolve)));
    let drained = false;
    const draining = slots.drain().then(() => (drained = true));
    expect(slots.take('late', async () => {})).toEqual({ status: 503, error: 'shutting down' });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(slots.running()).toBe(0);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => createTurnSlots(0)).toThrow(/maxConcurrentTurns must be a positive integer/);
  });
});

/** A realtime server's stop client that answers as told: a stop, nothing (404), or nothing until the watch ends. */
function serverStops(answer: 'none' | 'unsupported' | TurnStopRecord): TurnStopClient {
  return {
    async watch(_turnId, _userId, signal, onChecked) {
      onChecked?.();
      if (answer === 'unsupported') return null;
      if (answer !== 'none') return answer;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return null;
    },
  };
}

describe('withLocalStop', () => {
  it('hears this process’s stop as a superseding one, at the moment it was asked', async () => {
    const local = new AbortController();
    const watch = watchTurnStop(withLocalStop(serverStops('none'), local.signal), 'turn-1', 'visitor-1');
    await watch.checked();
    const heard = new Promise<TurnStopRecord>((resolve) => watch.onStop(resolve));
    const before = Date.now();
    local.abort('superseded');
    const record = await heard;
    expect(record).toEqual({ turnId: 'turn-1', by: 'visitor-1', reason: 'superseded', at: expect.any(Number) });
    expect(record.at).toBeGreaterThanOrEqual(before);
    expect(watch.current()).toEqual(record);
    watch.close();
  });

  it('keeps a stop request’s reason, and reads any other abort as superseded', async () => {
    for (const [reason, expected] of [
      ['user_stop', 'user_stop'],
      [new Error('socket closed'), 'superseded'],
      [undefined, 'superseded'],
    ] as const) {
      const local = new AbortController();
      local.abort(reason);
      const record = await withLocalStop(serverStops('none'), local.signal).watch('t', 'u', new AbortController().signal);
      expect(record?.reason).toBe(expected);
    }
  });

  it('still hears a stop the realtime server holds', async () => {
    const held: TurnStopRecord = { turnId: 't', by: 'visitor-1', reason: 'user_stop', at: 1_790_000_000_000 };
    const record = await withLocalStop(serverStops(held), new AbortController().signal).watch('t', 'visitor-1', new AbortController().signal);
    expect(record).toEqual(held);
  });

  it('keeps listening for the local stop when the server keeps no stops', async () => {
    const local = new AbortController();
    const watching = withLocalStop(serverStops('unsupported'), local.signal).watch('t', 'u', new AbortController().signal);
    setTimeout(() => local.abort('superseded'), 10);
    expect(await watching).toMatchObject({ reason: 'superseded' });
  });

  it('answers nothing once the watch itself ends', async () => {
    const local = new AbortController();
    const outer = new AbortController();
    const watching = withLocalStop(serverStops('none'), local.signal).watch('t', 'u', outer.signal);
    outer.abort();
    expect(await watching).toBeNull();
    local.abort();
    expect(await withLocalStop(serverStops('none'), local.signal).watch('t', 'u', outer.signal)).toBeNull();
  });
});

describe('teeEmitAdapter', () => {
  it('shows the observer each event before it is sent to the room, and sends it whatever the observer does', async () => {
    const order: string[] = [];
    const room = { emit: vi.fn(async (_room: string, event: string) => void order.push(`room:${event}`)) };
    const failures: string[] = [];
    const tee = teeEmitAdapter(
      room,
      (event) => {
        order.push(`observer:${event}`);
        if (event === 'agent:turn_complete') throw new Error('stream gone');
      },
      (_error, event) => failures.push(event),
    );
    await tee.emit('conversation:1', 'agent:token', { turnId: 't', text: 'Hi' });
    await tee.emit('conversation:1', 'agent:turn_complete', { turnId: 't' });
    expect(order).toEqual(['observer:agent:token', 'room:agent:token', 'observer:agent:turn_complete', 'room:agent:turn_complete']);
    expect(room.emit).toHaveBeenCalledWith('conversation:1', 'agent:token', { turnId: 't', text: 'Hi' });
    expect(failures).toEqual(['agent:turn_complete']);
  });
});

describe('openLiveCallEventStream', () => {
  it('answers 200 text/event-stream, writes each event as it is sent, and keeps a silent stream alive', async () => {
    const server = http.createServer((_req, res) => {
      // The rest is sent once the silence has been kept alive twice, however slowly the clock runs under load.
      let kept = 0;
      const write = res.write.bind(res) as (chunk: string) => boolean;
      res.write = ((chunk: string) => {
        const written = write(chunk);
        if (chunk === ': keep-alive\n\n' && ++kept === 2) setImmediate(finish);
        return written;
      }) as typeof res.write;
      const stream = openLiveCallEventStream(res, 40);
      stream.send('text', { text: 'One moment, ' });
      function finish() {
        stream.send('text', { text: 'here it is.\nLine two' });
        stream.send('done', { stopReason: 'complete' });
        stream.end();
        stream.send('text', { text: 'never written' });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      const body = await res.text();
      const [first, ...rest] = body.split(': keep-alive\n\n');
      expect(first).toBe('event: text\ndata: {"text":"One moment, "}\n\n');
      expect(rest.length).toBeGreaterThanOrEqual(2);
      expect(rest.at(-1)).toBe('event: text\ndata: {"text":"here it is.\\nLine two"}\n\nevent: done\ndata: {"stopReason":"complete"}\n\n');
      expect(body).not.toContain('never written');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
