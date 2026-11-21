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
 *
 * What a page shows that is not a control (its displays' facts, `shown`) and
 * the problems it shows are the fixture's too, registered with the binding
 * registry as the product's displays and page areas register them, so the
 * page state carries them in the runtime's own shape. A control bound to a
 * query parameter (`query`) shows the address's value, read with the page's
 * declared query (`readQuery`), and writes the value it is given back to the
 * address (`writeQuery`), as a page that keeps its filters in its address does.
 *
 * Work an action starts that outlives its call (`job`) is the product's too:
 * the call answers started, with the job's id, and the action settles on the
 * job's outcome through the runtime's own polling of a job tracker
 * (`jobOutcomePolling`), which the fixture scripts. Requests arrive, and both
 * answers leave, on the tab's socket, in memory, as the product's tab sends
 * them, so the agent waits for the outcome as it does for the product's: in
 * the call, then with `ui_wait`.
 */
import { createSurfaceRuntime, defineSurface, type ActionHandlerResult, type MountedSurface } from 'oui-spec/core';
import type { JSONSchema, OUIActionRequest, OUIActionResult, OUIApprovalGrant } from 'oui-spec/spec';
import { createWebSocketTransport, type SocketLike } from 'oui-spec/transport';
import {
  createBindingRegistry,
  generatedNavigationSurface,
  isRoutePath,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  navigationQueries,
  pageQueryOf,
  PROBLEMS_OBSERVATION_ID,
  PROBLEMS_SCHEMA,
  readQuery,
  resolveKnowledge,
  SHOWN_ROWS,
  toolName,
  writeQuery,
  type ControlHandle,
  type FactsHandle,
  type GeneratedKnowledge,
  type JsonSchema,
  type ManifestAction,
  type ManifestSurface,
  type OuiManifest,
  type PageQuery,
  type ProblemHandle,
  type RoomProblem,
  type ShownFacts,
} from '@ouispec/bindings';
import {
  connectBindings,
  DEFAULT_JOB_TIMEOUT_MS,
  jobOutcomePolling,
  PAGE_STATE_OBSERVATION_ID,
  startedAnswer,
  type AppNavigation,
  type JobOutcome,
  type JobTracker,
} from '@ouispec/bindings/oui';
import { CLIENT_KNOWLEDGE_KEY, CLIENT_SNAPSHOT_KEY, type UIActionChannel } from '@ouispec/agent-worker';
import type {
  AgentEvalJob,
  AgentEvalPage,
  AgentEvalPageAction,
  AgentEvalPageControl,
  AgentEvalPageSurface,
  AgentEvalProblems,
  AgentEvalShown,
  AgentEvalShownQuery,
} from '@ouispec/contract';
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
/** An address's query string, without its `?`. */
const searchOf = (address: string) => {
  const beforeHash = address.split('#')[0];
  const at = beforeHash.indexOf('?');
  return at === -1 ? '' : beforeHash.slice(at + 1);
};
/** The address with this query string in place of its own, its path and fragment kept. */
const withSearch = (address: string, search: string) => {
  const hashAt = address.indexOf('#');
  const hash = hashAt === -1 ? '' : address.slice(hashAt);
  return `${address.split(/[?#]/)[0]}${search ? `?${search}` : ''}${hash}`;
};

/** The schema of a declared surface's `state` when it shows facts: `shown`, indexed as a generated page's is. */
const SHOWN_STATE_SCHEMA = {
  type: 'object',
  properties: {
    shown: {
      type: 'array',
      description: 'What the page shows that is not an action, by display: its id, heading and facts, each as text by its label',
      items: { type: 'object' },
      'x-rows': { ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] },
    },
  },
} as unknown as JSONSchema;

/** A display's entry as the page state reports it (`useAgentFacts`): each fact as text, an empty one left out. */
function shownFacts(entry: AgentEvalShown, title: string): ShownFacts {
  const facts: Record<string, string> = {};
  for (const [label, value] of Object.entries(entry.facts)) {
    const text = String(value);
    if (text !== '') facts[label] = text;
  }
  return { id: entry.id, title, facts, ...(entry.item ? { item: { ...entry.item } } : {}) };
}

type Outcome = Pick<AgentEvalPageAction, 'result' | 'state' | 'navigate' | 'job'>;

/** What a call does: the first case whose `when` its input holds, else the action's own defaults. */
function outcomeOf(declared: Outcome & { cases?: ReadonlyArray<Outcome & { when?: Readonly<Record<string, unknown>> }> }, input: Record<string, unknown>): Outcome {
  const hit = declared.cases?.find((c) => c.when === undefined || holdsSubset(input, c.when));
  return hit ?? declared;
}

