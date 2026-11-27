/**
 * The tab's OUI surfaces, built from the build's generated manifest and what
 * is mounted right now.
 *
 * A turn's UI tools are the intersection of the two: an action the build
 * declares whose control (or room) is on screen. Each action runs the
 * control's own handler, or the room's own entry, so the assistant and the
 * person go through one code path.
 */

import {
  defineSurface,
  type ActionDefinition,
  type ActionHandlerResult,
  type MountedSurface,
  type SurfaceForm,
  type SurfaceRuntime,
} from 'oui-spec/core';
import { sharedIdPrefix } from 'oui-spec/spec';

import { deriveInputSchema, ITEM_PROPERTY, itemSchema, MAX_DESCRIBED_OPTIONS, PAGE_STATE_OBSERVATION_ID, uniqueRows } from './controls.js';

/** The id of a page or shared surface's observation of what it shows: defined beside the rows it reports (`rowsOfControl`). */
export { PAGE_STATE_OBSERVATION_ID };
import { effectKind, type ActionEffectKind } from './effect.js';
import { isNarrowing, validateValue, type JsonSchema } from './json-schema.js';
import {
  LOCATION_OBSERVATION_ID,
  NAVIGATION_SURFACE_ID,
  routeMatcher,
  type ManifestAction,
  type GeneratedKnowledge,
  type ManifestSurface,
  type OuiManifest,
} from './manifest.js';
import { createKnowledgeLookup } from './lookup.js';
import { buildGates, scopeKey, scopeManifest, type GateFilter } from './scope.js';
import { factsByDisplay, type BindingRegistry, type ControlRegistration, type RoomRegistration } from './registry.js';
import type { JobOutcome } from '@ouispec/contract';
import { addressesRows, observationLookup, resolveInputRefs } from './readers.js';
import { navigationQueries, navigationTarget, sameAddress } from './query.js';
import { PROBLEMS_OBSERVATION_ID, type RoomResult } from './room.js';


/** Something the build and the running page disagree on. Reported once each; the conformance test keeps them from shipping. */
export type BindingDefect =
  | { kind: 'unknown-binding'; id: string }
  | { kind: 'widened-schema'; id: string }
  | { kind: 'unknown-room'; room: string };

export interface ConnectBindingsOptions {
  registry: BindingRegistry;
  /** The tab's surface runtime, in either form (oui-spec §7.3.8). */
  runtime: SurfaceRuntime<SurfaceForm>;
  manifest: OuiManifest;
  onDefect?: (defect: BindingDefect) => void;
  /**
   * Where job outcomes arrive, for controls whose binding declares a
   * `{ kind: 'job' }` effect. Without it such an action is reported as started
   * and never as done: nothing could confirm it.
   */
  jobs?: JobTracker;
  /**
   * The app's router, for the generated navigation surface: going to a page
   * by its address, and which page the person is on. Without it that surface
   * is not offered.
   */
  navigation?: AppNavigation;
  /**
   * This build's generated knowledge. With it, the runtime answers the
   * assistant's app-wide search and page guide (`oui.find`, `oui.guide`,
   * oui-spec §7.3.10) from this build's manifest and knowledge, the way to
   * each result starting at the page `navigation` says the person is on.
   */
  knowledge?: GeneratedKnowledge;
  /**
   * Which gates the session may see, for a build that serves several brands
   * or audiences (`routeGates` in `oui.config.json`): true for each gate its
   * person has (a brand's feature). The navigation surface then lists only
   * the pages open to them, and the app-wide search and page guide answer
   * only of those. Read at each rebuild and each lookup, so a change shows on
   * the next. Without it, every page. Pass the same predicate to
   * `resolveKnowledge` for the map the turn carries.
   */
  allows?: GateFilter;
}

/** How the app goes to a page, and tells which page it is on. */
export interface AppNavigation {
  navigate(path: string): void;
  /** The address of the page the person is on. */
  location(): string;
  /** Called with a listener for every change of location; returns how to stop. */
  subscribe(listener: () => void): () => void;
}

/** A job's end, as the assistant is told it: the contract's `JobOutcome` (`action-effect.json`). */
export type { JobOutcome } from '@ouispec/contract';

/**
 * The app's record of job outcomes (its completion events): `track` a job once
 * it is started, read its `outcome` when it has one, and `forget` it after.
 */
export interface JobTracker {
  track(jobId: string): void;
  outcome(jobId: string): JobOutcome | null;
  forget(jobId: string): void;
}

export { createDeclaredJobTracker } from './jobs.js';
export type { DeclaredJobTrackerOptions, JobEventSource, JobTrackerExtension } from './jobs.js';

