/**
 * What an answer carries (§7.3.4, §7.3.6).
 *
 * Every answer used to carry the client's whole manifest: on a studio page
 * with ~150 actions, ~265 KB for one click. A relay that caps a frame at
 * 512 KB then drops whole answers on a heavier page, and since nothing told
 * the client, the agent waited out its deadline and reported an action that
 * had run as one that did not answer. Now an answer carries the surfaces only
 * when they differ from the ones the agent runtime holds, and a refused answer
 * is sent again trimmed, saying why.
 */
import { describe, expect, it } from 'vitest';
import { createSurfaceRuntime } from '../../src/core/surface-runtime.js';
import { defineSurface } from '../../src/core/define-surface.js';
import { fnv1a64, surfacesHash } from '../../src/spec/surfaces-hash.js';
import type { OUIActionRequest, OUIActionResult, OUISurface } from '../../src/spec/types.js';
import { createMockSocket, wait } from '../helpers/mock-socket.js';

const FAST = { quietMs: 20, timeoutMs: 400 };

function request(
  surfaceId: string,
  actionId: string,
  extra: Partial<OUIActionRequest> = {},
  requestId = `req-${Math.random()}`,
): OUIActionRequest {
  return { requestId, surfaceId, actionId, params: {}, timestamp: Date.now(), ...extra };
}

const answers = (socket: ReturnType<typeof createMockSocket>) =>
  socket.emitted.filter(e => e.event === 'oui:action:result');

/** A studio-sized surface: `actions` actions, each with a schema of `fields` described properties. */
function studioSurface(id: string, actions: number, fields: number) {
  return defineSurface<{ count: () => void }>({
    id,
    name: `Studio ${id}`,
    description: 'A room with a large catalog of actions.',
    actions: Array.from({ length: actions }, (_, a) => ({
      id: `${id}_action_${a}`,
      description: `Action ${a} of ${id}: sets a group of properties on the selection, each within its range.`,
      input: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: fields }, (_, f) => [
            `field_${f}`,
            {
              type: 'number',
              minimum: 0,
              maximum: 1000,
              description: `Field ${f}: how far the effect of this property reaches, in pixels, at the playhead.`,
            },
          ]),
        ),
      },
      handler: async (_params, ctx) => {
        ctx.count();
        return { success: true, data: { applied: a } };
      },
    })),
  });
}

describe('surfacesHash', () => {
  it('is 64-bit FNV-1a: the published vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('names the surfaces, whatever order their fields were written in, and changes with any of them', () => {
    const a: OUISurface = { id: 's', name: 'S', description: 'd', actions: [], observations: [] } as unknown as OUISurface;
    const reordered = { observations: [], actions: [], description: 'd', name: 'S', id: 's' } as unknown as OUISurface;
    expect(surfacesHash([a])).toBe(surfacesHash([reordered]));
    expect(surfacesHash([a])).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(surfacesHash([{ ...a, description: 'e' }])).not.toBe(surfacesHash([a]));
    expect(surfacesHash([a, { ...a, id: 't' }])).not.toBe(surfacesHash([{ ...a, id: 't' }, a]));
  });
});

