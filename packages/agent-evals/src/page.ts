/**
 * The person's page, scripted: a fixture surface runtime that answers the
 * agent's page actions as the person's tab would.
 *
 * It is a real oui-spec surface runtime in index form, the tab's own, run in
 * the process. Its surfaces are the suite's (`page.surfaces`), or the
 * product's own: the controls of its generated manifest, registered with a
 * real binding registry and connected with `connectBindings`, as the product's
 * tab does, so the agent is offered exactly the actions, inputs and page state
 * the product's build declares. A router in memory holds where the page is.
 * Going to a page (`app.navigate`) is the bindings' own navigation surface,
 * the manifest's or, with none, one made from the fixture's routes, so an
 * address is checked as the product's runtime checks it; it mounts what is
 * there and unmounts what is not, and each turn is sent from wherever the
 * page then is.
 *
 * What the page shows and what its actions do is the fixture's. Nothing it
 * runs reaches the product: an action records that it ran, answers as the
 * fixture says, and changes what the fixture says it changes.
 */
import { createSurfaceRuntime, defineSurface, type ActionHandlerResult, type MountedSurface } from 'oui-spec/core';
import type { JSONSchema, OUIActionRequest, OUIActionResult, OUIApprovalGrant } from 'oui-spec/spec';
import {
  createBindingRegistry,
  isRoutePath,
  LOCATION_OBSERVATION_ID,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  resolveKnowledge,
  toolName,
  type ControlHandle,
  type GeneratedKnowledge,
  type JsonSchema,
  type ManifestAction,
  type ManifestSurface,
  type OuiManifest,
} from '@ouispec/bindings';
import { connectBindings, type AppNavigation } from '@ouispec/bindings/oui';
import { CLIENT_KNOWLEDGE_KEY, CLIENT_SNAPSHOT_KEY, type UIActionChannel } from '@ouispec/agent-worker';
import type { AgentEvalPage, AgentEvalPageAction, AgentEvalPageControl, AgentEvalPageSurface } from '@ouispec/contract';
import { holdsSubset } from './matchers.js';

/** One action that ran on the page. */
export interface EvalPageRun {
  /** Its name in the page's index: what `ui_act` names it. */
  action: string;
  /** Its id: the binding id of a product's control, the declared id of a fixture's action. */
  id: string;
  surface: string;
  input: Record<string, unknown>;
  /** Where the page was when it ran. */
  at: string;
}

/** The page a scenario's turns are sent from. */
export interface EvalPage {
  /** What answers the worker's page actions: the runtime, in the process. */
  readonly channel: UIActionChannel;
  /** Where the page is: its path, with any query string. */
  location(): string;
  /**
   * What a turn sent from the page now carries, as the person's tab sends it:
   * `currentPath`, the runtime's snapshot (`oui`) and, given the app's
   * knowledge, the knowledge for that page (`uiKnowledge`).
   */
  context(): Promise<Record<string, unknown>>;
  /** Every action that ran on the page, in order. */
  readonly ran: readonly EvalPageRun[];
  /** Every request the worker sent it, the runtime's own (`oui.describe`, `oui.read`) included. */
  readonly requests: readonly OUIActionRequest[];
  /** The person approved a request on its card: the page will run it (oui-spec §7.3.12). */
  grant(grant: OUIApprovalGrant): void;
  close(): void;
}

/** The product's generated files a page can be built from. */
export interface EvalPageSource {
  /** The product's generated manifest (`oui-manifest.json`): what a fixture's `controls` name. */
  manifest?: OuiManifest;
  /** The product's generated knowledge (`oui-knowledge.json`): each turn carries it for the page it is sent from. */
  knowledge?: GeneratedKnowledge;
}

/** A fixture that cannot be built, with every reason. */
export class EvalPageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the page cannot be built:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EvalPageError';
  }
}

