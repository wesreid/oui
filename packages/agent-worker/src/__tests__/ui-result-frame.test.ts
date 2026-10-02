/**
 * What a UI action's answer carries (oui-spec 0.6, §7.3.4 and §7.3.6).
 *
 * Every answer used to carry the tab's whole manifest: about 265 KB per click
 * on the vector studio, half the realtime relay's 512 KB frame limit. On dev a
 * guide the PA placed was reported as "did not answer within 20s". Now the
 * worker names the surfaces it holds (`knownSurfaces`), the tab repeats them
 * only when they changed, and an answer the relay refused arrives trimmed,
 * saying why, instead of not at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import { buildUITools } from '../ui/ui-tools.js';
import { createUISequence } from '../ui/ui-sequence.js';
import type { UIActionChannel } from '../ui/channel.js';
import { readClientSnapshot } from '../ui/snapshot.js';

const ctx = (toolCallId: string) => ({ userId: 'u', accountId: 'a', turnId: 't', conversationId: 'c', toolCallId, socketRoom: 'room' });

/** A tab: a real oui-spec surface runtime, answering every request it is sent. */
function tab() {
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const editor = defineSurface<{ openPanel: () => void }>({
    id: 'editor',
    name: 'Editor',
    description: 'The editor',
    actions: [
      { id: 'editor_add_guide', description: 'Add a guide', input: { type: 'object' }, handler: async () => ({ success: true, data: { guide: 'g1' } }) },
      {
        id: 'editor_open_panel',
        description: 'Open the panel',
        input: { type: 'object' },
        handler: async (_p, c) => (c.openPanel(), { success: true }),
      },
    ],
  });
  const panel = defineSurface({ id: 'panel', name: 'Panel', description: 'A panel', actions: [] });
  runtime.mount(editor, () => ({ openPanel: () => void runtime.mount(panel, () => ({})) }));
  const sent: OUIActionRequest[] = [];
  const raw: OUIActionResult[] = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => void sent.push(request),
    awaitResult: async (requestId) => {
      const answer = await runtime.execute(sent.find((r) => r.requestId === requestId)!);
      raw.push(answer);
      return answer;
    },
  };
  return { runtime, channel, sent, raw };
}

function tools(channel: UIActionChannel, surfaces: OUISurface[], hash?: string) {
  const sequence = createUISequence();
  sequence.record(surfaces, hash);
  const results: OUIActionResult[] = [];
  const built = buildUITools(surfaces, {
    channel,
    resultTimeoutMs: 5_000,
    currentSurfaces: () => surfaces,
    sequence,
    onResult: (r) => void results.push(r),
  });
  const byName = (name: string) => built.tools.find((t) => t.name === name)!;
  return { byName, results, sequence };
}