describe('an answer carries the surfaces only when the agent runtime does not hold them', () => {
  it('reports the hash in the snapshot and in every answer', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    let n = 0;
    runtime.mount(studioSurface('room', 3, 2), () => ({ count: () => n++ }));
    const snap = runtime.snapshot();
    expect(snap.surfacesHash).toBe(surfacesHash(snap.surfaces));

    const full = await runtime.execute(request('room', 'room_action_0'));
    expect(full.surfaces).toEqual(snap.surfaces);
    expect(full.surfacesHash).toBe(snap.surfacesHash);

    const lean = await runtime.execute(request('room', 'room_action_1', { knownSurfaces: snap.surfacesHash }));
    expect(lean).not.toHaveProperty('surfaces');
    expect(lean).toMatchObject({ success: true, data: { applied: 1 }, surfacesHash: snap.surfacesHash });
    expect(n).toBe(2);
    runtime.dispose();
  });

  it('sends them when the action changed them, or the hash the runtime holds is another', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const before = runtime.snapshot().surfacesHash!;
    const nav = defineSurface<{ open: () => void }>({
      id: 'nav',
      name: 'Nav',
      description: 'n',
      actions: [
        {
          id: 'open_room',
          description: 'open the room',
          input: { type: 'object' },
          handler: async (_p, ctx) => {
            ctx.open();
            return { success: true };
          },
        },
      ],
    });
    runtime.mount(nav, () => ({ open: () => runtime.mount(studioSurface('room', 2, 1), () => ({ count: () => {} })) }));
    const mounted = runtime.snapshot().surfacesHash!;
    expect(mounted).not.toBe(before);

    const opened = await runtime.execute(request('nav', 'open_room', { knownSurfaces: mounted }));
    expect(opened.surfaces!.map(s => s.id)).toEqual(['nav', 'room']);
    expect(opened.surfacesHash).toBe(surfacesHash(opened.surfaces!));

    const stale = await runtime.execute(request('room', 'room_action_0', { knownSurfaces: 'fnv1a64:0000000000000000' }));
    expect(stale.surfaces).toBeDefined();
    runtime.dispose();
  });

  it('gives an async action’s final answer the surfaces only if they changed since its first answer', async () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
    let polls = 0;
    const render = defineSurface({
      id: 'render',
      name: 'Render',
      description: 'r',
      actions: [
        {
          id: 'render_start',
          description: 'start',
          input: { type: 'object' },
          async: true,
          polling: { intervalMs: 10, resolve: async () => (++polls >= 2 ? { done: true, data: { url: 'u' } } : { done: false }) },
          handler: async () => ({ success: true, data: { jobId: 'j' } }),
        },
      ],
    });
    runtime.mount(render, () => ({}));
    const known = runtime.snapshot().surfacesHash!;

    socket.receive('oui:dispatch', request('render', 'render_start', { knownSurfaces: known }, 'async-1'));
    await wait(FAST.quietMs + 150);
    const [first, final] = answers(socket).map(e => e.data as OUIActionResult);
    expect(first).toMatchObject({ interim: true, surfacesHash: known });
    expect(first).not.toHaveProperty('surfaces');
    expect(final).toMatchObject({ interim: false, surfacesHash: known, data: { url: 'u' } });
    expect(final).not.toHaveProperty('surfaces');
    runtime.dispose();
  });
});

describe('a refused answer is sent again trimmed, saying why', () => {
  async function answered(refusals: string[]) {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
    runtime.mount(studioSurface('room', 2, 1), () => ({ count: () => {} }));
    runtime.snapshot();
    socket.receive('oui:dispatch', request('room', 'room_action_0', {}, 'r-1'));
    await wait(FAST.quietMs + 80);
    // The receiver acknowledges each answer in turn: refusing the first `refusals.length`.
    for (let i = 0; i < refusals.length; i++) {
      const sent = answers(socket);
      expect(sent[i].ack).toBeTypeOf('function');
      sent[i].ack!({ ok: false, error: refusals[i] });
    }
    const sent = answers(socket);
    sent.at(-1)?.ack?.({ ok: true });
    runtime.dispose();
    return sent.map(e => e.data as OUIActionResult);
  }

  it('sends nothing more when the answer is accepted', async () => {
    const sent = await answered([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('delivery');
  });

  it('drops the surfaces and observations first, then the data, keeping the outcome and the reason', async () => {
    const sent = await answered(['payload larger than 524288 bytes', 'payload larger than 524288 bytes']);
    expect(sent).toHaveLength(3);
    expect(sent[0].surfaces).toBeDefined();
    expect(sent[1]).toMatchObject({
      requestId: 'r-1',
      success: true,
      data: { applied: 0 },
      delivery: { trimmed: true, reason: 'payload larger than 524288 bytes', omitted: ['surfaces', 'observations'] },
    });
    expect(sent[1]).not.toHaveProperty('surfaces');
    expect(sent[1]).not.toHaveProperty('observations');
    expect(sent[1].surfacesHash).toBe(sent[0].surfacesHash);
    expect(sent[2]).toMatchObject({
      requestId: 'r-1',
      success: true,
      delivery: { trimmed: true, omitted: ['surfaces', 'observations', 'data'] },
    });
    expect(sent[2]).not.toHaveProperty('data');
  });

  it('stops after the smallest answer is refused too', async () => {
    const sent = await answered(['rate limit exceeded', 'rate limit exceeded', 'rate limit exceeded']);
    expect(sent).toHaveLength(3);
  });
});

describe('the size of an answer on a page with many surfaces', () => {
  /** The relay's cap on one answer frame (agent-sdk-realtime's oui:action:result). */
  const RELAY_LIMIT = 512 * 1024;

  it('stays far under the relay’s limit when the agent runtime holds the surfaces, however large they are', async () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
    for (let i = 0; i < 10; i++) runtime.mount(studioSurface(`room${i}`, 30, 12), () => ({ count: () => {} }));
    const known = runtime.snapshot().surfacesHash!;

    socket.receive('oui:dispatch', request('room0', 'room0_action_0', {}, 'first'));
    socket.receive('oui:dispatch', request('room0', 'room0_action_1', { knownSurfaces: known }, 'next'));
    await wait(FAST.quietMs + 120);
    const [first, next] = answers(socket);
    const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).length;

    // The page's whole manifest: what every answer used to carry, past the relay's limit.
    expect(bytes(first.data)).toBeGreaterThan(RELAY_LIMIT);
    // What it carries now: the outcome, the observations and the hash.
    expect(bytes(next.data)).toBeLessThan(4 * 1024);
    runtime.dispose();
  });
});