/** How often a started job's outcome is read: a lookup, not a request. */
export const JOB_POLL_INTERVAL_MS = 1_000;
/** How long a job may take before its action is reported as not finished. */
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/**
 * The jobs this tab's bound controls started and whose outcome has not arrived.
 * A job is tracked the moment it starts, so an outcome that arrives before the
 * first poll is kept. Its action stays offered while it runs, even when its
 * control is disabled meanwhile (a Generate button is, while it generates):
 * the runtime follows a job only while its action is offered.
 */
interface JobRuns {
  tracker: JobTracker | undefined;
  started(bindingId: string, jobId: string, timeoutMs: number): void;
  ended(jobId: string): void;
  /** The control bound to `bindingId` was just used; if that disables it, it is busy, not gone. */
  pressed(bindingId: string): void;
  /** Whether the control bound to `bindingId` is disabled by its own last use (a Save button while it saves). */
  busy(bindingId: string): boolean;
}

/**
 * How long a control disabled by its own press is reported busy before it is
 * treated as simply unavailable: long enough for a save or a request, short
 * enough that a control that stays disabled does not stay offered.
 */
export const BUSY_AFTER_PRESS_MS = 60_000;

/** Keep the runtime's surfaces equal to what the manifest declares and the page has mounted. Returns a disconnect. */
export function connectBindings({
  registry,
  runtime,
  manifest,
  onDefect,
  jobs,
  navigation,
  knowledge,
  allows,
}: ConnectBindingsOptions): () => void {
  // What the build knows of itself, searched in the tab: one lookup, removed on disconnect.
  if (knowledge) {
    runtime.setLookup(
      createKnowledgeLookup({
        knowledge,
        manifest,
        ...(navigation ? { location: () => navigation.location() } : {}),
        ...(allows ? { allows } : {}),
      }),
    );
  }
  // The build as the session sees it (`allows`): its surfaces, less the pages it may not see, the controls that
  // only go to one and every word that names one; made again only when what it may see changes.
  const gates = buildGates(manifest.surfaces.filter(s => s.kind === 'page'));
  /** Every control the build declares: one the session is not offered is not a defect. */
  const declared = new Set(manifest.surfaces.flatMap(s => s.actions.filter(a => a.source === 'control').map(a => a.id)));
  let viewKey: string | null | undefined;
  let navigationSurface: ManifestSurface | undefined;
  let byBinding = new Map<string, { surface: ManifestSurface; action: ManifestAction }>();
  let roomSurfaces = new Map<string, ManifestSurface>();
  // What a page shows, by display id: the pages whose manifest entry records it (0.10 on).
  let byDisplay = new Map<string, ManifestSurface[]>();
  /** Reads what the session may see; true when it changed since the last reading. */
  const refreshView = (): boolean => {
    const key = scopeKey(gates, allows);
    if (key === viewKey) return false;
    const first = viewKey === undefined;
    viewKey = key;
    const seen = key === null ? manifest : scopeManifest(manifest, allows);
    navigationSurface = navigation ? seen.surfaces.find(s => s.id === NAVIGATION_SURFACE_ID && s.kind === 'navigation') : undefined;
    byBinding = new Map();
    roomSurfaces = new Map();
    byDisplay = new Map();
    for (const surface of seen.surfaces) {
      if (surface.kind === 'room') roomSurfaces.set(surface.id.replace(/^room:/, ''), surface);
      for (const action of surface.actions) {
        if (action.source === 'control') byBinding.set(action.id, { surface, action });
      }
      if (surface.kind !== 'page') continue;
      for (const display of surface.displays ?? []) byDisplay.set(display.id, [...(byDisplay.get(display.id) ?? []), surface]);
    }
    return !first;
  };
  refreshView();
  // Whether the last rebuild mounted a page for its controls, and which pages it mounted only for what they show.
  let pageOfControls = false;
  let showingKey = '';

  /**
   * The pages to mount only for what they show: when no page has a control
   * mounted (a page of figures, a Home whose cards gave way to a
   * conversation), the page whose manifest entry records a display that is
   * reporting its facts. Where several pages record it (a component they
   * share), the one at the address; with no address, only a display one page
   * records. A page with a control mounted already carries every display.
   */
  const showingPages = (): ManifestSurface[] => {
    if (pageOfControls || !byDisplay.size) return [];
    const path = navigation?.location().split(/[?#]/)[0];
    const pages = new Map<string, ManifestSurface>();
    for (const shown of registry.facts()) {
      const recorded = byDisplay.get(shown.id) ?? [];
      const here =
        path === undefined ? recorded : recorded.filter(s => s.routes.some(r => routeMatcher(r).test(path)));
      if (here.length === 1 || (path !== undefined && here.length > 1)) for (const s of here) pages.set(s.id, s);
    }
    return [...pages.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const keyOf = (pages: readonly ManifestSurface[]) => pages.map(s => s.id).join('\n');

  const reported = new Set<string>();
  const report = (defect: BindingDefect) => {
    const key = JSON.stringify(defect);
    if (reported.has(key)) return;
    reported.add(key);
    onDefect?.(defect);
  };

  const mounted = new Map<
    string,
    { fingerprint: string; handle: MountedSurface; surface: ManifestSurface }
  >();

  // Jobs in flight, by job id: the binding that started each, and when to stop
  // offering it if no outcome ever arrives (the runtime has then reported the
  // action as not finished).
  const inFlight = new Map<string, { bindingId: string; expiry: ReturnType<typeof setTimeout> }>();
  let connected = true;
  const runs: JobRuns = {
    tracker: jobs,
    started: (bindingId, jobId, timeoutMs) => {
      jobs?.track(jobId);
      if (inFlight.has(jobId)) return;
      const expiry = setTimeout(() => runs.ended(jobId), timeoutMs + JOB_POLL_INTERVAL_MS);
      inFlight.set(jobId, { bindingId, expiry });
    },
    pressed: () => {},
    busy: () => false,
    ended: jobId => {
      const run = inFlight.get(jobId);
      if (!run) return;
      clearTimeout(run.expiry);
      inFlight.delete(jobId);
      // After the runtime has settled the action on this outcome.
      queueMicrotask(() => {
        if (connected) rebuild();
      });
    },
  };
  const running = (bindingId: string) => [...inFlight.values()].some(r => r.bindingId === bindingId);

  // Controls a press has disabled for a moment (a Save button while it saves),
  // by binding id. Reported busy and still offered, not removed: the press
  // worked, and the control comes back when the work is done.
  const busyAfterPress = new Map<string, ReturnType<typeof setTimeout>>();
  const clearBusy = (bindingId: string) => {
    const timer = busyAfterPress.get(bindingId);
    if (timer === undefined) return;
    clearTimeout(timer);
    busyAfterPress.delete(bindingId);
  };
  runs.pressed = bindingId => {
    clearBusy(bindingId);
    busyAfterPress.set(
      bindingId,
      setTimeout(() => {
        busyAfterPress.delete(bindingId);
        if (connected) rebuild();
      }, BUSY_AFTER_PRESS_MS),
    );
  };
  runs.busy = bindingId => busyAfterPress.has(bindingId);

  const rebuild = () => {
    refreshView();
    const wanted = new Map<string, { surface: ManifestSurface; actions: ActionDefinition<null>[] }>();
    const want = (surface: ManifestSurface) => {
      let entry = wanted.get(surface.id);
      if (!entry) wanted.set(surface.id, (entry = { surface, actions: [] }));
      return entry;
    };

    // Controls, grouped by binding id in the order they mounted.
    const groups = new Map<string, ControlRegistration[]>();
    for (const reg of registry.controls()) {
      if (!byBinding.has(reg.id)) {
        // A control the build declares but the session is not offered (it only goes to a page it may not see) is no defect.
        if (!declared.has(reg.id)) report({ kind: 'unknown-binding', id: reg.id });
        continue;
      }
      const list = groups.get(reg.id) ?? [];
      list.push(reg);
      groups.set(reg.id, list);
    }
    for (const [id, regs] of groups) {
      const { surface, action } = byBinding.get(id)!;
      const entry = want(surface);
      const usable = regs.filter(r => !r.disabled);
      // Enabled again: whatever its last press started is done.
      if (usable.length > 0) clearBusy(id);
      // A disabled control is not offered, unless a job it started is still
      // running (its action must stay offered for the runtime to follow the job),
      // or its own press disabled it for a moment: it is busy, not gone.
      const offered = usable.length > 0 ? usable : running(id) || runs.busy(id) ? regs : [];
      if (offered.length === 0) continue;
      entry.actions.push(
        controlAction(action, offered, () => registry.controls().filter(r => r.id === id), report, runs),
      );
    }

    // A busy control that left the page is simply gone.
    for (const id of [...busyAfterPress.keys()]) if (!groups.has(id)) clearBusy(id);

    // What a page shows reaches the assistant with the page's state, also
    // while none of its controls is mounted: the page is mounted for its
    // displays, with no actions of its own.
    pageOfControls = [...wanted.values()].some(({ surface }) => surface.kind === 'page');
    const showing = showingPages();
    showingKey = keyOf(showing);
    for (const surface of showing) want(surface);

    // Going to a page by its address: offered whenever the app gives its router.
    if (navigationSurface && navigation) {
      const surface = navigationSurface;
      const entry = want(surface);
      for (const action of surface.actions) {
        entry.actions.push(navigateAction(action, surface.routes, navigation));
      }
    }

    // Rooms.
    for (const { registration } of registry.rooms()) {
      const surface = roomSurfaces.get(registration.catalog.room);
      if (!surface) {
        report({ kind: 'unknown-room', room: registration.catalog.room });
        continue;
      }
      const entry = want(surface);
      // What the room last reported: where a name given for an id is looked up.
      const reported = () => registry.rooms().find(r => r.registration === registration)?.observations ?? {};
      for (const action of surface.actions) {
        const def = roomAction(action, registration, runs, surface, reported);
        if (def) entry.actions.push(def);
      }
    }

    for (const [id, { surface, actions }] of wanted) {
      const fingerprint = JSON.stringify(actions.map(a => [a.id, a.input, a.async ?? false]));
      const current = mounted.get(id);
      if (current && current.fingerprint === fingerprint) continue;
      const defined = defineSurface<null>({
        id: surface.id,
        name: surface.title,
        description: surface.description,
        // The start the surface's whole catalog shares (oui-spec §7.3.8): the build's, not what shows now, so the
        // names an agent's index gives stay the same as controls show and hide.
        idPrefix: sharedIdPrefix(surface.actions.map(a => a.name)),
        actions,
        observations: surface.observations.map(o => ({
          id: o.id,
          description: o.description,
          schema: o.schema as never,
        })),
      });
      const handle = runtime.mount(defined, () => null);
      current?.handle.unmount();
      mounted.set(id, { fingerprint, handle, surface });
    }
    for (const [id, current] of mounted) {
      if (!wanted.has(id)) {
        current.handle.unmount();
        mounted.delete(id);
      }
    }
    pushObservations();
  };

  const pushObservations = () => {
    const controls = registry.controls();
    const problems = Object.values(registry.problems()).flat();
    const rooms = registry.rooms();
    const carriesProblems = (surface: ManifestSurface) => surface.observations.some(o => o.id === PROBLEMS_OBSERVATION_ID);
    // A page reports its problems with its own surface. When no page surface is
    // mounted to carry them (a route an access guard refused, a page that failed
    // before any of its controls mounted), the navigation surface does: it is
    // always there, so a problem that stops the page is never unseen.
    const pageCarries = [...mounted.values()].some(({ surface }) => surface.kind === 'page' && carriesProblems(surface));
    for (const { handle, surface } of mounted.values()) {
      if (surface.kind === 'room') {
        const room = rooms.find(r => `room:${r.registration.catalog.room}` === surface.id);
        if (!room) continue;
        for (const o of surface.observations) {
          if (o.id === PROBLEMS_OBSERVATION_ID) handle.pushObservation(o.id, room.problems);
          else if (o.id in room.observations) handle.pushObservation(o.id, room.observations[o.id]);
        }
        continue;
      }
      if (surface.kind === 'navigation') {
        if (navigation) handle.pushObservation(LOCATION_OBSERVATION_ID, { path: navigation.location() });
        if (carriesProblems(surface)) handle.pushObservation(PROBLEMS_OBSERVATION_ID, pageCarries ? [] : problems);
        continue;
      }
      const mine = controls.filter(c => byBinding.get(c.id)?.surface.id === surface.id);
      // What the page shows but is not a control: reported with the page, where the person reads it.
      const facts = surface.kind === 'page' ? factsByDisplay(registry.facts()) : [];
      handle.pushObservation(PAGE_STATE_OBSERVATION_ID, {
        ...pageState(mine, runs.busy),
        ...(facts.length ? { shown: facts } : {}),
      });
      if (surface.kind === 'page' && surface.observations.some(o => o.id === PROBLEMS_OBSERVATION_ID)) {
        handle.pushObservation(PROBLEMS_OBSERVATION_ID, problems);
      }
    }
  };

  // A display that starts or stops reporting can mount or unmount the page it is on.
  const unsubscribe = registry.subscribe(change =>
    change === 'structure' || refreshView() || keyOf(showingPages()) !== showingKey ? rebuild() : pushObservations(),
  );
  const unsubscribeLocation = navigationSurface && navigation
    ? navigation.subscribe(() => (refreshView() || keyOf(showingPages()) !== showingKey ? rebuild() : pushObservations()))
    : null;
  rebuild();

  return () => {
    connected = false;
    unsubscribe();
    unsubscribeLocation?.();
    for (const { expiry } of inFlight.values()) clearTimeout(expiry);
    inFlight.clear();
    for (const timer of busyAfterPress.values()) clearTimeout(timer);
    busyAfterPress.clear();
    for (const { handle } of mounted.values()) handle.unmount();
    mounted.clear();
    if (knowledge) runtime.setLookup(null);
  };
}

/** One row of a list, as the page state shows it. */
export interface PageStateRow {
  key: string;
  title: string;
  /** What the row is, when the page says (rows known only at run time). */
  description?: string;
  /**
   * The row's own value schema (its range, step or options), when the list's
   * rows do not all take the same one. A list's rows that do are described once,
   * by what their action takes (`ui_describe`).
   */
  schema?: JsonSchema;
  /** Its current value. */
  value?: unknown;
}

/**
 * A row's schema as the page state shows it: an enum longer than
 * `MAX_DESCRIBED_OPTIONS` keeps that many values, and the row's current value
 * if it is not among them, and says how many it leaves out. A language picker's
 * hundreds of options would otherwise fill the page state the assistant reads.
 * The row's tool still takes, and validates against, every value.
 */
export function summarisedSchema(schema: JsonSchema, value?: unknown): JsonSchema {
  const values = schema.enum;
  if (!values || values.length <= MAX_DESCRIBED_OPTIONS) return schema;
  const kept = values.slice(0, MAX_DESCRIBED_OPTIONS);
  const current = values.find(v => v === value);
  const shown = current !== undefined && !kept.includes(current) ? [...kept, current] : kept;
  return { ...schema, enum: shown, 'x-enum-omitted': values.length - shown.length };
}

/**
 * What a page surface shows: each field's value, each list's rows, what cannot
 * be used right now, and what is busy with its last press (a Save button while
 * it saves: it worked, and it comes back when done). A row that takes a value
 * carries its value, and its own schema when the list's rows differ, so rows
 * whose meanings are only known at run time (a model's parameters) are readable
 * without their definitions in the build. Rows that all take one schema leave it
 * to their action's definition, which offers exactly that schema: on a form with
 * a control per field per row, the same schema on row after row was three
 * quarters of the page state, and grew with the square of the form. Where the
 * definition is a declaration that does not list a live choice's options (a
 * room's, `declaredValue`), the page state says them once per control, under
 * `schemas`: before, an editor's choices made at run time (a line's
 * languages, a shot's points) reached the assistant nowhere, its definition
 * included.
 */
/** How a page state is reported (`pageState`). */
export interface PageStateOptions {
  /**
   * The value schema each control's action declares, by the control's id, where
   * that declaration is the action's definition rather than the control's live
   * schema: a room's actions, whose input is its catalog's (a page's own
   * controls offer their live schema). A control whose live value is a choice
   * the declaration does not list is then reported with its choices
   * (`schemas`), since nothing else says them.
   */
  declaredValue?: (controlId: string) => JsonSchema | null | undefined;
}

/** The choices a live value schema lists: its `enum`, or its items' for a choice of several. */
const choicesOf = (schema: JsonSchema | null | undefined): readonly unknown[] | undefined =>
  schema?.enum ?? schema?.items?.enum;

/**
 * A live value schema as the page state reports it beside its action's
 * declaration: its choices, summarised as a row's are (`summarisedSchema`),
 * when the live schema lists choices the declaration does not; else null.
 */
function undeclaredChoices(live: JsonSchema, declared: JsonSchema | null | undefined, value: unknown): JsonSchema | null {
  if (!choicesOf(live) || choicesOf(declared)) return null;
  if (live.enum) return summarisedSchema(live, value);
  return { ...live, items: summarisedSchema(live.items!) };
}

export function pageState(
  controls: readonly ControlRegistration[],
  isBusy: (bindingId: string) => boolean = () => false,
  options: PageStateOptions = {},
) {
  const values: Record<string, unknown> = {};
  const lists: Record<string, PageStateRow[]> = {};
  // A control's choices known only now, once per control: what its action's declaration does not list.
  const schemas: Record<string, JsonSchema> = {};
  const declared = options.declaredValue;
  const unavailable: string[] = [];
  const busy: string[] = [];
  // Whether each list's rows differ in what they take, as an action decides what it offers (`controlAction`).
  const rowSchemas = new Map<string, Set<string>>();
  for (const c of controls) {
    if (!c.item) continue;
    const seen = rowSchemas.get(c.id) ?? new Set<string>();
    seen.add(JSON.stringify(c.valueSchema));
    rowSchemas.set(c.id, seen);
  }
  // Each list's rows by key: a record drawn twice on the page (the same key in two places) is one row, as first drawn.
  const listed = new Map<string, Set<string>>();
  for (const c of controls) {
    if (c.item) {
      const keys = listed.get(c.id) ?? new Set<string>();
      listed.set(c.id, keys);
      if (keys.has(c.item.key)) continue;
      keys.add(c.item.key);
      const ownSchema = c.valueSchema && rowSchemas.get(c.id)!.size > 1;
      // Rows that share one schema: said once, when the action's declaration does not say it.
      if (declared && c.valueSchema && !ownSchema && !(c.id in schemas)) {
        const choices = undeclaredChoices(c.valueSchema, declared(c.id), c.value);
        if (choices) schemas[c.id] = choices;
      }
      (lists[c.id] ??= []).push({
        key: c.item.key,
        title: c.item.title,
        ...(c.item.description ? { description: c.item.description } : {}),
        ...(ownSchema ? { schema: summarisedSchema(c.valueSchema!, c.value) } : {}),
        ...(c.value !== undefined ? { value: c.value } : {}),
      });
    } else {
      if (c.value !== undefined) values[c.id] = c.value;
      if (declared && c.valueSchema && !(c.id in schemas)) {
        const choices = undeclaredChoices(c.valueSchema, declared(c.id), c.value);
        if (choices) schemas[c.id] = choices;
      }
    }
    if (c.disabled && !c.item) (isBusy(c.id) ? busy : unavailable).push(c.id);
  }
  return {
    values,
    lists,
    unavailable,
    ...(busy.length ? { busy } : {}),
    ...(Object.keys(schemas).length ? { schemas } : {}),
  };
}

function controlAction(
  action: ManifestAction,
  regs: readonly ControlRegistration[],
  current: () => readonly ControlRegistration[],
  report: (d: BindingDefect) => void,
  runs: JobRuns,
): ActionDefinition<null> {
  const job = settlement(action);
  const timeoutMs = job?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const declaredValue = action.input.properties?.value ?? null;
  // Each row's live schema must narrow the declared one. The tool offers the
  // rows' common schema; when rows differ (one chip group per category, each
  // with its own options) it offers the declared one, and each row is
  // validated against its own when the action runs.
  const liveSchemas = regs.map(r => r.valueSchema);
  for (const live of liveSchemas) {
    if (declaredValue && live && !isNarrowing(live, declaredValue))
      report({ kind: 'widened-schema', id: action.id });
  }
  const shared = liveSchemas.every(l => JSON.stringify(l) === JSON.stringify(liveSchemas[0]));
  const toolValue: JsonSchema | null =
    declaredValue && shared && liveSchemas[0] && isNarrowing(liveSchemas[0], declaredValue)
      ? liveSchemas[0]
      : declaredValue;
  const rowValue = (reg: ControlRegistration): JsonSchema | null =>
    declaredValue && reg.valueSchema && isNarrowing(reg.valueSchema, declaredValue)
      ? reg.valueSchema
      : declaredValue;
  const items = action.itemized ? regs.filter(r => r.item).map(r => r.item!) : undefined;
  const input: JsonSchema = action.control
    ? {
        ...deriveInputSchema(action.control, {}, { itemized: action.itemized, items, list: action.id }),
        properties: {
          ...(toolValue ? { value: toolValue } : {}),
          ...(action.itemized ? { [ITEM_PROPERTY]: itemSchema(items, action.id) } : {}),
        },
      }
    : action.input;

  return {
    id: action.name,
    description: action.description,
    input: input as never,
    ...declared(action),
    confirm: action.destructive || action.confirm || undefined,
    ...settlingDefinition(job, timeoutMs, runs),
    handler: async (params): Promise<ActionHandlerResult> => {
      // Read the registrations when the action runs: the row may have scrolled
      // away or the control unmounted since the tools were offered.
      const now = current();
      if (now.length === 0) {
        return fail(
          'NOT_ON_SCREEN',
          `"${action.title}" is no longer on the page; read the page state for what it offers now`,
        );
      }
      const reg = pickRegistration(action, params, now);
      if ('error' in reg) return reg.error;
      if (reg.registration.disabled) {
        return runs.busy(action.id)
          ? fail('BUSY', `"${reg.registration.title}" is still busy with its last use; it is offered again when that is done`)
          : fail('UNAVAILABLE', `"${reg.registration.title}" cannot be used right now`);
      }
      const valueSchema = rowValue(reg.registration);
      if (valueSchema) {
        const problem = validateValue(valueSchema, params.value);
        if (problem) return fail('INVALID_VALUE', `${reg.registration.title}: ${problem}`);
      }
      const result = await reg.registration.run({ value: params.value });
      // A press that started a job is followed through the job; any other that
      // disables its control leaves it busy, not gone.
      if (result.ok && !(job && result.pending)) runs.pressed(action.id);
      return job ? settlingResult(action.id, result, timeoutMs, runs) : toHandlerResult(result);
    },
  };
}

/**
 * How an action whose work outlives the call settles, when it declares so:
 * a `job`, and a `transaction` (modelled on it).
 */
function settlement(action: ManifestAction): { estimatedDuration?: string; timeoutMs?: number } | null {
  const effect = action.effect;
  return effect && typeof effect === 'object' && (effect.kind === 'job' || effect.kind === 'transaction')
    ? effect
    : null;
}

/** An action that settles on its job's outcome is asynchronous, polled until the outcome arrives. */
function settlingDefinition(
  job: { estimatedDuration?: string } | null,
  timeoutMs: number,
  runs: JobRuns,
): Pick<ActionDefinition<null>, 'async' | 'estimatedDuration' | 'polling'> {
  if (!job) return {};
  return {
    async: true,
    ...(job.estimatedDuration ? { estimatedDuration: job.estimatedDuration } : {}),
    polling: jobPolling(timeoutMs, runs),
  };
}

/** Started, not done: the runtime settles the action on the job's outcome. */
function settlingResult(actionId: string, result: RoomResult, timeoutMs: number, runs: JobRuns): ActionHandlerResult {
  if (!result.ok) return toHandlerResult(result);
  // Tracked now, not at the first poll, so an outcome that arrives first is kept.
  if (result.pending && runs.tracker) runs.started(actionId, result.pending.jobId, timeoutMs);
  return startedAnswer(result);
}

/**
 * The first answer of an action that settles on a job (`job`, `transaction`):
 * `started`, with the job's id when the handler gave one (`pending`), beside
 * what the handler returned, so the assistant knows what it started while the
 * work runs (a capture's address and the links it found, say). `status` and
 * `jobId` are the settlement's own (`JobSettlement`) and win over a field of
 * the same name. A failure is answered as any action's is.
 *
 * Exported for a host that builds such an action itself, as an eval's
 * scripted page does, so it answers exactly as a bound one.
 */
export function startedAnswer(result: RoomResult): ActionHandlerResult {
  if (!result.ok) return toHandlerResult(result);
  return {
    success: true,
    data: {
      ...result.data,
      ...(result.changed?.length ? { changed: result.changed } : {}),
      status: 'started',
      ...(result.pending ? { jobId: result.pending.jobId } : {}),
    },
  };
}

/**
 * What the action is called and what it does, as the browser and the agent
 * runtime read them: a `transaction`, and a destructive write, run only on the
 * person's approval of the exact request, which OUI's runtime checks before
 * any handler here runs.
 */
function declared(action: ManifestAction): { title: string; effect?: ActionEffectKind } {
  return { title: action.title, ...(action.effect ? { effect: effectKind(action.effect) } : {}) };
}

/** The polling for a bound action's job: the tab's tracker, and the control offered again once the job ends. */
function jobPolling(timeoutMs: number, runs: JobRuns): NonNullable<ActionDefinition<null>['polling']> {
  return jobOutcomePolling(runs.tracker, timeoutMs, runs.ended);
}

/**
 * The runtime's polling for a job: done when the job's outcome arrives, as the
 * outcome says; still running until then; and, past `timeoutMs`, reported by
 * the runtime as not finished (a failure, never a success). With no tracker,
 * or no job id in the first answer, the work is reported `unverified`.
 * `onEnded` is told of each job once its outcome has been read.
 *
 * Exported for a host that builds an action settling on a job itself, as an
 * eval's scripted page does, so its outcome reaches the assistant exactly as
 * a bound action's does.
 */
export function jobOutcomePolling(
  jobs: JobTracker | undefined,
  timeoutMs: number = DEFAULT_JOB_TIMEOUT_MS,
  onEnded?: (jobId: string) => void,
): NonNullable<ActionDefinition<null>['polling']> {
  return {
    intervalMs: JOB_POLL_INTERVAL_MS,
    maxDurationMs: timeoutMs,
    resolve: async dispatchResult => {
      const jobId = (dispatchResult as { jobId?: unknown } | null | undefined)?.jobId;
      if (typeof jobId !== 'string' || !jobId || !jobs) {
        return {
          done: true,
          data: {
            status: 'unverified',
            message:
              'The work was started, but its completion cannot be observed from the page (no job id to follow), ' +
              'so it is not known to be done. Check what the page shows before saying it is.',
          },
        };
      }
      jobs.track(jobId);
      const outcome = jobs.outcome(jobId);
      if (!outcome) return { done: false, data: { status: 'running', jobId } };
      jobs.forget(jobId);
      onEnded?.(jobId);
      // A failed job ends its action as a failure, with the declared reason: the
      // assistant's record of the call, and anyone reading the chat later, see
      // that it failed (verify-after-act reads that record).
      if (outcome.status === 'failed') {
        return { done: true, data: outcome, error: { code: 'JOB_FAILED', message: outcome.error } };
      }
      return { done: true, data: outcome };
    },
  };
}

function pickRegistration(
  action: ManifestAction,
  params: Record<string, unknown>,
  regs: readonly ControlRegistration[],
): { registration: ControlRegistration } | { error: ActionHandlerResult } {
  if (!action.itemized) return { registration: regs[regs.length - 1] };
  const ref = typeof params[ITEM_PROPERTY] === 'string' ? (params[ITEM_PROPERTY] as string) : '';
  // A record drawn twice runs through a drawing that can be used, when one can.
  const drawing = (key: string) => regs.find(r => r.item?.key === key && !r.disabled) ?? regs.find(r => r.item?.key === key);
  const byKey = drawing(ref);
  if (byKey) return { registration: byKey };
  // A record drawn twice is one row: its title names it once.
  const rows = uniqueRows(regs.filter(r => r.item).map(r => ({ key: r.item!.key, registration: r })));
  const byTitle = rows.filter(r => r.registration.item!.title.toLowerCase() === ref.trim().toLowerCase()).map(r => r.registration);
  if (byTitle.length === 1) return { registration: drawing(byTitle[0].item!.key)! };
  const shown = rows
    .map(r => r.registration)
    .slice(0, 30)
    .map(r => `"${r.item?.title}" (${r.item?.key})`)
    .join(', ');
  return {
    error: fail(
      byTitle.length > 1 ? 'AMBIGUOUS_ITEM' : 'ITEM_NOT_FOUND',
      byTitle.length > 1
        ? `Several rows are called "${ref}"; give the id instead: ${shown}`
        : `No row "${ref}" is on screen for ${action.title}. On screen: ${shown}`,
    ),
  };
}

function roomAction(
  action: ManifestAction,
  registration: RoomRegistration,
  runs: JobRuns,
  surface: ManifestSurface,
  reported: () => Readonly<Record<string, unknown>>,
): ActionDefinition<null> | null {
  if (action.source !== 'room-action') return null;
  const entryId = action.id.split('/').pop()!;
  const entry = registration.catalog.actions.find(a => a.id === entryId);
  if (!entry) return null;
  const job = settlement(action);
  const timeoutMs = job?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const addresses = addressesRows(action.input);
  return {
    id: action.name,
    description: action.description,
    input: action.input as never,
    ...declared(action),
    confirm: entry.destructive || undefined,
    ...settlingDefinition(job, timeoutMs, runs),
    handler: async params => {
      try {
        // A name given where a row's id is taken is the row's id, when one row
        // has it.
        const resolved = addresses
          ? resolveInputRefs(action.input, params, observationLookup(surface.observations, reported()))
          : { input: params };
        if ('error' in resolved) return toHandlerResult(resolved.error);
        const result = await registration.run(entry.id, resolved.input as Record<string, unknown>);
        return job ? settlingResult(action.id, result, timeoutMs, runs) : toHandlerResult(result);
      } catch (err) {
        return fail('FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * Going to a page: the address is built from the path, the route's
 * `:parameters` and the query, each part encoded, and must be one of the
 * build's routes inside the app, so an invented or outside address is refused
 * rather than landing on the router's fallback. A query the page declares is
 * checked against its declaration (`navigationTarget`). Going where the person
 * already is changes nothing, and says so, so a repeated call never navigates
 * twice.
 */
function navigateAction(
  action: ManifestAction,
  routes: readonly string[],
  navigation: AppNavigation,
): ActionDefinition<null> {
  const queries = navigationQueries(action.input);
  return {
    id: action.name,
    description: action.description,
    input: action.input as never,
    ...declared(action),
    handler: async params => {
      const target = navigationTarget(params, routes, queries);
      if (!target.ok) return fail(target.code, target.message);
      if (sameAddress(navigation.location(), target.address)) {
        return { success: true, data: { navigatedTo: target.address, alreadyThere: true } };
      }
      navigation.navigate(target.address);
      return { success: true, data: { navigatedTo: target.address } };
    },
  };
}

function fail(code: string, message: string): ActionHandlerResult {
  return { success: false, error: { code, message } };
}

function toHandlerResult(result: RoomResult): ActionHandlerResult {
  if (!result.ok) return fail(result.code, result.message);
  // Work that outlives the call is started, not done: say so, so it is never reported finished.
  const started = result.pending ? { ...result.data, status: 'started', jobId: result.pending.jobId } : result.data;
  // What it changed, as it is now: what the assistant checks its edit against.
  const data = result.changed?.length ? { ...started, changed: result.changed } : started;
  return { success: true, ...(data ? { data } : {}) };
}
