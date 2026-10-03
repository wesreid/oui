/**
 * A UI request is sent again while no answer comes, until the wait ends: the
 * tab may join the turn's room only after the first send (the turn after an
 * approval runs its call at once). The tab runs a request id once, so a repeat
 * never runs the action twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest, OUIActionResult } from 'oui-spec/spec';
import { buildUITools, FIRST_RESEND_AFTER_MS, MAX_RESEND_AFTER_MS, RECEIVED_RESEND_AFTER_MS } from '../ui/ui-tools.js';
import { pageOf } from './support/page.js';
import type { UIActionChannel } from '../ui/channel.js';

describe('sending a UI request again', () => {
  it('re-sends until the tab, joined late, answers; the tab runs the action once', async () => {
    vi.useFakeTimers();
    try {
      const ran: unknown[] = [];
      const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
      const surface = defineSurface({
        id: 'reports',
        name: 'Reports',
        description: 'Reports',
        actions: [{ id: 'reports_send', description: 'Send', input: { type: 'object' }, handler: async (p) => (ran.push(p), { success: true }) }],
      });
      runtime.mount(surface, () => ({}));
      // The tab hears nothing until it joins, after the first send.
      let joined = false;
      const answers = new Map<string, Promise<OUIActionResult>>();
      const sent: OUIActionRequest[] = [];
      const channel: UIActionChannel = {
        dispatch: async (_room, request) => {
          sent.push(request);
          if (joined) answers.set(request.requestId, runtime.execute(request));
        },
        awaitResult: async (requestId, { timeoutMs }) => {
          const answer = answers.get(requestId);
          if (answer) return answer;
          await new Promise((r) => setTimeout(r, timeoutMs));
          return answers.get(requestId) ?? null;
        },
      };
      const [tool] = buildUITools(pageOf([surface.toManifest()]), { channel, resultTimeoutMs: 10_000, currentPage: () => pageOf([]), onResult: () => {} }).tools;
      const pending = tool.execute({ to: 'cfo' }, { userId: 'u', accountId: 'a', turnId: 't', conversationId: 'c', toolCallId: 'call_1', socketRoom: 'room' });
      await vi.advanceTimersByTimeAsync(FIRST_RESEND_AFTER_MS / 2);
      joined = true;
      await vi.advanceTimersByTimeAsync(FIRST_RESEND_AFTER_MS * 3);
      const result = await pending;
      expect(result.success).toBe(true);
      expect(sent.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sent.map((r) => r.requestId))).toEqual(new Set(['call_1']));
      expect(ran).toEqual([{ to: 'cfo' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops sending when the wait ends, and says the page did not answer', async () => {
    vi.useFakeTimers();
    try {
      const channel: UIActionChannel = {
        dispatch: vi.fn(async () => {}),
        awaitResult: async (_id, { timeoutMs }) => {
          await new Promise((r) => setTimeout(r, timeoutMs));
          return null;
        },
      };
      const [tool] = buildUITools(
        pageOf([{ id: 's', name: 'S', description: 's', actions: [{ id: 'a', description: 'a', input: { type: 'object' } }] }]),
        { channel, resultTimeoutMs: 5_000, currentPage: () => pageOf([]), onResult: () => {} },
      ).tools;
      const pending = tool.execute({}, { userId: 'u', accountId: 'a', turnId: 't', conversationId: 'c', toolCallId: 'call_2', socketRoom: 'room' });
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/did not answer/) });
      // Backing off: at 0, 1 and 3 s; the next, at 7 s, is past the 5 s wait.
      expect(vi.mocked(channel.dispatch).mock.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  const surfaces = [{ id: 's', name: 'S', description: 's', actions: [{ id: 'a', description: 'a', input: { type: 'object' } }] }];
  const ctx = (id: string) => ({ userId: 'u', accountId: 'a', turnId: 't', conversationId: 'c', toolCallId: id, socketRoom: 'room' });

  it('waits for the answer, without sending again, once a tab received the request (oui-spec §7.3.7)', async () => {
    vi.useFakeTimers();
    try {
      const channel: UIActionChannel = {
        dispatch: vi.fn(async () => ({ acknowledged: 1, accepted: 1 })),
        // A slow answer: 7 s on the tab's uplink.
        awaitResult: async (requestId, { timeoutMs }) => {
          const wait = Math.min(timeoutMs, 7_000 - Date.now());
          await new Promise((r) => setTimeout(r, Math.max(0, wait)));
          return Date.now() >= 7_000 ? { requestId, success: true, timestamp: 1 } : null;
        },
      };
      vi.setSystemTime(0);
      const [tool] = buildUITools(pageOf(surfaces), { channel, resultTimeoutMs: 20_000, currentPage: () => pageOf([]), onResult: () => {} }).tools;
      const pending = tool.execute({}, ctx('slow'));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toMatchObject({ success: true });
      expect(vi.mocked(channel.dispatch)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a received request again only after a long silence, in case its answer was lost', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const channel: UIActionChannel = {
        dispatch: vi.fn(async () => ({ acknowledged: 1, accepted: 1 })),
        awaitResult: async (_id, { timeoutMs }) => {
          await new Promise((r) => setTimeout(r, timeoutMs));
          return null;
        },
      };
      const [tool] = buildUITools(pageOf(surfaces), { channel, resultTimeoutMs: 20_000, currentPage: () => pageOf([]), onResult: () => {} }).tools;
      const pending = tool.execute({}, ctx('lost'));
      await vi.advanceTimersByTimeAsync(21_000);
      const result = await pending;
      // At 0 and 10 s; the next, at 20 s, is the deadline.
      expect(vi.mocked(channel.dispatch)).toHaveBeenCalledTimes(Math.ceil(20_000 / RECEIVED_RESEND_AFTER_MS));
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^The page received "a" but its answer did not arrive within 20s/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off while no tab has received it, and says no page received it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const at: number[] = [];
      const channel: UIActionChannel = {
        dispatch: vi.fn(async () => (at.push(Date.now()), { acknowledged: 0, accepted: 0 })),
        awaitResult: async (_id, { timeoutMs }) => {
          await new Promise((r) => setTimeout(r, timeoutMs));
          return null;
        },
      };
      const [tool] = buildUITools(pageOf(surfaces), { channel, resultTimeoutMs: 20_000, currentPage: () => pageOf([]), onResult: () => {} }).tools;
      const pending = tool.execute({}, ctx('nobody'));
      await vi.advanceTimersByTimeAsync(21_000);
      const result = await pending;
      expect(at).toEqual([0, 1_000, 3_000, 7_000, 7_000 + MAX_RESEND_AFTER_MS]);
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^No open page received "a" within 20s \(sent 5 times\)/) });
    } finally {
      vi.useRealTimers();
    }
  });
});
