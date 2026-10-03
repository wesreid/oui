import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime } from '../../src/core/surface-runtime.js';
import { defineSurface } from '../../src/core/define-surface.js';
import type { OUIActionRequest, OUIActionResult } from '../../src/spec/types.js';
import { createMockSocket, wait } from '../helpers/mock-socket.js';

const FAST = { quietMs: 20, timeoutMs: 400 };

function request(surfaceId: string, actionId: string, params: Record<string, unknown> = {}, requestId = `req-${Math.random()}`): OUIActionRequest {
  return { requestId, surfaceId, actionId, params, timestamp: Date.now() };
}

const shell = defineSurface<{ go: (to: string) => void }>({
  id: 'shell',
  name: 'Shell',
  description: 'global',
  actions: [
    {
      id: 'go',
      description: 'navigate',
      input: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      handler: async (params, ctx) => {
        ctx.go(params.to as string);
        return { success: true, data: { to: params.to } };
      },
    },
  ],
});

const pageA = defineSurface({ id: 'page-a', name: 'A', description: 'a', actions: [] });
const pageB = defineSurface({
  id: 'page-b',
  name: 'B',
  description: 'b',
  actions: [{ id: 'b_do', description: 'do', input: { type: 'object' }, handler: async () => ({ success: true }) }],
});

