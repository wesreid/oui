/**
 * The shape of dev, 2026-10-02 09:11Z: two UI actions in a row, the first
 * answer slow on the tab's uplink.
 *
 * Then: the worker sent every request again each 2 s; the tab answered every
 * copy; four copies of the first ~265 KB answer queued on the tab's one socket
 * and drained about 11 s apart; the second request's answer waited behind them
 * and missed its 20 s window though its action had run, so the PA reported a
 * guide it had placed as "did not answer".
 *
 * Now the tab acknowledges receipt, the worker waits for a received request's
 * answer instead of sending it again, the tab sends one answer per request,
 * and an answer repeats the page's surfaces only when they changed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { SocketLike } from 'oui-spec/transport';
import type { OUIActionRequest, OUIActionResult } from 'oui-spec/spec';
import { buildUITools } from '../ui/ui-tools.js';
import { pageOf } from './support/page.js';
import { createUISequence } from '../ui/ui-sequence.js';
import type { UIActionChannel } from '../ui/channel.js';

/** The uplink measured on dev: ~265 KB in 7.3 s. */
const UPLINK_BYTES_PER_MS = 36;

type Handler = (...args: unknown[]) => void;

/** A tab's socket whose uplink sends one frame at a time, at UPLINK_BYTES_PER_MS. */
function tabSocket(onResult: (result: OUIActionResult) => void) {
  const handlers = new Map<string, Handler[]>();
  const wire: Array<{ requestId: string; bytes: number }> = [];
  let busyUntil = 0;
  const socket: SocketLike = {
    connected: true,
    emit(event: string, data: unknown, ack?: (r: unknown) => void) {
      if (event !== 'oui:action:result') return;
      const result = data as OUIActionResult;
      const bytes = JSON.stringify(result).length;
      wire.push({ requestId: result.requestId, bytes });
      // Frames leave in order: each starts when the one before it has gone.
      const start = Math.max(Date.now(), busyUntil);
      busyUntil = start + bytes / UPLINK_BYTES_PER_MS;
      setTimeout(() => {
        onResult(result);
        ack?.({ ok: true, kept: true });
      }, busyUntil - Date.now());
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    once() {},
  };
  /** The relay's emit into the turn's room, asking for a receipt. */
  const deliver = (request: OUIActionRequest) => {
    const acks: unknown[] = [];
    for (const h of handlers.get('oui:dispatch') ?? []) h(request, (r: unknown) => acks.push(r));
    return { acknowledged: acks.length, accepted: acks.filter((a) => (a as { ok?: unknown }).ok !== false).length };
  };
  return { socket, wire, deliver };
}

/** A studio-sized surface: 30 actions with a dozen described fields each. */
function heavy(id: string) {
  return defineSurface({
    id,
    name: `Panel ${id}`,
    description: 'A panel with a large catalog',
    actions: Array.from({ length: 30 }, (_, a) => ({
      id: `${id}_action_${a}`,
      description: `Action ${a}: sets a group of properties on the selection, each within its range.`,
      input: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (_, f) => [
            `field_${f}`,
            { type: 'number', minimum: 0, maximum: 1000, description: `Field ${f}: how far it reaches, in pixels, at the playhead.` },
          ]),
        ),
      },
      handler: async () => ({ success: true }),
    })),
  });
}

describe('two actions in a row, the first answer slow (dev, 09:11Z)', () => {
  it('answers the second within its budget, sending each request and each answer once', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      // The relay: keeps the first answer for each request.
      const kept = new Map<string, OUIActionResult>();
      const tab = tabSocket((result) => {
        if (!kept.has(result.requestId)) kept.set(result.requestId, result);
      });
      const runtime = createSurfaceRuntime({ socket: tab.socket, announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
      const editor = defineSurface<{ openPanels: () => void }>({
        id: 'editor',
        name: 'Editor',
        description: 'The editor',
        actions: [
          // Opens five heavy panels: the answer carries the new surfaces, ~265 KB.
          { id: 'editor_open_panels', description: 'Open the panels', input: { type: 'object' }, handler: async (_p, c) => (c.openPanels(), { success: true }) },
          { id: 'editor_add_guide', description: 'Add a guide', input: { type: 'object' }, handler: async () => ({ success: true, data: { guide: 'g1' } }) },
        ],
      });
      runtime.mount(editor, () => ({
        openPanels: () => {
          for (let i = 0; i < 5; i++) runtime.mount(heavy(`panel${i}`), () => ({}));
        },
      }));

      const dispatched: OUIActionRequest[] = [];
      const channel: UIActionChannel = {
        dispatch: async (_room, request) => (dispatched.push(request), tab.deliver(request)),
        awaitResult: async (requestId, { timeoutMs }) => {
          const until = Date.now() + timeoutMs;
          while (!kept.has(requestId) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
          return kept.get(requestId) ?? null;
        },
      };
      const snap = runtime.snapshot();
      const sequence = createUISequence();
      sequence.record(pageOf(snap.surfaces), snap.surfacesHash);
      const { tools } = buildUITools(pageOf(snap.surfaces), {
        channel,
        resultTimeoutMs: 20_000,
        currentPage: () => pageOf(snap.surfaces),
        sequence,
        onResult: () => {},
      });
      const tool = (name: string) => tools.find((t) => t.name === name)!;
      const ctx = (id: string) => ({ userId: 'u', accountId: 'a', turnId: 't', conversationId: 'c', toolCallId: id, socketRoom: 'room' });

      const first = tool('editor_open_panels').execute({}, ctx('first'));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await first).toMatchObject({ success: true });
      // Slow, as on dev: the first answer took about 7 s to cross the uplink.
      const firstBytes = tab.wire.find((f) => f.requestId === 'first')!.bytes;
      expect(firstBytes / UPLINK_BYTES_PER_MS).toBeGreaterThan(5_000);

      const startedSecond = Date.now();
      const second = tool('editor_add_guide').execute({}, ctx('second'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await second).toMatchObject({ success: true, data: { result: { guide: 'g1' } } });
      expect(Date.now() - startedSecond).toBeLessThan(20_000);

      // Each request sent once, and one answer per request on the uplink.
      expect(dispatched.map((r) => r.requestId)).toEqual(['first', 'second']);
      expect(tab.wire.map((f) => f.requestId)).toEqual(['first', 'second']);
      // The second answer repeats no surfaces: the worker held the ones the first brought.
      expect(dispatched[1].knownSurfaces).toBe(runtime.snapshot().surfacesHash);
      expect(tab.wire[1].bytes).toBeLessThan(4 * 1024);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
