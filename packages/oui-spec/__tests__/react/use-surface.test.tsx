// @vitest-environment jsdom
import { StrictMode, useState, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createSurfaceRuntime, type SurfaceRuntime } from '../../src/core/surface-runtime.js';
import { defineSurface } from '../../src/core/define-surface.js';
import { SurfaceRuntimeProvider, useObservation, useSurface, useSurfaceHold } from '../../src/react/use-surface.js';

afterEach(cleanup);

const counter = defineSurface<{ count: number; setCount: (n: number) => void }>({
  id: 'counter',
  name: 'Counter',
  description: 'A counter',
  actions: [
    {
      id: 'counter_set',
      description: 'Set the count',
      input: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      handler: async (params, ctx) => {
        ctx.setCount(params.value as number);
        return { success: true, data: { previous: ctx.count } };
      },
    },
  ],
});

function Counter() {
  const [count, setCount] = useState(0);
  const surface = useSurface({ surface: counter, context: { count, setCount } });
  useObservation(surface, 'count', count);
  return <span data-testid="count">{count}</span>;
}

function wrap(runtime: SurfaceRuntime, children: ReactNode, strict = false) {
  const tree = <SurfaceRuntimeProvider runtime={runtime}>{children}</SurfaceRuntimeProvider>;
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

describe('useSurface', () => {
  it('mounts while rendered, answers with current state, and reports the new observation', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 20, timeoutMs: 500 } });
    const view = render(wrap(runtime, <Counter />, true));

    expect(runtime.snapshot().surfaces.map(s => s.id)).toEqual(['counter']);
    expect(runtime.snapshot().observations).toEqual({ counter: { count: 0 } });

    // Outside act(): act() defers React's work until its callback returns,
    // which would hide the very re-render the runtime waits for. In a browser
    // React renders on its own scheduler while the runtime waits to settle.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const result = await runtime.execute({ requestId: 'r1', surfaceId: 'counter', actionId: 'counter_set', params: { value: 7 }, timestamp: 0 });
    g.IS_REACT_ACT_ENVIRONMENT = true;

    expect(view.getByTestId('count').textContent).toBe('7');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ previous: 0 });
    expect(result.observations).toEqual({ counter: { count: 7 } });

    view.unmount();
    expect(runtime.snapshot().surfaces).toEqual([]);
  });

  it('does not mount while inactive', () => {
    const runtime = createSurfaceRuntime({ announce: false });
    function Inactive() {
      useSurface({ surface: counter, context: { count: 0, setCount: () => {} }, active: false });
      return null;
    }
    render(wrap(runtime, <Inactive />));
    expect(runtime.snapshot().surfaces).toEqual([]);
  });

  it('keeps a result waiting while useSurfaceHold is busy', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 10, timeoutMs: 1000 } });
    let setBusy!: (b: boolean) => void;
    function Loader() {
      const [busy, set] = useState(true);
      setBusy = set;
      useSurfaceHold(busy);
      return null;
    }
    render(wrap(runtime, <><Counter /><Loader /></>));

    const done = vi.fn();
    let pending!: Promise<unknown>;
    act(() => {
      pending = runtime.execute({ requestId: 'r2', surfaceId: 'counter', actionId: 'counter_set', params: { value: 1 }, timestamp: 0 }).then(done);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(done).not.toHaveBeenCalled();

    await act(async () => { setBusy(false); await pending; });
    expect(done).toHaveBeenCalledOnce();
  });

  it('throws a clear error without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Counter />)).toThrow(/SurfaceRuntimeProvider/);
    spy.mockRestore();
  });
});
