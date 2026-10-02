/**
 * Work that outlives its call (a GPU job), and rows known only at run time.
 *
 * A control whose binding declares `{ kind: 'job' }` is an async action: it
 * reports "started" when the job starts, then settles on the job's outcome —
 * complete, failed, or, past its timeout, not finished (never a success). A row
 * that takes a value shows its own description, schema and value in the page
 * state, so a model's parameters are readable without their definitions in the
 * build.
 */
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBindingRegistry, deriveInputSchema, type OuiManifest } from '../src/index.js';
import { connectBindings, type JobOutcome, type JobTracker } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding } from '../src/react.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:StudioPage',
      kind: 'page',
      title: 'Studio',
      description: 'Makes images',
      routes: ['/studio'],
      actions: [
        {
          name: 'studio_generate',
          id: 'studio.generate',
          source: 'control',
          control: 'button',
          title: 'Generate',
          description: 'Generate the image',
          input: deriveInputSchema('button', {}),
          effect: { kind: 'job', estimatedDuration: '15–30 s', timeoutMs: 5_000 },
          reach: [],
        },
        {
          name: 'studio_param',
          id: 'studio.param',
          source: 'control',
          control: 'number',
          title: 'Parameter',
          description: 'Set a parameter',
          input: deriveInputSchema('number', {}, { itemized: true }),
          itemized: true,
          reach: [],
        },
      ],
      observations: [{ id: 'state', description: 'What the page shows', schema: { type: 'object' } }],
    },
  ],
};

function Generate({ dispatch }: { dispatch: () => { ok: true; pending?: { jobId: string } } }) {
  useAgentBinding({
    agent: { id: 'studio.generate', description: 'Generate the image', effect: { kind: 'job' } },
    kind: 'button',
    title: 'Generate',
    run: () => dispatch(),
  });
  return null;
}

function Param({ id, label, description, min, max, value }: { id: string; label: string; description: string; min: number; max: number; value: number }) {
  useAgentBinding({
    agent: { id: 'studio.param', description: 'Set a parameter', item: { key: id, title: label, description } },
    kind: 'number',
    title: label,
    schemaProps: { min, max, step: 1 },
    value,
    run: () => undefined,
  });
  return null;
}

/**
 * `strict` is the app's tracker: it keeps an outcome only for a job it was
 * asked to track, so an outcome that arrives before tracking is lost.
 */
function tracker({ strict = false } = {}) {
  const outcomes = new Map<string, JobOutcome>();
  const tracked = new Set<string>();
  const jobs: JobTracker = {
    track: id => void tracked.add(id),
    outcome: id => outcomes.get(id) ?? null,
    forget: id => void outcomes.delete(id),
  };
  const finish = (o: JobOutcome) => {
    if (!strict || tracked.has(o.jobId)) outcomes.set(o.jobId, o);
  };
  return { jobs, tracked, finish };
}

/** A Generate button as a page has it: disabled while its job runs, enabled again when the page hears the outcome. */
let pageHeard: ((jobId: string) => void) | null = null;
function BusyGenerate({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false);
  pageHeard = () => setBusy(false);
  useAgentBinding({
    agent: { id: 'studio.generate', description: 'Generate the image', effect: { kind: 'job' } },
    kind: 'button',
    title: 'Generate',
    disabled: busy,
    run: () => {
      setBusy(true);
      return { ok: true, pending: { jobId } };
    },
  });
  return null;
}

async function mountBusyAndGenerate(jobs: JobTracker, jobId: string) {
  const { registry, runtime } = setup(jobs);
  render(
    <AgentBindingProvider registry={registry}>
      <BusyGenerate jobId={jobId} />
    </AgentBindingProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const result = await act(async () => {
    const pending = runtime.execute({ requestId: 'busy', surfaceId: 'page:StudioPage', actionId: 'studio_generate', params: {}, timestamp: 0 });
    await vi.advanceTimersByTimeAsync(100);
    return pending;
  });
  const offered = () => runtime.snapshot().surfaces.flatMap(s => s.actions).some(a => a.id === 'studio_generate');
  return { runtime, result, offered };
}

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.useRealTimers();
});