describe('createSurfaceRuntime', () => {
  it('snapshots mounted surfaces in mount order, with their observations', () => {
    const runtime = createSurfaceRuntime({ announce: false });
    runtime.mount(shell, () => ({ go: () => {} }));
    const a = runtime.mount(pageA, () => ({}));
    a.pushObservation('items', [1, 2]);

    const snap = runtime.snapshot();
    expect(snap.surfaces.map(s => s.id)).toEqual(['shell', 'page-a']);
    expect(snap.surfaces[0].actions[0].id).toBe('go');
    expect(snap.observations).toEqual({ 'page-a': { items: [1, 2] } });
  });

  it('answers with the handler result and the surfaces after the UI settled', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    let page = runtime.mount(pageA, () => ({}));
    const go = vi.fn((to: string) => {
      // Like a router: the old page unmounts now, the new one mounts later.
      page.unmount();
      setTimeout(() => {
        if (to === '/b') page = runtime.mount(pageB, () => ({}));
      }, 10);
    });
    runtime.mount(shell, () => ({ go }));

    const result = await runtime.execute(request('shell', 'go', { to: '/b' }, 'nav-1'));

    expect(go).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ requestId: 'nav-1', success: true, data: { to: '/b' }, settled: true });
    expect(result.surfaces!.map(s => s.id)).toEqual(['shell', 'page-b']);
    expect(result.surfaces![1].actions.map(a => a.id)).toEqual(['b_do']);
  });

  it('runs a request id once, however many times it arrives', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const go = vi.fn();
    runtime.mount(shell, () => ({ go }));

    const [first, second] = await Promise.all([
      runtime.execute(request('shell', 'go', { to: '/x' }, 'dup')),
      runtime.execute(request('shell', 'go', { to: '/x' }, 'dup')),
    ]);
    const third = await runtime.execute(request('shell', 'go', { to: '/x' }, 'dup'));

    expect(go).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('refuses a request for a surface that is not mounted, naming what is', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(pageA, () => ({}));
    const result = await runtime.execute(request('page-b', 'b_do'));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SURFACE_NOT_MOUNTED');
    expect(result.error?.message).toContain('page-a');
  });

  it('reports a throwing handler as a failed result, not a crash', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(shell, () => ({ go: () => { throw new Error('router exploded'); } }));
    const result = await runtime.execute(request('shell', 'go', { to: '/x' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'ACTION_EXECUTION_ERROR', message: 'router exploded' });
  });

  it('answers with the page after a slow action’s change: quiet is measured from when the handler returned', async () => {
    // A restore: the handler awaits the network for longer than the quiet window, then changes
    // the page, which the UI renders a moment later. Measured from the request's arrival, the page
    // had already been "quiet" throughout, and the answer carried the observation before the change.
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const doc = defineSurface<{ restore: () => Promise<void> }>({
      id: 'doc',
      name: 'Document',
      description: 'a document',
      actions: [
        {
          id: 'restore',
          description: 'restore a version',
          input: { type: 'object' },
          handler: async (_params, ctx) => {
            await ctx.restore();
            return { success: true, data: { fill: 'red' } };
          },
        },
      ],
    });
    const mounted = runtime.mount(doc, () => ({
      restore: async () => {
        await wait(FAST.quietMs * 4); // the network
        setTimeout(() => mounted.pushObservation('document', { fill: 'red' }), 5); // the render after it
      },
    }));
    mounted.pushObservation('document', { fill: 'purple' });
    await wait(FAST.quietMs + 10);

    const result = await runtime.execute(request('doc', 'restore'));

    expect(result).toMatchObject({ success: true, data: { fill: 'red' }, settled: true });
    expect(result.observations).toEqual({ doc: { document: { fill: 'red' } } });
  });

  it('gives a slow action the whole settle timeout after it returns', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    let release = () => {};
    const slow = defineSurface({
      id: 'slow',
      name: 'Slow',
      description: 'slow',
      actions: [
        {
          id: 'save',
          description: 'save',
          input: { type: 'object' },
          handler: async () => {
            await wait(FAST.timeoutMs + 50); // longer than the settle timeout itself
            release = runtime.hold();
            setTimeout(() => release(), 60); // the app's own work after it, shorter than the timeout
            return { success: true };
          },
        },
      ],
    });
    runtime.mount(slow, () => ({}));
    const result = await runtime.execute(request('slow', 'save'));
    expect(result.settled).toBe(true);
  });

  it('waits for an open hold, and answers settled:false when the deadline passes first', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    runtime.mount(shell, () => ({ go: () => {} }));

    const release = runtime.hold();
    setTimeout(release, 80);
    const started = Date.now();
    const held = await runtime.execute(request('shell', 'go', { to: '/x' }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(held.settled).toBe(true);

    runtime.hold(); // never released
    const stuck = await runtime.execute(request('shell', 'go', { to: '/y' }));
    expect(stuck.settled).toBe(false);
  });

  it('keeps a surface through a StrictMode mount/unmount/mount, and the newest mount serves', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const first = vi.fn();
    const second = vi.fn();
    const m1 = runtime.mount(shell, () => ({ go: first }));
    m1.unmount();
    runtime.mount(shell, () => ({ go: second }));

    await runtime.execute(request('shell', 'go', { to: '/x' }));
    expect(runtime.snapshot().surfaces.map(s => s.id)).toEqual(['shell']);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('falls back to the older mount when the newer mount of the same id goes away', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const older = vi.fn();
    runtime.mount(shell, () => ({ go: older }));
    const newer = runtime.mount(shell, () => ({ go: () => {} }));
    newer.unmount();
    await runtime.execute(request('shell', 'go', { to: '/x' }));
    expect(older).toHaveBeenCalledOnce();
  });

  it('reads context when the action runs, not when the surface mounted', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    let current = vi.fn();
    const stale = current;
    runtime.mount(shell, () => ({ go: current }));
    current = vi.fn();
    await runtime.execute(request('shell', 'go', { to: '/x' }));
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it('answers a request that arrives on the socket, on the result channel, once', async () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
    const go = vi.fn();
    runtime.mount(shell, () => ({ go }));

    const req = request('shell', 'go', { to: '/x' }, 'wire-1');
    socket.receive('oui:dispatch', req);
    socket.receive('oui:dispatch', req);
    await wait(FAST.quietMs + 80);

    expect(go).toHaveBeenCalledOnce();
    const results = socket.emitted.filter(e => e.event === 'oui:action:result');
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect((r.data as OUIActionResult).requestId).toBe('wire-1');
    // announce:false — nothing but results goes over the wire.
    expect(socket.emitted.every(e => e.event === 'oui:action:result')).toBe(true);
  });

  it('with announce, registers on mount and announces everything again on reconnect', () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket });
    const a = runtime.mount(pageA, () => ({}));
    a.pushObservation('n', 1);
    expect(socket.emitted.map(e => e.event)).toEqual(['oui:surface:register', 'oui:observation']);

    socket.emitted.length = 0;
    socket.receive('disconnect');
    socket.connected = false;
    socket.connected = true;
    socket.receive('connect');
    expect(socket.emitted.map(e => e.event)).toEqual(['oui:surface:register', 'oui:observation']);

    socket.emitted.length = 0;
    a.unmount();
    expect(socket.emitted.map(e => e.event)).toEqual(['oui:surface:deregister']);
  });

  it('detaching from a socket removes its listeners and leaves it connected', () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false });
    expect(socket.listenerCount()).toBeGreaterThan(0);
    runtime.attach(null);
    expect(socket.listenerCount()).toBe(0);
    expect(socket.disconnectCalls).toBe(0);
  });

  it('ignores an unchanged observation and forgets observations when the surface unmounts', () => {
    const runtime = createSurfaceRuntime({ announce: false });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const a = runtime.mount(pageA, () => ({}));
    listener.mockClear();
    a.pushObservation('n', { v: 1 });
    a.pushObservation('n', { v: 1 });
    expect(listener).toHaveBeenCalledOnce();

    a.unmount();
    runtime.mount(pageA, () => ({}));
    expect(runtime.snapshot().observations).toEqual({});
  });

  it('returns JSON-safe data even when a handler returns something that is not', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: FAST });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const weird = defineSurface({
      id: 'weird',
      name: 'W',
      description: 'w',
      actions: [{ id: 'w', description: 'w', input: { type: 'object' }, handler: async () => ({ success: true, data: cyclic }) }],
    });
    runtime.mount(weird, () => ({}));
    const result = await runtime.execute(request('weird', 'w'));
    expect(result.success).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('acknowledges an async action at once, then sends its final result under the same request id', async () => {
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
          polling: {
            intervalMs: 10,
            resolve: async () => (++polls >= 2 ? { done: true, data: { url: 'https://x/y.mp4' } } : { done: false, data: { progress: 50 } }),
          },
          handler: async () => ({ success: true, data: { jobId: 'job-1' } }),
        },
      ],
    });
    runtime.mount(render, () => ({}));

    socket.receive('oui:dispatch', request('render', 'render_start', {}, 'async-1'));
    await wait(FAST.quietMs + 150);

    const results = socket.emitted
      .filter(e => e.event === 'oui:action:result')
      .map(e => e.data as OUIActionResult);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ requestId: 'async-1', success: true, interim: true, data: { jobId: 'job-1' } });
    expect(results[1]).toMatchObject({ requestId: 'async-1', success: true, interim: false, data: { url: 'https://x/y.mp4' } });
    expect(runtime.snapshot().observations.render['render:render_start:status']).toMatchObject({ interim: false });
    runtime.dispose();
  });

  describe('an async action is always answered once it has been acknowledged', () => {
    function renderSurface(resolve: () => Promise<{ done: boolean; data?: unknown }>, withAction = true) {
      return defineSurface({
        id: 'render',
        name: 'Render',
        description: 'r',
        actions: withAction
          ? [
              {
                id: 'render_start',
                description: 'start',
                input: { type: 'object' },
                async: true,
                polling: { intervalMs: 10, resolve },
                handler: async () => ({ success: true, data: { jobId: 'job-1' } }),
              },
            ]
          : [],
      });
    }

    function finalResults(socket: ReturnType<typeof createMockSocket>) {
      return socket.emitted
        .filter(e => e.event === 'oui:action:result')
        .map(e => e.data as OUIActionResult)
        .filter(r => r.interim === false);
    }

    it('keeps following the job when the surface remounts without the action', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      let polls = 0;
      const resolve = async () => (++polls >= 3 ? { done: true, data: { url: 'https://x/y.png' } } : { done: false, data: { progress: 50 } });
      const first = runtime.mount(renderSurface(resolve), () => ({}));

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-disabled'));
      await wait(FAST.quietMs + 5);
      // The control is disabled while its job runs, so the surface comes back without it.
      runtime.mount(renderSurface(resolve, false), () => ({}));
      first.unmount();
      await wait(FAST.quietMs + 150);

      expect(finalResults(socket)).toEqual([
        expect.objectContaining({ requestId: 'job-disabled', success: true, data: { url: 'https://x/y.png' } }),
      ]);
      runtime.dispose();
    });

    it('answers with a failure when the surface leaves the page mid-job', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const handle = runtime.mount(renderSurface(async () => ({ done: false, data: { progress: 10 } })), () => ({}));

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-gone'));
      await wait(FAST.quietMs + 30);
      handle.unmount();
      await wait(FAST.quietMs + 80);

      const finals = finalResults(socket);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({ requestId: 'job-gone', success: false, error: { code: 'SURFACE_NOT_MOUNTED' } });
      runtime.dispose();
    });

    it('answers the older request when the same action starts again', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      let second = false;
      const resolve = async () => (second ? { done: true, data: { ok: 2 } } : { done: false });
      runtime.mount(renderSurface(resolve), () => ({}));

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-old'));
      await wait(FAST.quietMs + 30);
      second = true;
      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-new'));
      await wait(FAST.quietMs + 120);

      const finals = finalResults(socket);
      expect(finals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: 'job-old', success: false, error: expect.objectContaining({ code: 'SUPERSEDED' }) }),
          expect.objectContaining({ requestId: 'job-new', success: true, data: { ok: 2 } }),
        ]),
      );
      expect(finals).toHaveLength(2);
      runtime.dispose();
    });
  });

  it('neither runs nor answers a socket request its accept check refuses', async () => {
    const socket = createMockSocket();
    let turnActive = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST, accept: () => turnActive });
    const go = vi.fn();
    runtime.mount(shell, () => ({ go }));

    socket.receive('oui:dispatch', request('shell', 'go', { to: '/x' }, 'no-turn'));
    await wait(FAST.quietMs + 50);
    expect(go).not.toHaveBeenCalled();
    expect(socket.emitted.filter(e => e.event === 'oui:action:result')).toEqual([]);
    expect(warn).toHaveBeenCalled();

    turnActive = true;
    socket.receive('oui:dispatch', request('shell', 'go', { to: '/x' }, 'in-turn'));
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledOnce();
    expect(socket.emitted.filter(e => e.event === 'oui:action:result')).toHaveLength(1);
    warn.mockRestore();
    runtime.dispose();
  });
});
