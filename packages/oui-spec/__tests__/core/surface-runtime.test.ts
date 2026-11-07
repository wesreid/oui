import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime } from '../../src/core/surface-runtime.js';
import { defineSurface } from '../../src/core/define-surface.js';
import { acceptCurrentTurn } from '../../src/core/accept-turn.js';
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

  it('sends the final result of work that failed as a failure, with its error and its report', async () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
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
            resolve: async () => ({
              done: true,
              data: { status: 'failed', jobId: 'job-1', error: 'GPU out of memory' },
              error: { code: 'JOB_FAILED', message: 'GPU out of memory' },
            }),
          },
          handler: async () => ({ success: true, data: { jobId: 'job-1' } }),
        },
      ],
    });
    runtime.mount(render, () => ({}));

    socket.receive('oui:dispatch', request('render', 'render_start', {}, 'async-failed'));
    await wait(FAST.quietMs + 100);

    const results = socket.emitted
      .filter(e => e.event === 'oui:action:result')
      .map(e => e.data as OUIActionResult);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ success: true, interim: true });
    expect(results[1]).toMatchObject({
      requestId: 'async-failed',
      success: false,
      interim: false,
      error: { code: 'JOB_FAILED', message: 'GPU out of memory' },
      data: { status: 'failed', jobId: 'job-1' },
    });
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

  describe('telling the application when work ends (onSettled)', () => {
    /** A job action whose work ends when `finish` is called: with its data, or failed. */
    function jobSurface() {
      let outcome: { done: boolean; data?: unknown; error?: { code: string; message: string } } = { done: false, data: { progress: 0 } };
      const surface = defineSurface({
        id: 'render',
        name: 'Render',
        description: 'r',
        actions: [
          {
            id: 'render_start',
            description: 'start',
            input: { type: 'object' },
            async: true,
            polling: { intervalMs: 10, resolve: async () => outcome },
            handler: async () => ({ success: true, data: { jobId: 'job-1' } }),
          },
          { id: 'render_name', description: 'name it', input: { type: 'object' }, handler: async () => ({ success: true }) },
        ],
      });
      return {
        surface,
        finish: (data: unknown) => (outcome = { done: true, data }),
        fail: (message: string) => (outcome = { done: true, data: { status: 'failed' }, error: { code: 'JOB_FAILED', message } }),
      };
    }
    /** The answers the tab sent, each with what acknowledges it. */
    const answers = (socket: ReturnType<typeof createMockSocket>) =>
      socket.emitted.filter(e => e.event === 'oui:action:result').map(e => ({ result: e.data as OUIActionResult, ack: e.ack! }));
    const finalOf = (socket: ReturnType<typeof createMockSocket>, requestId: string) =>
      answers(socket).filter(a => a.result.requestId === requestId && a.result.interim === false);

    it('is told once, after the final answer is acknowledged, with the request, its turn and how the work ended', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const job = jobSurface();
      runtime.mount(job.surface, () => ({}));
      const told = vi.fn();
      runtime.onSettled(told);

      socket.receive('oui:dispatch', { ...request('render', 'render_start', {}, 'job-a'), turnId: 'turn-7' });
      await wait(FAST.quietMs + 60);
      // Started, not done: the acknowledgment of the "started" answer tells nothing.
      const [started] = answers(socket);
      expect(started.result).toMatchObject({ requestId: 'job-a', interim: true });
      started.ack({ ok: true });
      expect(told).not.toHaveBeenCalled();

      job.finish({ url: 'https://x/y.mp4' });
      await wait(60);
      const [final] = finalOf(socket, 'job-a');
      expect(final.result).toMatchObject({ success: true, data: { url: 'https://x/y.mp4' } });
      // Sent, and not yet received: a reader of the agent runtime's results would not find it yet.
      expect(told).not.toHaveBeenCalled();
      const before = Date.now();
      final.ack({ ok: true });
      expect(told).toHaveBeenCalledOnce();
      expect(told.mock.calls[0][0]).toEqual({
        requestId: 'job-a',
        turnId: 'turn-7',
        surfaceId: 'render',
        actionId: 'render_start',
        success: true,
        at: expect.any(Number),
      });
      expect(told.mock.calls[0][0].at).toBeGreaterThanOrEqual(before);
      // An acknowledgment the transport repeats is not a second settlement.
      await wait(60);
      expect(told).toHaveBeenCalledOnce();
      runtime.dispose();
    });

    it('is told of work that failed as a failure, and leaves out a turn the request did not name', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const job = jobSurface();
      runtime.mount(job.surface, () => ({}));
      const told = vi.fn();
      runtime.onSettled(told);

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-b'));
      await wait(FAST.quietMs + 30);
      job.fail('GPU out of memory');
      await wait(60);
      finalOf(socket, 'job-b')[0].ack({ ok: true });
      expect(told).toHaveBeenCalledOnce();
      expect(told.mock.calls[0][0]).toMatchObject({ requestId: 'job-b', success: false });
      expect(told.mock.calls[0][0]).not.toHaveProperty('turnId');
      runtime.dispose();
    });

    it('is not told of a request that was never interim', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      runtime.mount(jobSurface().surface, () => ({}));
      const told = vi.fn();
      runtime.onSettled(told);

      socket.receive('oui:dispatch', { ...request('render', 'render_name', {}, 'sync-1'), turnId: 'turn-7' });
      await wait(FAST.quietMs + 60);
      const [only] = answers(socket);
      expect(only.result).toMatchObject({ requestId: 'sync-1', success: true });
      expect(only.result.interim).toBeUndefined();
      only.ack({ ok: true });
      expect(told).not.toHaveBeenCalled();
      runtime.dispose();
    });

    it('is told when the surface leaves the page mid-job, with the failure the runtime sends itself', async () => {
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const handle = runtime.mount(jobSurface().surface, () => ({}));
      const told = vi.fn();
      runtime.onSettled(told);

      socket.receive('oui:dispatch', { ...request('render', 'render_start', {}, 'job-gone'), turnId: 'turn-8' });
      await wait(FAST.quietMs + 30);
      handle.unmount();
      await wait(FAST.quietMs + 80);
      const [final] = finalOf(socket, 'job-gone');
      expect(final.result).toMatchObject({ success: false, error: { code: 'SURFACE_NOT_MOUNTED' } });
      final.ack({ ok: true });
      expect(told).toHaveBeenCalledOnce();
      expect(told.mock.calls[0][0]).toMatchObject({ requestId: 'job-gone', turnId: 'turn-8', actionId: 'render_start', success: false });
      runtime.dispose();
    });

    it('is told once a refused final answer is received trimmed, and never when every form of it is refused', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const job = jobSurface();
      runtime.mount(job.surface, () => ({}));
      const told = vi.fn();
      runtime.onSettled(told);

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-big'));
      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-lost'));
      await wait(FAST.quietMs + 30);
      job.finish({ url: 'https://x/y.mp4' });
      await wait(60);

      // Refused, then received without what the page offers.
      finalOf(socket, 'job-big')[0].ack({ ok: false, reason: 'too large' });
      expect(told).not.toHaveBeenCalled();
      const trimmed = finalOf(socket, 'job-big')[1];
      expect(trimmed.result.delivery).toMatchObject({ trimmed: true });
      trimmed.ack({ ok: true });
      expect(told).toHaveBeenCalledTimes(1);

      // Every form refused: the agent runtime never holds it, so nothing is told.
      for (let i = 0; i < 4; i++) finalOf(socket, 'job-lost')[i]?.ack({ ok: false, reason: 'too large' });
      expect(finalOf(socket, 'job-lost')).toHaveLength(4);
      expect(told).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      runtime.dispose();
    });

    it('survives a listener that throws: the others are told, and the runtime goes on answering', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const socket = createMockSocket();
      const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST });
      const job = jobSurface();
      runtime.mount(job.surface, () => ({}));
      runtime.onSettled(() => {
        throw new Error('listener broke');
      });
      const told = vi.fn();
      const off = runtime.onSettled(told);

      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-c'));
      await wait(FAST.quietMs + 30);
      job.finish({ ok: 1 });
      await wait(60);
      expect(() => finalOf(socket, 'job-c')[0].ack({ ok: true })).not.toThrow();
      expect(told).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/onSettled listener failed for job-c: listener broke/));

      // Removed, a listener is told nothing more; the runtime still answers.
      off();
      socket.receive('oui:dispatch', request('render', 'render_name', {}, 'after'));
      await wait(FAST.quietMs + 60);
      expect(answers(socket).some(a => a.result.requestId === 'after' && a.result.success)).toBe(true);
      socket.receive('oui:dispatch', request('render', 'render_start', {}, 'job-d'));
      await wait(FAST.quietMs + 60);
      finalOf(socket, 'job-d')[0].ack({ ok: true });
      expect(told).toHaveBeenCalledOnce();
      warn.mockRestore();
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