function setup(jobs?: JobTracker) {
  const registry = createBindingRegistry();
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
  disconnect = connectBindings({ registry, runtime, manifest, ...(jobs ? { jobs } : {}) });
  return { registry, runtime };
}

const status = (runtime: ReturnType<typeof createSurfaceRuntime>) =>
  runtime.snapshot().observations['page:StudioPage']?.['page:StudioPage:studio_generate:status'] as
    | { status: string; interim: boolean; [k: string]: unknown }
    | undefined;

async function mountAndGenerate(jobs: JobTracker | undefined, dispatch: () => { ok: true; pending?: { jobId: string } }, requestId = 'r1') {
  const { registry, runtime } = setup(jobs);
  render(
    <AgentBindingProvider registry={registry}>
      <Generate dispatch={dispatch} />
    </AgentBindingProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const action = runtime.snapshot().surfaces[0].actions.find(a => a.id === 'studio_generate')!;
  const result = await act(async () => {
    const pending = runtime.execute({ requestId, surfaceId: 'page:StudioPage', actionId: 'studio_generate', params: {}, timestamp: 0 });
    await vi.advanceTimersByTimeAsync(100);
    return pending;
  });
  return { runtime, action, result };
}

const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe('a job control', () => {
  it('is an async action with its estimated duration, reported started, then complete once the job is', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const { runtime, action, result } = await mountAndGenerate(t.jobs, () => ({ ok: true, pending: { jobId: 'job-1' } }));
    expect(action.async).toBe(true);
    expect(action.estimatedDuration).toBe('15–30 s');
    expect(result).toMatchObject({ success: true, interim: true, data: { status: 'started', jobId: 'job-1' } });

    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'running', jobId: 'job-1', interim: true });
    expect(t.tracked.has('job-1')).toBe(true);

    t.finish({ status: 'complete', jobId: 'job-1', contentUrl: 'https://cdn/img.png' });
    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'complete', contentUrl: 'https://cdn/img.png', interim: false });
  });

  it('is reported failed, with the reason, when the job fails', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const { runtime } = await mountAndGenerate(t.jobs, () => ({ ok: true, pending: { jobId: 'job-2' } }));
    t.finish({ status: 'failed', jobId: 'job-2', error: 'GPU out of memory' });
    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'failed', error: 'GPU out of memory', interim: false });
  });

  it('is reported not finished, never complete, when the job outlives its timeout', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const { runtime } = await mountAndGenerate(t.jobs, () => ({ ok: true, pending: { jobId: 'job-3' } }));
    await tick(7_000);
    expect(status(runtime)).toMatchObject({ status: 'timeout', interim: false });
    // A completion after the timeout changes nothing: the action already ended as not finished.
    t.finish({ status: 'complete', jobId: 'job-3' });
    await tick(2_000);
    expect(status(runtime)?.status).toBe('timeout');
  });

  it('keeps an outcome that arrives before the first poll', async () => {
    vi.useFakeTimers();
    const t = tracker({ strict: true });
    const { runtime } = await mountAndGenerate(t.jobs, () => ({ ok: true, pending: { jobId: 'job-fast' } }));
    // Tracked when it started, not at the first poll a second later.
    expect(t.tracked.has('job-fast')).toBe(true);
    t.finish({ status: 'complete', jobId: 'job-fast', contentUrl: 'https://cdn/fast.png' });
    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'complete', contentUrl: 'https://cdn/fast.png', interim: false });
  });

  it('reaches complete when its control is disabled while the job runs, and is offered again only once enabled', async () => {
    vi.useFakeTimers();
    const t = tracker({ strict: true });
    const { runtime, result, offered } = await mountBusyAndGenerate(t.jobs, 'job-busy');
    expect(result).toMatchObject({ success: true, data: { status: 'started', jobId: 'job-busy' } });

    // Disabled while generating, but still offered: the runtime follows the job through its action.
    await tick(1_000);
    expect(offered()).toBe(true);
    expect(status(runtime)).toMatchObject({ status: 'running', jobId: 'job-busy', interim: true });
    // Pressing it meanwhile starts nothing.
    const meanwhile = await act(async () => {
      const pending = runtime.execute({ requestId: 'again', surfaceId: 'page:StudioPage', actionId: 'studio_generate', params: {}, timestamp: 0 });
      await vi.advanceTimersByTimeAsync(100);
      return pending;
    });
    expect(meanwhile).toMatchObject({ success: false, error: { code: 'UNAVAILABLE' } });

    t.finish({ status: 'complete', jobId: 'job-busy', contentUrl: 'https://cdn/busy.png' });
    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'complete', contentUrl: 'https://cdn/busy.png', interim: false });
    // Done, and still disabled: no longer offered. Enabled again: offered.
    expect(offered()).toBe(false);
    act(() => pageHeard?.('job-busy'));
    await tick(0);
    expect(offered()).toBe(true);
  });

  it('is reported not finished when a job whose control is disabled outlives its timeout, and then stops being offered', async () => {
    vi.useFakeTimers();
    const t = tracker({ strict: true });
    const { runtime, offered } = await mountBusyAndGenerate(t.jobs, 'job-stuck');
    await tick(3_000);
    expect(offered()).toBe(true);
    await tick(4_000);
    expect(status(runtime)).toMatchObject({ status: 'timeout', interim: false });
    expect(offered()).toBe(false);
  });

  it('says it cannot confirm the work when there is no job to follow', async () => {
    vi.useFakeTimers();
    const { runtime } = await mountAndGenerate(undefined, () => ({ ok: true, pending: { jobId: 'job-4' } }));
    await tick(1_000);
    expect(status(runtime)).toMatchObject({ status: 'unverified', interim: false });
  });

  it('starts one job for a request sent twice', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const dispatch = vi.fn(() => ({ ok: true as const, pending: { jobId: 'job-5' } }));
    const { runtime } = await mountAndGenerate(t.jobs, dispatch, 'same');
    const again = await act(async () => {
      const pending = runtime.execute({ requestId: 'same', surfaceId: 'page:StudioPage', actionId: 'studio_generate', params: {}, timestamp: 0 });
      await vi.advanceTimersByTimeAsync(100);
      return pending;
    });
    expect(again).toMatchObject({ success: true, data: { jobId: 'job-5' } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('rows known only at run time', () => {
  it('shows each row’s description, schema and value in the page state', async () => {
    const { registry, runtime } = setup();
    render(
      <AgentBindingProvider registry={registry}>
        <Param id="steps" label="Steps" description="How many denoising steps" min={1} max={50} value={20} />
        <Param id="cfg" label="Guidance" description="How closely to follow the prompt" min={0} max={20} value={7} />
      </AgentBindingProvider>,
    );
    await act(async () => new Promise(r => setTimeout(r, 0)));
    const state = runtime.snapshot().observations['page:StudioPage'].state as {
      lists: Record<string, { key: string; title: string; description?: string; schema?: { minimum?: number; maximum?: number }; value?: unknown }[]>;
    };
    expect(state.lists['studio.param']).toEqual([
      expect.objectContaining({ key: 'steps', title: 'Steps', description: 'How many denoising steps', value: 20, schema: expect.objectContaining({ minimum: 1, maximum: 50 }) }),
      expect.objectContaining({ key: 'cfg', title: 'Guidance', description: 'How closely to follow the prompt', value: 7, schema: expect.objectContaining({ minimum: 0, maximum: 20 }) }),
    ]);
  });
});