/** Whether a fixture's action or control starts a job: itself, or one of its cases. */
const startsJobs = (declared: { job?: AgentEvalJob; cases?: ReadonlyArray<{ job?: AgentEvalJob }> }): boolean =>
  !!declared.job || !!declared.cases?.some((c) => c.job);

/** What a call's data is beside a started job's status and id: an object's fields. */
const startedData = (data: unknown): Readonly<Record<string, unknown>> | undefined =>
  data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;

/** Whether an effect settles on a job's outcome (`job`, `transaction`), as the bindings decide it. */
const settles = (effect: unknown): boolean => {
  const kind = typeof effect === 'string' ? effect : (effect as { kind?: unknown } | null | undefined)?.kind;
  return kind === 'job' || kind === 'transaction';
};

/**
 * The product's job tracker, scripted: each job the page's actions started,
 * and its outcome once its `settlesAfterMs` have passed. A job started again
 * under the same id (a capture continued) starts over.
 */
function createFixtureJobs(): JobTracker & { start(job: AgentEvalJob): void } {
  const started = new Map<string, { at: number; job: AgentEvalJob }>();
  return {
    start(job) {
      started.set(job.jobId, { at: Date.now(), job });
    },
    track() {},
    outcome(jobId): JobOutcome | null {
      const run = started.get(jobId);
      if (!run?.job.outcome || Date.now() - run.at < (run.job.settlesAfterMs ?? 0)) return null;
      const { outcome } = run.job;
      // As the product's declared tracker reports it: the completion's result fields beside the job id.
      return outcome.status === 'complete'
        ? { status: 'complete', jobId, ...(outcome.result ?? {}) }
        : { status: 'failed', jobId, error: outcome.error };
    },
    forget(jobId) {
      started.delete(jobId);
    },
  };
}

/**
 * The tab's socket and the relay's end of it, in memory: what one emits, the
 * other's handlers receive, with its acknowledgment callback. The relay
 * acknowledges what the tab sends it as received, as the realtime service
 * acknowledges a tab's answer.
 */
function memorySocketPair(): { tab: SocketLike; relay: SocketLike } {
  type Handler = (...args: unknown[]) => void;
  const end = (deliver: (event: string, args: unknown[]) => void, acknowledges: boolean) => {
    const handlers = new Map<string, Set<Handler>>();
    const socket: SocketLike = {
      connected: true,
      emit: (event: string, ...args: unknown[]) => deliver(event, args),
      on: (event: string, handler: Handler) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off: (event: string, handler: Handler) => void handlers.get(event)?.delete(handler),
      once: (event: string, handler: Handler) => {
        const once: Handler = (...args) => {
          handlers.get(event)?.delete(once);
          handler(...args);
        };
        socket.on(event, once);
      },
    };
    const receive = (event: string, args: unknown[]) => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      const ack = args.at(-1);
      if (acknowledges && typeof ack === 'function') ack({ ok: true });
    };
    return { socket, receive };
  };
  // Each end delivers to the other, read when a message is sent.
  const tab = end((event, args) => relay.receive(event, args), false);
  const relay = end((event, args) => tab.receive(event, args), true);
  return { tab: tab.socket, relay: relay.socket };
}

const handlerResult = (result: Outcome['result']): ActionHandlerResult =>
  !result || result.success
    ? { success: true, ...(result?.data !== undefined ? { data: result.data } : {}) }
    : { success: false, error: { code: 'FAILED', message: result.error ?? 'It failed.' }, ...(result.data !== undefined ? { data: result.data } : {}) };

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

/** The query each page declares, as the manifest's `app.navigate` records it: the routes it is on, and the declaration `readQuery` takes. */
interface DeclaredQuery {
  routes: readonly string[];
  declaration: PageQuery;
}

/** The query the page at `address` declares: its own route's, an exact route before one that only matches it. */
function queryAt(queries: readonly DeclaredQuery[], address: string): PageQuery | null {
  const path = pathOf(address);
  const exact = queries.find((q) => q.routes.some((r) => pathOf(r) === path));
  return (exact ?? queries.find((q) => isRoutePath(q.routes, path)))?.declaration ?? null;
}

