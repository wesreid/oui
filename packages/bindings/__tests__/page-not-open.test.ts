/**
 * A page that does not open still says why (ADR-0220). An access guard that
 * refuses a route, or a page that fails before any of its controls mount, has
 * no page surface to report its problem with, so the navigation surface, which
 * is always there, carries it. When the page is open it reports its own.
 *
 * On dev (2026-09-30) the PA, sent to an Ops page the user could not open, saw
 * only the shell's tools and told the user the page's tools "aren't surfacing".
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it } from 'vitest';

import {
  createBindingRegistry,
  deriveInputSchema,
  LOCATION_OBSERVATION_ID,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  PROBLEMS_OBSERVATION_ID,
  PROBLEMS_SCHEMA,
  toolName,
  type OuiManifest,
  type RoomProblem,
} from '../src/index.js';
import { connectBindings, type AppNavigation } from '../src/oui.js';

const navigationSurface = (withProblems: boolean): OuiManifest['surfaces'][number] => ({
  id: NAVIGATION_SURFACE_ID,
  kind: 'navigation',
  title: 'Pages',
  description: 'Every page',
  routes: ['/ops/jobs'],
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
  observations: [
    { id: LOCATION_OBSERVATION_ID, description: 'Where', schema: { type: 'object' } },
    ...(withProblems ? [{ id: PROBLEMS_OBSERVATION_ID, description: 'Why the page does not open', schema: PROBLEMS_SCHEMA }] : []),
  ],
});

const manifest = (withProblems = true): OuiManifest => ({
  version: 1,
  buildId: 'test',
  surfaces: [
    navigationSurface(withProblems),
    {
      id: 'page:OpsJobsPage',
      kind: 'page',
      title: 'Jobs',
      description: 'Every job',
      routes: ['/ops/jobs'],
      actions: [
        {
          name: 'ops_jobs_refresh',
          id: 'ops.jobs.refresh',
          source: 'control',
          control: 'button',
          title: 'Refresh',
          description: 'Reload the jobs',
          input: deriveInputSchema('button', {}),
          reach: [],
        },
      ],
      observations: [
        { id: 'state', description: 'What the page shows', schema: { type: 'object' } },
        { id: PROBLEMS_OBSERVATION_ID, description: 'What is wrong', schema: PROBLEMS_SCHEMA },
      ],
    },
  ],
});

const navigation: AppNavigation = { navigate: () => undefined, location: () => '/ops/jobs', subscribe: () => () => undefined };
const refused: RoomProblem = { kind: 'access-required', message: 'This page needs platform admin access.' };
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function connect(m: OuiManifest) {
  const registry = createBindingRegistry();
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
  const disconnect = connectBindings({ registry, runtime, manifest: m, navigation });
  const observed = (surfaceId: string) => runtime.snapshot().observations[surfaceId]?.[PROBLEMS_OBSERVATION_ID];
  return { registry, runtime, disconnect, observed };
}

describe('a page that does not open', () => {
  it('reports why on the navigation surface when no page surface is open to carry it', async () => {
    const { registry, runtime, disconnect, observed } = connect(manifest());
    expect(observed(NAVIGATION_SURFACE_ID)).toEqual([]);

    // The guard renders its refusal instead of the page.
    const guard = registry.registerProblems('guard:platform-admin');
    guard.set([refused]);
    await settled();

    expect(runtime.snapshot().surfaces.map(s => s.id)).toEqual([NAVIGATION_SURFACE_ID]);
    expect(observed(NAVIGATION_SURFACE_ID)).toEqual([refused]);

    // Access granted: the refusal goes away.
    guard.unregister();
    await settled();
    expect(observed(NAVIGATION_SURFACE_ID)).toEqual([]);
    disconnect();
  });

  it('leaves a problem with the page when the page is open, and the navigation surface reports none', async () => {
    const { registry, disconnect, observed } = connect(manifest());
    registry.registerControl({ id: 'ops.jobs.refresh', kind: 'button', title: 'Refresh', valueSchema: null, run: () => ({ ok: true }) });
    registry.registerProblems('alert:load').set([{ kind: 'asset-failed', message: 'The jobs could not be loaded.' }]);
    await settled();

    expect(observed('page:OpsJobsPage')).toEqual([{ kind: 'asset-failed', message: 'The jobs could not be loaded.' }]);
    expect(observed(NAVIGATION_SURFACE_ID)).toEqual([]);
    disconnect();
  });

  it('reports nothing extra with a manifest whose navigation surface declares no problems', async () => {
    const { registry, disconnect, observed } = connect(manifest(false));
    registry.registerProblems('guard:platform-admin').set([refused]);
    await settled();
    expect(observed(NAVIGATION_SURFACE_ID)).toBeUndefined();
    disconnect();
  });
});
