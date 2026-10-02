/**
 * The tab's OUI surfaces, built from the build's generated manifest and what
 * is mounted right now (ADR-0220 §2.2, ADR-0209).
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
  type SurfaceRuntime,
} from 'oui-spec/core';

import { deriveInputSchema, ITEM_PROPERTY, itemSchema, MAX_DESCRIBED_OPTIONS } from './controls.js';
import { effectKind, type ActionEffectKind } from './effect.js';
import { isNarrowing, validateValue, type JsonSchema } from './json-schema.js';
import {
  isRoutePath,
  LOCATION_OBSERVATION_ID,
  NAVIGATION_SURFACE_ID,
  type ManifestAction,
  type ManifestSurface,
  type OuiManifest,
} from './manifest.js';
import type { BindingRegistry, ControlRegistration, RoomRegistration } from './registry.js';
import type { JobOutcome } from '@ouispec/contract';
import { PROBLEMS_OBSERVATION_ID, type RoomResult } from './room.js';

/** The id of a page or shared surface's observation of what it shows. */
export const PAGE_STATE_OBSERVATION_ID = 'state';

/** Something the build and the running page disagree on. Reported once each; the conformance test keeps them from shipping. */
export type BindingDefect =
  | { kind: 'unknown-binding'; id: string }
  | { kind: 'widened-schema'; id: string }
  | { kind: 'unknown-room'; room: string };

export interface ConnectBindingsOptions {
  registry: BindingRegistry;
  runtime: SurfaceRuntime;
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
}: ConnectBindingsOptions): () => void {
  const navigationSurface = navigation
    ? manifest.surfaces.find(s => s.id === NAVIGATION_SURFACE_ID && s.kind === 'navigation')
    : undefined;
  const byBinding = new Map<string, { surface: ManifestSurface; action: ManifestAction }>();
  const roomSurfaces = new Map<string, ManifestSurface>();
  for (const surface of manifest.surfaces) {
    if (surface.kind === 'room') roomSurfaces.set(surface.id.replace(/^room:/, ''), surface);
    for (const action of surface.actions) {
      if (action.source === 'control') byBinding.set(action.id, { surface, action });
    }
  }

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
        report({ kind: 'unknown-binding', id: reg.id });
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

    // Going to a page by its address: offered whenever the app gives its router.
    if (navigationSurface && navigation) {
      const entry = want(navigationSurface);
      for (const action of navigationSurface.actions) {
        entry.actions.push(navigateAction(action, navigationSurface.routes, navigation));
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
      for (const action of surface.actions) {
        const def = roomAction(action, registration, runs);
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
      const facts = surface.kind === 'page' ? registry.facts() : [];
      handle.pushObservation(PAGE_STATE_OBSERVATION_ID, {
        ...pageState(mine, runs.busy),
        ...(facts.length ? { shown: facts } : {}),
      });
      if (surface.kind === 'page' && surface.observations.some(o => o.id === PROBLEMS_OBSERVATION_ID)) {
        handle.pushObservation(PROBLEMS_OBSERVATION_ID, problems);
      }
    }
  };

  const unsubscribe = registry.subscribe(change => (change === 'structure' ? rebuild() : pushObservations()));
  const unsubscribeLocation = navigationSurface && navigation ? navigation.subscribe(() => pushObservations()) : null;
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
  };
}