/** Whether the address holds each parameter: as the page's declaration reads it (its default included), else as written. */
function holdsQuery(want: AgentEvalShownQuery | undefined, address: string, declaration: PageQuery | null): boolean {
  if (!want) return true;
  const search = searchOf(address);
  const read = declaration ? (readQuery(declaration, search) as Record<string, unknown>) : null;
  const written = new URLSearchParams(search);
  return Object.entries(want).every(([name, expected]) => {
    const got = read && name in declaration! ? read[name] : (written.get(name) ?? undefined);
    const text = Array.isArray(got) ? got.join(',') : got === undefined || got === null ? undefined : String(got);
    return text === String(expected);
  });
}

/**
 * Build the page a fixture declares, on a real oui-spec runtime in index form.
 * Throws an `EvalPageError` naming every problem: a control the manifest does
 * not declare, `controls` with no manifest, two surfaces with one id, a
 * display the manifest does not record, a control bound to a query parameter
 * no page declares.
 */
export function createFixturePage(fixture: AgentEvalPage, source: EvalPageSource = {}): EvalPage {
  const { manifest, knowledge } = source;
  const problems: string[] = [];
  if (fixture.controls && !manifest) problems.push('`controls` names the product’s controls, and the configuration gives no manifest (`page.manifest`)');
  if (fixture.shown && !manifest) problems.push('`shown` is what the product’s pages show, and the configuration gives no manifest (`page.manifest`): a declared surface shows its own (`surfaces[].shown`)');
  const controlActions = new Map<string, { surface: ManifestSurface; action: ManifestAction }>();
  for (const surface of manifest?.surfaces ?? []) {
    for (const action of surface.actions) if (action.source === 'control') controlActions.set(action.id, { surface, action });
  }
  if (manifest) {
    for (const [id, spec] of Object.entries(fixture.controls ?? {})) {
      const declared = controlActions.get(id);
      if (!declared) problems.push(`the manifest declares no control "${id}"`);
      // Only a binding that declares a job settles on one; any other reports its run done at once.
      else if (startsJobs(spec) && !settles(declared.action.effect)) {
        problems.push(`the control "${id}" starts a job, and its binding’s effect is not \`job\` or \`transaction\``);
      }
    }
  }
  for (const surface of fixture.surfaces ?? []) {
    for (const action of surface.actions) {
      if (startsJobs(action) && !settles(action.effect)) {
        problems.push(`the action "${action.id}" of "${surface.id}" starts a job, and its effect is not \`job\` or \`transaction\``);
      }
    }
  }
  const surfaceIds = new Set<string>();
  for (const s of fixture.surfaces ?? []) {
    if (surfaceIds.has(s.id)) problems.push(`two surfaces are "${s.id}"`);
    surfaceIds.add(s.id);
    if (manifest?.surfaces.some((m) => m.id === s.id)) problems.push(`the surface "${s.id}" is also one of the manifest’s`);
  }

  // The displays the manifest records (a manifest generated before 0.10 records none, and is not held to it).
  const displays = new Map<string, { title: string; surfaces: Set<string> }>();
  for (const surface of manifest?.surfaces ?? []) {
    for (const display of surface.displays ?? []) {
      const known = displays.get(display.id) ?? { title: display.title, surfaces: new Set<string>() };
      known.surfaces.add(surface.id);
      displays.set(display.id, known);
    }
  }
  if (displays.size > 0) {
    for (const id of new Set((fixture.shown ?? []).map((e) => e.id))) {
      if (!displays.has(id)) problems.push(`the manifest records no display "${id}"`);
    }
  }
  const titleOf = (entry: AgentEvalShown) => entry.title ?? displays.get(entry.id)?.title ?? entry.id;

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
  // With no manifest, or one that declares no navigation, going to a page is
  // the surface the generator would make from these routes.
  const routeTitle = (route: string) =>
    manifest?.surfaces.find((s) => s.kind === 'page' && s.routes.includes(route))?.title ??
    fixture.surfaces?.find((s) => s.routes?.includes(route))?.name ??
    route;
  const navigationSurface: ManifestSurface | null =
    manifestNavigation ?? (offersNavigation ? generatedNavigationSurface(routes.map((path) => ({ path, title: routeTitle(path) }))) : null);

  // The query each page declares, where the generator records it.
  const navigateInput = navigationSurface?.actions.find((a) => a.id === NAVIGATE_ACTION_ID)?.input;
  const queries: DeclaredQuery[] = navigationQueries(navigateInput).map((q) => ({ routes: q.routes, declaration: pageQueryOf(q.schema) }));
  for (const [id, spec] of Object.entries(fixture.controls ?? {})) {
    if (!spec.query) continue;
    if (spec.rows) problems.push(`the control "${id}" is a list’s, one per row, and follows no query parameter (?${spec.query})`);
    else if (!queries.some((q) => spec.query! in q.declaration)) {
      problems.push(`the control "${id}" follows ?${spec.query}, and no page’s query takes it (the manifest’s ${NAVIGATE_ACTION_ID} declares ${queries.length ? queries.flatMap((q) => Object.keys(q.declaration).map((n) => `?${n}`)).join(', ') : 'none'})`);
    }
  }
  if (problems.length > 0) throw new EvalPageError(problems);

  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 5, timeoutMs: 500 } });
  /** The jobs the page's actions and controls started. */
  const jobs = createFixtureJobs();
  const ran: EvalPageRun[] = [];
  const requests: OUIActionRequest[] = [];
  let location = fixture.at;
  const listeners = new Set<() => void>();

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
  const connected: OuiManifest = {
    ...(manifest ?? { version: 1, buildId: 'agent-evals' }),
    surfaces: [...(manifest?.surfaces ?? []), ...(navigationSurface && !manifestNavigation ? [navigationSurface] : [])],
  };
  const registry = createBindingRegistry();
  const disconnect = connectBindings({ registry, runtime, manifest: connected, jobs, ...(offersNavigation ? { navigation } : {}) });
  /** A control's value as the page last showed it, kept while the page is elsewhere, as an app's state is. */
  const values = new Map<string, unknown>();
  const registered = new Map<string, { spec: AgentEvalPageControl; handles: ControlHandle[] }>();

  /**
   * A control bound to a query parameter the page here declares: its value
   * as the address holds it, read as the declaration reads it (`value` when
   * the address leaves it out and the declaration has no default). Null when
   * the control follows no parameter of this page's.
   */
  const fromAddress = (spec: AgentEvalPageControl): { declaration: PageQuery; value: unknown } | null => {
    if (!spec.query || spec.rows) return null;
    const declaration = queryAt(queries, location);
    if (!declaration || !(spec.query in declaration)) return null;
    const read = (readQuery(declaration, searchOf(location)) as Record<string, unknown>)[spec.query];
    return { declaration, value: read === undefined ? spec.value : read };
  };

  const registerControl = (id: string, spec: AgentEvalPageControl) => {
    const { surface, action } = controlActions.get(id)!;
    const declaredValue = (action.input as { properties?: { value?: JsonSchema } }).properties?.value ?? null;
    const handles: ControlHandle[] = [];
    const register = (row?: NonNullable<AgentEvalPageControl['rows']>[number]) => {
      const key = row ? `${id}#${row.key}` : id;
      const bound = row ? null : fromAddress(spec);
      const value = bound ? bound.value : values.has(key) ? values.get(key) : row ? row.value : spec.value;
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
            // A filter kept in the address is written to it, as the page's `writeQuery` does.
            const writes = row ? null : fromAddress(spec);
            if (writes && !outcome.navigate) {
              const next = withSearch(location, writeQuery(writes.declaration, searchOf(location), { [spec.query!]: given.value as never }).toString());
              if (next !== location) queueMicrotask(() => go(next));
            }
          }
          if (outcome.navigate) queueMicrotask(() => go(outcome.navigate!));
          // Work that outlives the call: its job's id, which the bindings follow through the tracker.
          if (outcome.job) jobs.start(outcome.job);
          return {
            ok: true,
            ...(outcome.result?.data !== undefined ? { data: outcome.result.data as Record<string, unknown> } : {}),
            ...(outcome.job ? { pending: { jobId: outcome.job.jobId } } : {}),
          };
        },
      });
      handles.push(handle);
    };
    if (spec.rows) for (const row of spec.rows) register(row);
    else register();
    registered.set(id, { spec, handles });
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

  // ─── What the product's pages show, and the problems they show ─────────────
  /** Whether the page at `address` shows it: on its routes, else where the manifest records it, else anywhere; and its address holds its query. */
  const showsHere = (entry: AgentEvalShown | AgentEvalProblems, address: string, mounted: ReadonlySet<string>, display?: string): boolean => {
    const path = pathOf(address);
    const where = entry.routes
      ? isRoutePath(entry.routes, path)
      : display !== undefined && displays.has(display)
        ? [...displays.get(display)!.surfaces].some((id) => mounted.has(id))
        : true;
    return where && holdsQuery(entry.query, address, queryAt(queries, address));
  };
  let factsShown: { at: number[]; handles: FactsHandle[] } = { at: [], handles: [] };
  let problemsShown: { key: string; handles: ProblemHandle[] } = { key: '', handles: [] };
  const showFacts = (address: string, mounted: ReadonlySet<string>) => {
    const at = (fixture.shown ?? []).flatMap((entry, i) => (showsHere(entry, address, mounted, entry.id) ? [i] : []));
    if (at.join() === factsShown.at.join()) return;
    // Registered again in the order declared, so the page state lists them so (`factsByDisplay`).
    for (const handle of factsShown.handles) handle.unregister();
    factsShown = {
      at,
      handles: at.map((i) => {
        const entry = fixture.shown![i];
        const handle = registry.registerFacts();
        handle.set(shownFacts(entry, titleOf(entry)));
        return handle;
      }),
    };
  };
  const showProblems = (address: string, mounted: ReadonlySet<string>) => {
    // One area's problems are one registration, as `useAgentProblems` makes them.
    const bySource = new Map<string, RoomProblem[]>();
    for (const entry of fixture.problems ?? []) {
      if (!showsHere(entry, address, mounted)) continue;
      const source = entry.source ?? 'page';
      bySource.set(source, [...(bySource.get(source) ?? []), ...entry.problems]);
    }
    const key = JSON.stringify([...bySource]);
    if (key === problemsShown.key) return;
    for (const handle of problemsShown.handles) handle.unregister();
    problemsShown = {
      key,
      handles: [...bySource].map(([source, list]) => {
        const handle = registry.registerProblems(source);
        handle.set(list);
        return handle;
      }),
    };
  };

  // ─── The fixture's own surfaces ─────────────────────────────────────────────
  /** Each surface's observations as they are now, kept while it is not mounted. */
  const states = new Map<string, Record<string, unknown>>((fixture.surfaces ?? []).map((s) => [s.id, { ...(s.state ?? {}) }]));
  const mountedSurfaces = new Map<string, MountedSurface>();
  /** A surface's observations: its state, with what it shows and its problems where neither its state nor an action gave them. */
  const observed = (surface: AgentEvalPageSurface): Record<string, unknown> => {
    const state = { ...states.get(surface.id) };
    const declaration = queryAt(queries, location);
    const own = state[PAGE_STATE_OBSERVATION_ID];
    if (surface.shown && !(own && typeof own === 'object' && 'shown' in own)) {
      const shown = surface.shown.filter((e) => holdsQuery(e.query, location, declaration) && (!e.routes || isRoutePath(e.routes, pathOf(location))));
      state[PAGE_STATE_OBSERVATION_ID] = { ...(own && typeof own === 'object' ? own : {}), shown: shown.map((e) => shownFacts(e, titleOf(e))) };
    }
    if (surface.problems && !(PROBLEMS_OBSERVATION_ID in state)) {
      state[PROBLEMS_OBSERVATION_ID] = surface.problems
        .filter((e) => holdsQuery(e.query, location, declaration) && (!e.routes || isRoutePath(e.routes, pathOf(location))))
        .flatMap((e) => e.problems);
    }
    return state;
  };
  const push = (surface: AgentEvalPageSurface) => {
    const mounted = mountedSurfaces.get(surface.id);
    if (!mounted) return;
    for (const [id, value] of Object.entries(observed(surface))) mounted.pushObservation(id, value);
  };
  const observationIds = (surface: AgentEvalPageSurface) => [
    ...new Set([
      ...Object.keys(surface.state ?? {}),
      ...(surface.shown ? [PAGE_STATE_OBSERVATION_ID] : []),
      ...(surface.problems ? [PROBLEMS_OBSERVATION_ID] : []),
      ...surface.actions.flatMap((a) => [a, ...(a.cases ?? [])].flatMap((o) => Object.keys(o.state ?? {}))),
    ]),
  ];
  /** An observation's schema: what a page's is, for its state when it shows facts and for its problems. */
  const observationSchema = (surface: AgentEvalPageSurface, id: string): JSONSchema =>
    id === PAGE_STATE_OBSERVATION_ID && surface.shown
      ? SHOWN_STATE_SCHEMA
      : id === PROBLEMS_OBSERVATION_ID && surface.problems
        ? (PROBLEMS_SCHEMA as unknown as JSONSchema)
        : {};
  const defined = new Map(
    (fixture.surfaces ?? []).map((surface) => [
      surface.id,
      defineSurface<null>({
        id: surface.id,
        name: surface.name,
        description: surface.description,
        observations: observationIds(surface).map((id) => ({ id, description: id, schema: observationSchema(surface, id) })),
        actions: surface.actions.map((action) => ({
          id: action.id,
          description: action.description,
          ...(action.title ? { title: action.title } : {}),
          ...(action.effect ? { effect: action.effect } : {}),
          ...(action.confirm ? { confirm: true } : {}),
          input: (action.input as JSONSchema | undefined) ?? NOTHING,
          // An action that starts a job settles on its outcome, polled as the bindings poll a bound one.
          ...(startsJobs(action) ? { async: true, polling: jobOutcomePolling(jobs, DEFAULT_JOB_TIMEOUT_MS) } : {}),
          handler: async (params: Record<string, unknown>) => {
            ran.push({ action: action.id, id: action.id, surface: surface.id, input: params, at: location });
            const outcome = outcomeOf(action, params);
            if (!outcome.result || outcome.result.success) {
              if (outcome.state) states.set(surface.id, { ...states.get(surface.id), ...outcome.state });
              push(surface);
              if (outcome.navigate) queueMicrotask(() => go(outcome.navigate!));
              if (outcome.job) {
                jobs.start(outcome.job);
                const data = startedData(outcome.result?.data);
                return startedAnswer({ ok: true, ...(data ? { data } : {}), pending: { jobId: outcome.job.jobId } });
              }
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
      } else if (shown && (surface.shown || surface.problems)) {
        // Still here: what it shows may follow the address's query.
        push(surface);
      } else if (mounted) {
        mounted.unmount();
        mountedSurfaces.delete(surface.id);
      }
    }
    const wanted = controlsAt(path);
    for (const [id, { handles }] of [...registered]) {
      if (wanted.has(id)) continue;
      for (const handle of handles) handle.unregister();
      registered.delete(id);
    }
    for (const [id, spec] of wanted) if (!registered.has(id)) registerControl(id, spec);
    // A control bound to the address follows it, as the page re-reads its query.
    for (const { spec, handles } of registered.values()) {
      const bound = fromAddress(spec);
      if (bound) for (const handle of handles) handle.update({ value: bound.value });
    }
    const mounted = new Set(manifest ? manifestSurfacesAt(manifest, path).map((s) => s.id) : []);
    showFacts(path, mounted);
    showProblems(path, mounted);
  }
  remount();

  /** The registry tells the connection what mounted once the current task ends; the runtime then settles. */
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  // Each request's answers as the tab sent them: its first, and its final (the same one, unless it
  // started work that outlived the call), and who is waiting for either.
  const answers = new Map<string, { first?: OUIActionResult; final?: OUIActionResult; waiting: Set<() => void> }>();
  const answersOf = (requestId: string) => {
    let entry = answers.get(requestId);
    if (!entry) answers.set(requestId, (entry = { waiting: new Set() }));
    return entry;
  };
  // The tab's socket: requests arrive on it, and its answers leave on it, first and final, through
  // OUI's own transport, whose event names are OUI's.
  const sockets = memorySocketPair();
  runtime.attach(sockets.tab);
  const wire = createWebSocketTransport(sockets.relay);
  wire.onResult((result) => {
    const entry = answersOf(result.requestId);
    entry.first ??= result;
    if (!result.interim) entry.final ??= result;
    for (const wake of [...entry.waiting]) wake();
  });
  const channel: UIActionChannel = {
    async dispatch(_room, request) {
      requests.push(request);
      await settled();
      wire.dispatch(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult(requestId, { timeoutMs, signal, final }) {
      const pick = () => (final ? answers.get(requestId)?.final : answers.get(requestId)?.first) ?? null;
      const now = pick();
      if (now || signal?.aborted) return Promise.resolve(now);
      return new Promise<OUIActionResult | null>((resolve) => {
        const entry = answersOf(requestId);
        const done = (result: OUIActionResult | null) => {
          clearTimeout(timer);
          entry.waiting.delete(wake);
          signal?.removeEventListener('abort', aborted);
          resolve(result);
        };
        const wake = () => {
          const got = pick();
          if (got) done(got);
        };
        const aborted = () => done(null);
        const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
        entry.waiting.add(wake);
        signal?.addEventListener('abort', aborted, { once: true });
      });
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
      for (const { handles } of registered.values()) for (const handle of handles) handle.unregister();
      registered.clear();
      for (const handle of factsShown.handles) handle.unregister();
      for (const handle of problemsShown.handles) handle.unregister();
      wire.dispose();
      runtime.dispose();
    },
  };
}