describe('a request repeated while its answer is on the way (§7.3.7)', () => {
  function room(options: { reanswerAfterMs?: number; accept?: () => boolean } = {}) {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST, ...options });
    let runs = 0;
    runtime.mount(studioSurface('room', 2, 1), () => ({ count: () => runs++ }));
    // The relay's emit, asking for a receipt (§7.3.7).
    const dispatch = (req: OUIActionRequest) =>
      new Promise<unknown>(resolve => socket.receiveWithAck('oui:dispatch', req, resolve));
    return { socket, runtime, runs: () => runs, dispatch };
  }

  it('acknowledges receipt, and refuses a request the client does not accept', async () => {
    const accepting = room();
    expect(await accepting.dispatch(request('room', 'room_action_0', {}, 'q1'))).toEqual({ ok: true });
    const closed = room({ accept: () => false });
    expect(await closed.dispatch(request('room', 'room_action_0', {}, 'q2'))).toEqual({
      ok: false,
      reason: 'this client does not accept requests now',
    });
    accepting.runtime.dispose();
    closed.runtime.dispose();
  });

  it('sends one answer, however often the request is repeated while the answer is worked out or on its way', async () => {
    const { socket, runtime, runs, dispatch } = room();
    const req = request('room', 'room_action_0', {}, 'once');
    await dispatch(req);
    await dispatch(req);
    await wait(FAST.quietMs + 60);
    await dispatch(req);
    await dispatch(req);
    await wait(30);
    expect(runs()).toBe(1);
    expect(answers(socket)).toHaveLength(1);
    runtime.dispose();
  });

  it('sends no copy once the receiver acknowledged the answer, however late the repeat', async () => {
    const { socket, runtime, dispatch } = room({ reanswerAfterMs: 40 });
    const req = request('room', 'room_action_0', {}, 'received');
    await dispatch(req);
    await wait(FAST.quietMs + 60);
    answers(socket)[0].ack!({ ok: true, kept: true });
    await wait(60);
    await dispatch(req);
    await wait(20);
    expect(answers(socket)).toHaveLength(1);
    runtime.dispose();
  });

  it('answers a repeat again once its answer went unacknowledged that long: it may have been lost', async () => {
    const { socket, runtime, runs, dispatch } = room({ reanswerAfterMs: 40 });
    const req = request('room', 'room_action_0', {}, 'lost');
    await dispatch(req);
    await wait(FAST.quietMs + 60);
    await wait(50);
    await dispatch(req);
    await wait(20);
    const sent = answers(socket);
    expect(sent).toHaveLength(2);
    expect(sent[1].data).toEqual(sent[0].data);
    expect(runs()).toBe(1);
    runtime.dispose();
  });
});