describe('accepting requests per turn (§7.3.1)', () => {
  function setup(currentTurn: () => string | null) {
    const socket = createMockSocket();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createSurfaceRuntime({ socket, announce: false, settle: FAST, accept: acceptCurrentTurn(currentTurn) });
    const go = vi.fn();
    runtime.mount(shell, () => ({ go }));
    const send = (turnId: string | undefined, id: string) => {
      const receipts: unknown[] = [];
      socket.receiveWithAck(
        'oui:dispatch',
        { ...request('shell', 'go', { to: '/x' }, id), ...(turnId ? { turnId } : {}) },
        (r: unknown) => receipts.push(r),
      );
      return receipts;
    };
    return { socket, runtime, go, send, done: () => (warn.mockRestore(), runtime.dispose()) };
  }

  it('runs a request of the current turn, and refuses one a superseded turn sends late', async () => {
    let current: string | null = 'turn-1';
    const { go, send, socket, done } = setup(() => current);

    send('turn-1', 'r1');
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledTimes(1);

    // The person sends a new message: the tab's turn is now turn-2, at once.
    current = 'turn-2';
    const late = send('turn-1', 'r2');
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledTimes(1);
    // Received and not accepted: the worker settles it as "not run".
    expect(late).toEqual([{ ok: false, reason: 'this client does not accept requests now' }]);
    expect(socket.emitted.filter(e => e.event === 'oui:action:result')).toHaveLength(1);

    send('turn-2', 'r3');
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledTimes(2);
    done();
  });

  it('accepts a request that names no turn while a turn is in progress: an older worker is not refused', async () => {
    let current: string | null = 'turn-1';
    const { go, send, done } = setup(() => current);

    const during = send(undefined, 'old-1');
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledTimes(1);
    expect(during).toEqual([{ ok: true }]);

    current = null;
    const after = send(undefined, 'old-2');
    await wait(FAST.quietMs + 50);
    expect(go).toHaveBeenCalledTimes(1);
    expect(after).toEqual([{ ok: false, reason: 'this client does not accept requests now' }]);
    done();
  });

  it('refuses every request while no turn runs, whatever turn it names', async () => {
    const { go, send, done } = setup(() => null);
    send('turn-1', 'r1');
    await wait(FAST.quietMs + 50);
    expect(go).not.toHaveBeenCalled();
    done();
  });
});