/** One row of a list, as the page state shows it. */
export interface PageStateRow {
  key: string;
  title: string;
  /** What the row is, when the page says (rows known only at run time). */
  description?: string;
  /** The row's own value schema (its range, step or options), when it takes a value. */
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
 * carries its own schema and value, so rows whose meanings are only known at
 * run time (a model's parameters) are readable without their definitions in the
 * build.
 */
export function pageState(controls: readonly ControlRegistration[], isBusy: (bindingId: string) => boolean = () => false) {
  const values: Record<string, unknown> = {};
  const lists: Record<string, PageStateRow[]> = {};
  const unavailable: string[] = [];
  const busy: string[] = [];
  for (const c of controls) {
    if (c.item) {
      (lists[c.id] ??= []).push({
        key: c.item.key,
        title: c.item.title,
        ...(c.item.description ? { description: c.item.description } : {}),
        ...(c.valueSchema ? { schema: summarisedSchema(c.valueSchema, c.value) } : {}),
        ...(c.value !== undefined ? { value: c.value } : {}),
      });
    } else if (c.value !== undefined) {
      values[c.id] = c.value;
    }
    if (c.disabled && !c.item) (isBusy(c.id) ? busy : unavailable).push(c.id);
  }
  return { values, lists, unavailable, ...(busy.length ? { busy } : {}) };
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
        ...deriveInputSchema(action.control, {}, { itemized: action.itemized, items }),
        properties: {
          ...(toolValue ? { value: toolValue } : {}),
          ...(action.itemized ? { [ITEM_PROPERTY]: itemSchema(items) } : {}),
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
 * a `job`, and a `transaction` (modelled on it, ADR-0226 §2.6).
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
  return { success: true, data: { status: 'started', ...(result.pending ? { jobId: result.pending.jobId } : {}) } };
}

/**
 * What the action is called and what it does, as the browser and the agent
 * runtime read them: a `transaction`, and a destructive write, run only on the
 * person's approval of the exact request, which OUI's runtime checks before
 * any handler here runs (ADR-0228).
 */
function declared(action: ManifestAction): { title: string; effect?: ActionEffectKind } {
  return { title: action.title, ...(action.effect ? { effect: effectKind(action.effect) } : {}) };
}

/**
 * The runtime's polling for a job: done when the job's outcome arrives, as the
 * outcome says; still running until then; and, past `timeoutMs`, reported by
 * the runtime as not finished (a failure, never a success).
 */
function jobPolling(timeoutMs: number, runs: JobRuns): NonNullable<ActionDefinition<null>['polling']> {
  const jobs = runs.tracker;
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
      runs.ended(jobId);
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
  const byKey = regs.find(r => r.item?.key === ref);
  if (byKey) return { registration: byKey };
  const byTitle = regs.filter(r => r.item && r.item.title.toLowerCase() === ref.trim().toLowerCase());
  if (byTitle.length === 1) return { registration: byTitle[0] };
  const shown = regs
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
): ActionDefinition<null> | null {
  if (action.source !== 'room-action') return null;
  const entryId = action.id.split('/').pop()!;
  const entry = registration.catalog.actions.find(a => a.id === entryId);
  if (!entry) return null;
  const job = settlement(action);
  const timeoutMs = job?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  return {
    id: action.name,
    description: action.description,
    input: action.input as never,
    ...declared(action),
    confirm: entry.destructive || undefined,
    ...settlingDefinition(job, timeoutMs, runs),
    handler: async params => {
      try {
        const result = await registration.run(entry.id, params);
        return job ? settlingResult(action.id, result, timeoutMs, runs) : toHandlerResult(result);
      } catch (err) {
        return fail('FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * Going to a page: the path must be one of the build's routes, with an id in
 * place of each `:param`, so an invented address is refused rather than
 * landing on the router's fallback.
 */
function navigateAction(
  action: ManifestAction,
  routes: readonly string[],
  navigation: AppNavigation,
): ActionDefinition<null> {
  return {
    id: action.name,
    description: action.description,
    input: action.input as never,
    ...declared(action),
    handler: async params => {
      const path = typeof params.path === 'string' ? params.path.trim() : '';
      if (!path.startsWith('/')) return fail('INVALID_PATH', 'A page’s address starts with /');
      if (!isRoutePath(routes, path)) {
        return fail('UNKNOWN_ROUTE', `${path} is not a page of this app: the pages are ${routes.join(', ')}`);
      }
      navigation.navigate(path);
      return { success: true, data: { navigatedTo: path } };
    },
  };
}

function fail(code: string, message: string): ActionHandlerResult {
  return { success: false, error: { code, message } };
}

function toHandlerResult(result: RoomResult): ActionHandlerResult {
  if (!result.ok) return fail(result.code, result.message);
  // Work that outlives the call is started, not done: say so, so it is never reported finished.
  const data = result.pending ? { ...result.data, status: 'started', jobId: result.pending.jobId } : result.data;
  return { success: true, ...(data ? { data } : {}) };
}
