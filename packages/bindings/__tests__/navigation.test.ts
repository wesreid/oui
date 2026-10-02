/**
 * Going to a page by its address (ADR-0220): the generated navigation surface
 * is offered whenever the app gives its router, refuses an address that is not
 * one of the build's routes, and reports the page the person is on.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createBindingRegistry,
  LOCATION_OBSERVATION_ID,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  isRoutePath,
  toolName,
  type OuiManifest,
} from '../src/index.js';
import { connectBindings, type AppNavigation } from '../src/oui.js';

const ROUTES = ['/voices', '/voices/:id', '/clips/create'];

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: NAVIGATION_SURFACE_ID,
      kind: 'navigation',
      title: 'Pages',
      description: 'Every page',
      routes: ROUTES,
      actions: [
        {
          name: toolName(NAVIGATE_ACTION_ID),
          id: NAVIGATE_ACTION_ID,
          source: 'navigation',
          title: 'Go to a page',
          description: 'Go to a page',
          input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          reach: [],
        },
      ],
      observations: [{ id: LOCATION_OBSERVATION_ID, description: 'Where', schema: { type: 'object' } }],
    },
  ],
};

function router(start = '/voices') {
  let path = start;
  const listeners = new Set<() => void>();
  const navigation: AppNavigation = {
    navigate: vi.fn((to: string) => {
      path = to;
      listeners.forEach(l => l());
    }),
    location: () => path,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return navigation;
}

const execute = (runtime: ReturnType<typeof createSurfaceRuntime>, path: string) =>
  runtime.execute({
    requestId: path,
    surfaceId: NAVIGATION_SURFACE_ID,
    actionId: 'app_navigate',
    params: { path },
    timestamp: 0,
  });

describe('the navigation surface', () => {
  it('goes to a page by its address, with an id in place of a parameter, and reports where the person is', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const navigation = router();
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation });

    expect(runtime.snapshot().surfaces.map(s => s.id)).toEqual([NAVIGATION_SURFACE_ID]);
    expect(runtime.snapshot().observations[NAVIGATION_SURFACE_ID]?.location).toEqual({ path: '/voices' });

    const result = await execute(runtime, '/voices/v_123');
    expect(result).toMatchObject({ success: true, data: { navigatedTo: '/voices/v_123' } });
    expect(navigation.navigate).toHaveBeenCalledWith('/voices/v_123');
    expect(runtime.snapshot().observations[NAVIGATION_SURFACE_ID]?.location).toEqual({ path: '/voices/v_123' });
    disconnect();
  });

  it('refuses an address that is not a page, naming the pages, and goes nowhere', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const navigation = router();
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation });

    const result = await execute(runtime, '/voices/v_1/edit');
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'UNKNOWN_ROUTE' });
    expect(result.error?.message).toContain('/clips/create');
    expect(navigation.navigate).not.toHaveBeenCalled();
    disconnect();
  });

  it('is not offered without the app’s router', () => {
    const runtime = createSurfaceRuntime({ announce: false });
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest });
    expect(runtime.snapshot().surfaces).toEqual([]);
    disconnect();
  });

  it('matches paths as the router does: parameters, a trailing slash, a query', () => {
    expect(isRoutePath(ROUTES, '/voices/abc/')).toBe(true);
    expect(isRoutePath(ROUTES, '/clips/create?from=v1')).toBe(true);
    expect(isRoutePath(ROUTES, '/voices/abc/def')).toBe(false);
    expect(isRoutePath(ROUTES, '/nowhere')).toBe(false);
  });
});