const NOTHING: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };
const pathOf = (address: string) => address.split(/[?#]/)[0].replace(/\/+$/, '') || '/';

type Outcome = Pick<AgentEvalPageAction, 'result' | 'state' | 'navigate'>;

/** What a call does: the first case whose `when` its input holds, else the action's own defaults. */
function outcomeOf(declared: Outcome & { cases?: ReadonlyArray<Outcome & { when?: Readonly<Record<string, unknown>> }> }, input: Record<string, unknown>): Outcome {
  const hit = declared.cases?.find((c) => c.when === undefined || holdsSubset(input, c.when));
  return hit ?? declared;
}

const handlerResult = (result: Outcome['result']): ActionHandlerResult =>
  !result || result.success
    ? { success: true, ...(result?.data !== undefined ? { data: result.data } : {}) }
    : { success: false, error: { code: 'FAILED', message: result.error ?? 'It failed.' }, ...(result.data !== undefined ? { data: result.data } : {}) };

/** The navigation surface the generator makes for these routes (`@ouispec/cli`), for a page with no manifest that declares one. */
function generatedNavigation(routes: readonly string[]): ManifestSurface {
  return {
    id: NAVIGATION_SURFACE_ID,
    kind: 'navigation',
    title: 'Pages',
    description: 'Every page of the app, by its address, and the page the person is on.',
    routes,
    actions: [
      {
        name: toolName(NAVIGATE_ACTION_ID),
        id: NAVIGATE_ACTION_ID,
        source: 'navigation',
        title: 'Go to a page',
        description: 'Go to a page of the app, as following a link to it does. The page’s own tools are offered once it is open.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `The page’s address, with an id in place of each :parameter. The pages: ${routes.join(', ')}.` },
          },
          required: ['path'],
          additionalProperties: false,
        },
        reach: [],
      },
    ],
    observations: [
      { id: LOCATION_OBSERVATION_ID, description: 'The address of the page the person is on.', schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ],
  };
}

/** The manifest's surfaces mounted at `path`: every one whose routes match (a shell's, with none, everywhere), and of the pages only the router's pick. */
function manifestSurfacesAt(manifest: OuiManifest, path: string): ManifestSurface[] {
  const matching = manifest.surfaces.filter(
    (s) => s.kind !== 'navigation' && (s.routes.length === 0 ? s.kind !== 'page' : isRoutePath(s.routes, path)),
  );
  const pages = matching.filter((s) => s.kind === 'page');
  // A page whose route is the address itself wins over one whose route only matches it (`/dashboard/:tab`).
  const exact = pages.filter((s) => s.routes.some((r) => pathOf(r) === pathOf(path)));
  const page = exact.length > 0 ? exact : pages.slice(0, 1);
  return matching.filter((s) => s.kind !== 'page' || page.includes(s));
}

/**
 * Build the page a fixture declares, on a real oui-spec runtime in index form.
 * Throws an `EvalPageError` naming every problem: a control the manifest does
 * not declare, `controls` with no manifest, two surfaces with one id.
 */
export function createFixturePage(fixture: AgentEvalPage, source: EvalPageSource = {}): EvalPage {
  const { manifest, knowledge } = source;
  const problems: string[] = [];
  if (fixture.controls && !manifest) problems.push('`controls` names the product’s controls, and the configuration gives no manifest (`page.manifest`)');
  const controlActions = new Map<string, { surface: ManifestSurface; action: ManifestAction }>();
  for (const surface of manifest?.surfaces ?? []) {
    for (const action of surface.actions) if (action.source === 'control') controlActions.set(action.id, { surface, action });
  }
  if (manifest) {
    for (const id of Object.keys(fixture.controls ?? {})) {
      if (!controlActions.has(id)) problems.push(`the manifest declares no control "${id}"`);
    }
  }
  const surfaceIds = new Set<string>();
  for (const s of fixture.surfaces ?? []) {
    if (surfaceIds.has(s.id)) problems.push(`two surfaces are "${s.id}"`);
    surfaceIds.add(s.id);
    if (manifest?.surfaces.some((m) => m.id === s.id)) problems.push(`the surface "${s.id}" is also one of the manifest’s`);
  }
  if (problems.length > 0) throw new EvalPageError(problems);

  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 5, timeoutMs: 500 } });
  const ran: EvalPageRun[] = [];
  const requests: OUIActionRequest[] = [];
  let location = fixture.at;
  const listeners = new Set<() => void>();

  // ─── Where the page can go ─────────────────────────────────────────────────
  const manifestNavigation = manifest?.surfaces.find((s) => s.id === NAVIGATION_SURFACE_ID && s.kind === 'navigation');
  const routes = [
    ...new Set([
      ...(fixture.routes ?? []),
      ...(fixture.surfaces ?? []).flatMap((s) => s.routes ?? []),
      ...(manifestNavigation?.routes ?? []),
      ...(manifest?.surfaces ?? []).filter((s) => s.kind === 'page').flatMap((s) => s.routes),
      pathOf(fixture.at),
    ]),
  ];
  const offersNavigation = fixture.navigation !== false;
  const go = (path: string) => {
    location = path;
    remount();
    for (const listener of [...listeners]) listener();
  };
  const navigation: AppNavigation = {
    navigate: (path) => {
      ran.push({ action: toolName(NAVIGATE_ACTION_ID), id: NAVIGATE_ACTION_ID, surface: NAVIGATION_SURFACE_ID, input: { path }, at: location });
      go(path);
    },
    location: () => location,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // ─── The product's controls, and going to a page, as its tab connects them ──
  // With no manifest, or one that declares no navigation, going to a page is
  // the surface the generator would make from these routes.
  const navigationSurface: ManifestSurface | null = manifestNavigation ?? (offersNavigation ? generatedNavigation(routes) : null);
  const connected: OuiManifest = {
    ...(manifest ?? { version: 1, buildId: 'agent-evals' }),
    surfaces: [...(manifest?.surfaces ?? []), ...(navigationSurface && !manifestNavigation ? [navigationSurface] : [])],
  };
  const registry = createBindingRegistry();
  const disconnect = connectBindings({ registry, runtime, manifest: connected, ...(offersNavigation ? { navigation } : {}) });
  /** A control's value as the page last showed it, kept while the page is elsewhere, as an app's state is. */
  const values = new Map<string, unknown>();
  const registered = new Map<string, ControlHandle[]>();

  const registerControl = (id: string, spec: AgentEvalPageControl) => {
    const { surface, action } = controlActions.get(id)!;
    const declaredValue = (action.input as { properties?: { value?: JsonSchema } }).properties?.value ?? null;
    const handles: ControlHandle[] = [];
    const register = (row?: NonNullable<AgentEvalPageControl['rows']>[number]) => {
      const key = row ? `${id}#${row.key}` : id;
      const value = values.has(key) ? values.get(key) : row ? row.value : spec.value;
      const handle = registry.registerControl({
        id,
        kind: action.control!,
        title: spec.title ?? action.title,
        valueSchema: (spec.valueSchema as JsonSchema | undefined) ?? declaredValue,
        ...(value !== undefined ? { value } : {}),
        ...(spec.disabled ? { disabled: true } : {}),
        ...(row ? { item: { key: row.key, title: row.title, ...(row.description ? { description: row.description } : {}) } } : {}),
        run: (input) => {
          const given = (input ?? {}) as Record<string, unknown>;
          ran.push({ action: action.name, id, surface: surface.id, input: row ? { ...given, item: row.key } : given, at: location });
          const outcome = outcomeOf(spec, given);
          if (outcome.result && !outcome.result.success) return { ok: false, code: 'FAILED', message: outcome.result.error ?? 'It failed.' };
          // A field takes the value it is given, as the person's typing would.
          if ('value' in given) {
            values.set(key, given.value);
            handle.update({ value: given.value });
          }
          if (outcome.navigate) queueMicrotask(() => go(outcome.navigate!));
          return { ok: true, ...(outcome.result?.data !== undefined ? { data: outcome.result.data as Record<string, unknown> } : {}) };
        },
      });
      handles.push(handle);
    };
    if (spec.rows) for (const row of spec.rows) register(row);
    else register();
    registered.set(id, handles);
  };

  /** The controls the page shows at `path`. */
  const controlsAt = (path: string): Map<string, AgentEvalPageControl> => {
    const wanted = new Map<string, AgentEvalPageControl>();
    if (!manifest) return wanted;
    const mounted = new Set(manifestSurfacesAt(manifest, path).map((s) => s.id));
    for (const [id, spec] of Object.entries(fixture.controls ?? {})) {
      const { surface } = controlActions.get(id)!;
      if (spec.routes ? isRoutePath(spec.routes, path) : mounted.has(surface.id)) wanted.set(id, spec);
    }
    if (fixture.allControls) {
      for (const surface of manifest.surfaces) {
        if (!mounted.has(surface.id)) continue;
        for (const action of surface.actions) {
          // A list's control is one per row, and no row is rendered here.
          if (action.source !== 'control' || action.itemized || !action.control || wanted.has(action.id)) continue;
          wanted.set(action.id, {});
        }
      }
    }
    return wanted;
  };

  // ─── The fixture's own surfaces ─────────────────────────────────────────────
  /** Each surface's observations as they are now, kept while it is not mounted. */
  const states = new Map<string, Record<string, unknown>>((fixture.surfaces ?? []).map((s) => [s.id, { ...(s.state ?? {}) }]));
  const mountedSurfaces = new Map<string, MountedSurface>();
  const push = (surface: AgentEvalPageSurface) => {
    const mounted = mountedSurfaces.get(surface.id);
    if (!mounted) return;
    for (const [id, value] of Object.entries(states.get(surface.id) ?? {})) mounted.pushObservation(id, value);
  };
  const observationIds = (surface: AgentEvalPageSurface) =>
    [...new Set([...Object.keys(surface.state ?? {}), ...surface.actions.flatMap((a) => [a, ...(a.cases ?? [])].flatMap((o) => Object.keys(o.state ?? {})))])];
  const defined = new Map(
    (fixture.surfaces ?? []).map((surface) => [
      surface.id,
      defineSurface<null>({
        id: surface.id,
        name: surface.name,
        description: surface.description,
        observations: observationIds(surface).map((id) => ({ id, description: id, schema: {} })),
        actions: surface.actions.map((action) => ({
          id: action.id,
          description: action.description,
          ...(action.title ? { title: action.title } : {}),
          ...(action.effect ? { effect: action.effect } : {}),
          ...(action.confirm ? { confirm: true } : {}),
          input: (action.input as JSONSchema | undefined) ?? NOTHING,
          handler: async (params: Record<string, unknown>) => {
            ran.push({ action: action.id, id: action.id, surface: surface.id, input: params, at: location });
            const outcome = outcomeOf(action, params);
            if (!outcome.result || outcome.result.success) {
              if (outcome.state) states.set(surface.id, { ...states.get(surface.id), ...outcome.state });
              push(surface);
              if (outcome.navigate) queueMicrotask(() => go(outcome.navigate!));
            }
            return handlerResult(outcome.result);
          },
        })),
      }),
    ]),
  );

  /** Mount what the page shows where it is now, and unmount what it does not. */
  function remount() {
    const path = location;
    for (const surface of fixture.surfaces ?? []) {
      const shown = !surface.routes || isRoutePath(surface.routes, path);
      const mounted = mountedSurfaces.get(surface.id);
      if (shown && !mounted) {
        mountedSurfaces.set(surface.id, runtime.mount(defined.get(surface.id)!, () => null));
        push(surface);
      } else if (!shown && mounted) {
        mounted.unmount();
        mountedSurfaces.delete(surface.id);
      }
    }
    const wanted = controlsAt(path);
    for (const [id, handles] of [...registered]) {
      if (wanted.has(id)) continue;
      for (const handle of handles) handle.unregister();
      registered.delete(id);
    }
    for (const [id, spec] of wanted) if (!registered.has(id)) registerControl(id, spec);
  }
  remount();

  /** The registry tells the connection what mounted once the current task ends; the runtime then settles. */
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  const answers = new Map<string, Promise<OUIActionResult>>();
  const channel: UIActionChannel = {
    async dispatch(_room, request) {
      requests.push(request);
      if (!answers.has(request.requestId)) answers.set(request.requestId, settled().then(() => runtime.execute(request)));
      return { acknowledged: 1, accepted: 1 };
    },
    async awaitResult(requestId) {
      return (await answers.get(requestId)) ?? null;
    },
  };

  return {
    channel,
    location: () => location,
    async context() {
      await settled();
      return {
        currentPath: location,
        [CLIENT_SNAPSHOT_KEY]: runtime.snapshot(),
        ...(knowledge ? { [CLIENT_KNOWLEDGE_KEY]: resolveKnowledge(knowledge, location) } : {}),
      };
    },
    ran,
    requests,
    grant(grant) {
      runtime.grantApproval(grant);
    },
    close() {
      disconnect();
      for (const handles of registered.values()) for (const handle of handles) handle.unregister();
      registered.clear();
      runtime.dispose();
    },
  };
}