describe('the surfaces an answer stands for', () => {
  it('names the hash it holds, and takes an answer without surfaces as the page it holds', async () => {
    const { runtime, channel, sent, raw } = tab();
    const snap = runtime.snapshot();
    const { byName, results } = tools(channel, snap.surfaces, snap.surfacesHash);

    const out = await byName('editor_add_guide').execute({}, ctx('c1'));
    expect(sent[0].knownSurfaces).toBe(snap.surfacesHash);
    expect(raw[0]).not.toHaveProperty('surfaces');
    expect(out).toMatchObject({ success: true, data: { result: { guide: 'g1' }, page: { surfaces: ['Editor'] } } });
    // The orchestrator still sees the page's surfaces on every answer.
    expect(results[0].surfaces).toEqual(snap.surfaces);
  });

  it('takes the new surfaces from an action that changed the page, and names their hash next', async () => {
    const { runtime, channel, sent } = tab();
    const snap = runtime.snapshot();
    const { byName } = tools(channel, snap.surfaces, snap.surfacesHash);

    const opened = await byName('editor_open_panel').execute({}, ctx('c1'));
    expect(opened).toMatchObject({ success: true, data: { page: { surfaces: ['Editor', 'Panel'] } } });
    await byName('editor_add_guide').execute({}, ctx('c2'));
    expect(sent[1].knownSurfaces).toBe(runtime.snapshot().surfacesHash);
    expect(sent[1].knownSurfaces).not.toBe(snap.surfacesHash);
  });

  it('asks for the whole page when an answer reports a hash it never held', async () => {
    const sent: OUIActionRequest[] = [];
    const channel: UIActionChannel = {
      dispatch: async (_room, r) => void sent.push(r),
      awaitResult: async (requestId) => ({ requestId, success: true, timestamp: 1, surfacesHash: 'fnv1a64:ffffffffffffffff' }),
    };
    const surfaces: OUISurface[] = [{ id: 's', name: 'S', description: 's', actions: [{ id: 'a', description: 'a', input: { type: 'object' } }] }];
    const { byName } = tools(channel, surfaces, 'fnv1a64:0000000000000000');
    await byName('a').execute({}, ctx('c1'));
    await byName('a').execute({}, ctx('c2'));
    expect(sent.map((r) => r.knownSurfaces)).toEqual(['fnv1a64:0000000000000000', undefined]);
  });

  it('reads the hash the client sent with its snapshot', () => {
    const surfaces: OUISurface[] = [{ id: 's', name: 'S', description: 's', actions: [] }];
    expect(readClientSnapshot({ oui: { surfaces, observations: {}, surfacesHash: 'fnv1a64:0123456789abcdef' } })).toMatchObject({
      surfacesHash: 'fnv1a64:0123456789abcdef',
    });
    expect(readClientSnapshot({ oui: { surfaces, observations: {} } })).not.toHaveProperty('surfacesHash');
  });
});

describe('an answer the relay refused, sent again trimmed', () => {
  it('is reported as what happened, with what it lacks and why', async () => {
    const surfaces: OUISurface[] = [{ id: 's', name: 'S', description: 's', actions: [{ id: 'a', description: 'a', input: { type: 'object' } }] }];
    const channel: UIActionChannel = {
      dispatch: async () => {},
      awaitResult: async (requestId) => ({
        requestId,
        success: true,
        data: { guide: 'g1' },
        timestamp: 1,
        surfacesHash: 'fnv1a64:held',
        delivery: { trimmed: true, reason: 'payload larger than 524288 bytes', omitted: ['surfaces', 'observations'] },
      }),
    };
    const { byName } = tools(channel, surfaces, 'fnv1a64:held');
    const out = await byName('a').execute({}, ctx('c1'));
    expect(out.success).toBe(true);
    expect(out.data).toMatchObject({ result: { guide: 'g1' }, page: { surfaces: ['S'] } });
    const note = (out.data as { delivery: string }).delivery;
    expect(note).toContain('payload larger than 524288 bytes');
    expect(note).toContain("the page's observations");
    expect(note).toMatch(/outcome here is what happened/);
  });
});

describe('an answer that never comes', () => {
  it('says how many times the request was sent', async () => {
    vi.useFakeTimers();
    try {
      const channel: UIActionChannel = {
        dispatch: vi.fn(async () => {}),
        awaitResult: async (_id, { timeoutMs }) => {
          await new Promise((r) => setTimeout(r, timeoutMs));
          return null;
        },
      };
      const { byName } = tools(channel, [{ id: 's', name: 'S', description: 's', actions: [{ id: 'a', description: 'a', input: { type: 'object' } }] }]);
      const pending = byName('a').execute({}, ctx('c1'));
      await vi.advanceTimersByTimeAsync(6_000);
      // A realtime service without receipts: backing off, at 0, 1 and 3 s.
      const sends = 3;
      expect(await pending).toMatchObject({
        success: false,
        error: expect.stringContaining(`did not answer "a" within 5s, though the request was sent to it ${sends} times`),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
