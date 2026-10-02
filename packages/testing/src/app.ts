/**
 * An app against its generated manifest (ADR-0226 §3.2, the fourth rule):
 * every action the build declares has a handler mounted on the page that
 * offers it. A declared action nothing mounts is a tool the assistant is
 * promised and can never use.
 */
import { createElement, Fragment } from 'react';

import { NAVIGATION_SURFACE_ID, type ManifestSurface, type OuiManifest } from '@ouispec/bindings';
import { contractProblems } from '@ouispec/contract/validate';

import { describeError, mount, type ExampleElements, type Wrapper } from './harness.js';
import { ReportBuilder, type ConformanceReport } from './report.js';

export interface AppSpec {
  /** The app, for the report. */
  name: string;
  /** The build's generated manifest (`oui-manifest.json`). */
  manifest: unknown;
  /**
   * What mounts each surface, by surface id: the page component, or several
   * states of it that together show every control (a dialog open, a row
   * present). A room's surface is mounted by a page that hosts the room.
   */
  pages: Readonly<Record<string, ExampleElements | (() => ExampleElements)>>;
  /** Providers the pages need: the router, the theme, the data the page loads. */
  wrapper?: Wrapper;
}

export async function checkApp(spec: AppSpec): Promise<ConformanceReport> {
  const out = new ReportBuilder(spec.name);
  const problems = contractProblems('oui-manifest.json', spec.manifest);
  if (!out.check('matches-contract', 'manifest', problems.length ? problems.join('; ') : null)) return out.report();
  const manifest = spec.manifest as OuiManifest;

  for (const surface of manifest.surfaces) {
    // The navigation surface's action is served by the app's router (`connectBindings({ navigation })`).
    if (surface.id === NAVIGATION_SURFACE_ID) continue;
    const actions = surface.actions.filter(a => a.source === 'control' || a.source === 'room-action');
    if (!actions.length) continue;
    const fixture = spec.pages[surface.id];
    if (!fixture) {
      out.check('actions-mounted', surface.id, `offers ${actions.length} action(s), and no page in \`pages\` mounts it`);
      continue;
    }
    await checkSurface(surface, fixture, spec.wrapper, out);
  }
  for (const id of Object.keys(spec.pages)) {
    if (!manifest.surfaces.some(s => s.id === id)) out.check('actions-mounted', id, 'is in `pages` but the manifest has no such surface');
  }
  return out.report();
}

async function checkSurface(
  surface: ManifestSurface,
  fixture: ExampleElements | (() => ExampleElements),
  wrapper: Wrapper | undefined,
  out: ReportBuilder,
): Promise<void> {
  const controls = new Set<string>();
  const rooms = new Set<string>();
  const elements = typeof fixture === 'function' ? fixture() : fixture;
  for (const state of Array.isArray(elements) ? elements : [elements]) {
    let mounted;
    try {
      mounted = await mount(createElement(Fragment, null, state), wrapper);
    } catch (err) {
      out.check('actions-mounted', surface.id, `its page failed to mount: ${describeError(err)}`);
      return;
    }
    try {
      for (const c of mounted.registry.controls()) controls.add(c.id);
      for (const r of mounted.registry.rooms()) rooms.add(r.registration.catalog.room);
    } finally {
      await mounted.unmount();
    }
  }
  for (const action of surface.actions) {
    if (action.source === 'control') {
      out.check(
        'actions-mounted',
        `${surface.id} ${action.name}`,
        controls.has(action.id) ? null : `declares the control ${action.id}, and no state of the page mounts a handler for it`,
      );
    } else if (action.source === 'room-action') {
      const room = action.id.split('/')[0];
      out.check(
        'actions-mounted',
        `${surface.id} ${action.name}`,
        rooms.has(room) ? null : `belongs to the room ${room}, and no state of the page registers it`,
      );
    }
  }
}
