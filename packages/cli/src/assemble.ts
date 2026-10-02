/**
 * The build's surfaces (ADR-0220 §2.4): one per page, one per component shared
 * between pages, one per room, each with its actions, their reach paths and
 * the page's observations — validated as it is put together.
 */

import {
  bindingIdProblem,
  controlVerb,
  deriveInputSchema,
  effectProblem,
  LOCATION_OBSERVATION_ID,
  MAX_TOOL_NAME_LENGTH,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  PROBLEMS_OBSERVATION_ID,
  PROBLEMS_SCHEMA,
  problemsSchema,
  ROOM_RUN_COMMAND_ID,
  ROOM_SET_PROPERTIES_ID,
  routeMatcher,
  toolInputProblems,
  toolName,
  type ActionEffect,
  type JsonSchema,
  type ManifestAction,
  type ManifestObservation,
  type ManifestSurface,
  type ReachStep,
  type RoomCatalogData,
} from '@ouispec/bindings';

import {
  navigateTargets,
  type DialogStep,
  type Finding,
  type FoundControl,
  type PageAnalysis,
} from './analyze.js';
import type { ApiOperation, ApiOperations, LoadedCatalog, NavEntry, RouteEntry } from './inputs.js';
import { humanizeId } from './program.js';
import { recipeProblems, roomToolName } from './recipes.js';

export interface PageInput {
  component: string;
  routes: RouteEntry[];
  analysis: PageAnalysis | null;
  /** The app's frame (a `shell` entry), mounted around the pages rather than by a route. */
  frame?: boolean;
}

export interface Assembled {
  surfaces: ManifestSurface[];
  /** Per page surface: its routes, nav place, header and the rooms on it. */
  pages: PageMeta[];
  /** The same for each part of the app's frame, which is on every page it frames. */
  frames: PageMeta[];
  errors: Finding[];
}

export interface PageMeta {
  surface: string;
  component: string;
  routes: string[];
  title: string;
  description: string;
  nav: string | null;
  rooms: string[];
  /** Surfaces of components shared with other pages that this page renders. */
  shared: string[];
  /** Where each shared action is on this page, by tool name: the same control can sit behind different tabs and openers on different pages. */
  sharedReach: Record<string, ReachStep[]>;
  /** What the page shows that is not a control, and where. */
  shown: { id: string; title: string; description: string; labels: string[]; reach: ReachStep[] }[];
}

const PAGE_STATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    values: { type: 'object', description: "Each field's current value, by binding id" },
    lists: {
      type: 'object',
      description: 'The rows each list-row control is showing, by binding id: their ids (keys) and titles',
    },
    unavailable: {
      type: 'array',
      items: { type: 'string' },
      description: 'Controls that cannot be used right now',
    },
    shown: {
      type: 'array',
      description:
        'What the page shows that is not a control, by display: its binding id, heading and facts, each as text by its label',
    },
  },
};

export function assemble(
  pages: readonly PageInput[],
  nav: readonly NavEntry[],
  api: ApiOperations,
  allRoutes: readonly RouteEntry[],
  unboundAllowed: ReadonlySet<string>,
): Assembled {
  const errors: Finding[] = [];
  const navFor = (route: string) => nav.find(n => n.route === route);

  // Each binding site, and the pages it is on.
  const sites = new Map<string, { control: FoundControl; pages: Set<string> }>();
  const reachOnPage = new Map<string, Map<string, (ReachStep | DialogStep)[]>>();
  for (const page of pages) {
    for (const c of page.analysis?.controls ?? []) {
      const entry = sites.get(c.site) ?? { control: c, pages: new Set<string>() };
      entry.pages.add(page.component);
      sites.set(c.site, entry);
      const byPage = reachOnPage.get(c.site) ?? new Map<string, (ReachStep | DialogStep)[]>();
      if (!byPage.has(page.component)) byPage.set(page.component, c.reach);
      reachOnPage.set(c.site, byPage);
    }
  }

  // Binding ids are unique across the build, displays' too.
  const byId = new Map<string, string[]>();
  for (const [site, { control }] of sites)
    byId.set(control.binding.id, [...(byId.get(control.binding.id) ?? []), site]);
  const displaySites = new Map<string, string>();
  for (const page of pages) for (const d of page.analysis?.displays ?? []) displaySites.set(d.site, d.binding.id);
  for (const [site, id] of displaySites) byId.set(id, [...(byId.get(id) ?? []), site]);
  for (const [id, where] of byId) {
    if (where.length > 1) {
      const [file, line] = where[0].split(':');
      errors.push({
        file,
        line: Number(line) || 0,
        message: `Binding id "${id}" is declared in ${where.length} places: ${where.join(', ')}`,
      });
    }
  }

  const routesOf = (component: string) =>
    pages.find(p => p.component === component)?.routes.map(r => r.path) ?? [];
  const pageTitle = (page: PageInput) => {
    const fromNav = page.routes.map(r => navFor(r.path)?.label).find(Boolean);
    return fromNav ?? page.analysis?.header.title ?? words(page.component);
  };

  // Surfaces of controls.
  const controlSurfaces = new Map<
    string,
    { kind: 'page' | 'shared' | 'shell'; title: string; routes: Set<string>; actions: ManifestAction[] }
  >();
  const dialogBindings = new Set<string>();
  const tabBindings = new Set<string>();
  for (const page of pages) {
    for (const d of page.analysis?.dialogs ?? []) if (d.binding) dialogBindings.add(d.binding);
    for (const c of page.analysis?.controls ?? []) if (c.kind === 'tabs') tabBindings.add(c.binding.id);
  }

  const sortedSites = [...sites.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, { control, pages: on }] of sortedSites) {
    const shared = on.size > 1;
    const firstPage = pages.find(p => on.has(p.component))!;
    const own = firstPage.frame ? 'shell' : 'page';
    const surfaceId = shared ? `shared:${control.component}` : `${own}:${firstPage.component}`;
    const surface = controlSurfaces.get(surfaceId) ?? {
      kind: shared ? ('shared' as const) : own,
      title: shared ? words(control.component) : pageTitle(firstPage),
      routes: new Set<string>(),
      actions: [],
    };
    for (const p of on) routesOf(p).forEach(r => surface.routes.add(r));
    const action = controlAction(
      control,
      firstPage,
      pageTitle(firstPage),
      navFor,
      api,
      allRoutes,
      dialogBindings,
      tabBindings,
      errors,
    );
    if (action) surface.actions.push(action);
    controlSurfaces.set(surfaceId, surface);
  }

  // Unbound controls, where bindings are enforced; and the allowance may only shrink.
  for (const page of pages) {
    const unbound = page.analysis?.unbound ?? [];
    if (unboundAllowed.has(page.component)) {
      if (unbound.length === 0 && page.analysis) {
        errors.push({
          file: 'oui.config.json',
          line: 0,
          message: `${page.component} has every control bound: remove it from "unbound"`,
        });
      }
      continue;
    }
    for (const u of unbound)
      errors.push({ ...u, message: `${u.message} (on ${page.component}, whose bindings are enforced)` });
  }
  for (const page of pages) {
    for (const e of page.analysis?.errors ?? []) errors.push(e);
    if (!page.analysis) {
      errors.push({
        file: 'routes',
        line: 0,
        message: `Could not find the component ${page.component} renders for ${page.routes.map(r => r.path).join(', ')}`,
      });
    }
  }
  const uniqueErrors = dedupe(errors);

  // Surfaces, in a stable order.
  const surfaces: ManifestSurface[] = [];
  const metas: PageMeta[] = [];
  const frames: PageMeta[] = [];
  for (const page of [...pages].sort((a, b) => a.component.localeCompare(b.component))) {
    const kind = page.frame ? 'shell' : 'page';
    const id = `${kind}:${page.component}`;
    const found = controlSurfaces.get(id);
    const description = pageDescription(page, pageTitle(page));
    const observations: ManifestObservation[] = [
      { id: 'state', description: stateDescription(found?.actions ?? []), schema: PAGE_STATE_SCHEMA },
      { id: PROBLEMS_OBSERVATION_ID, description: PROBLEMS_SCHEMA.description!, schema: PROBLEMS_SCHEMA },
    ];
    surfaces.push({
      id,
      kind,
      title: pageTitle(page),
      description,
      routes: page.routes.map(r => r.path),
      actions: sortActions(found?.actions ?? []),
      observations,
    });
    const navEntry = page.routes.map(r => navFor(r.path)).find(Boolean);
    (page.frame ? frames : metas).push({
      surface: id,
      component: page.component,
      routes: page.routes.map(r => r.path),
      title: pageTitle(page),
      description,
      nav: navEntry ? [navEntry.group, navEntry.label].filter(Boolean).join(' › ') : null,
      rooms: [...(page.analysis?.rooms ?? [])].map(r => `room:${r.catalog.room}`).sort(),
      shown: (page.analysis?.displays ?? [])
        .map(d => ({
          id: d.binding.id,
          title: d.title || humanizeId(d.binding.id),
          description: d.binding.description,
          labels: d.labels,
          reach: d.reach.map(cleanStep),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      shared: [...controlSurfaces.entries()]
        .filter(
          ([sid, s]) => s.kind === 'shared' && page.routes.some(r => s.routes.has(r.path)) && sid !== id,
        )
        .map(([sid]) => sid)
        .sort(),
      sharedReach: Object.fromEntries(
        [...sites.values()]
          .filter(({ pages: on }) => on.size > 1 && on.has(page.component))
          .map(({ control }): [string, ReachStep[]] => {
            const own = reachOnPage.get(control.site)?.get(page.component) ?? control.reach;
            const route = page.routes[0]?.path ?? '';
            const navEntry = navFor(route);
            const routeStep: ReachStep = {
              kind: 'route',
              path: route,
              title: pageTitle(page),
              ...(navEntry ? { nav: [navEntry.group, navEntry.label].filter(Boolean).join(' › ') } : {}),
            };
            return [toolName(control.binding.id), [routeStep, ...own.map(cleanStep)]];
          })
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    });
  }
  for (const [id, s] of [...controlSurfaces.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (s.kind !== 'shared') continue;
    surfaces.push({
      id,
      kind: 'shared',
      title: s.title,
      description: `${s.title}, on ${[...s.routes].sort().join(', ')}.`,
      routes: [...s.routes].sort(),
      actions: sortActions(s.actions),
      observations: [{ id: 'state', description: stateDescription(s.actions), schema: PAGE_STATE_SCHEMA }],
    });
  }

  // Rooms.
  const rooms = new Map<string, { catalog: LoadedCatalog; routes: Set<string> }>();
  for (const page of pages) {
    for (const room of page.analysis?.rooms ?? []) {
      const entry = rooms.get(room.catalog.room) ?? { catalog: room, routes: new Set<string>() };
      page.routes.forEach(r => entry.routes.add(r.path));
      rooms.set(room.catalog.room, entry);
    }
  }
  for (const [, { catalog, routes }] of [...rooms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    surfaces.push(roomSurface(catalog.catalog, [...routes].sort(), api.operations));
    uniqueErrors.push(...catalogProblems(catalog, { api, allRoutes }));
  }

  // Going to a page by its address, from the routes themselves.
  surfaces.push(
    navigationSurface(
      pages
        .filter(p => !p.frame)
        .flatMap(p => p.routes.map(r => ({ path: r.path, title: pageTitle(p) })))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  );

  // Tool names are unique across the build.
  const names = new Map<string, string>();
  for (const s of surfaces) {
    for (const a of s.actions) {
      const other = names.get(a.name);
      if (other)
        uniqueErrors.push({
          file: a.declaredIn ?? s.id,
          line: 0,
          message: `Tool name "${a.name}" is used by ${other} and ${a.id}`,
        });
      names.set(a.name, a.id);
    }
  }

  // Every tool's input is one object schema, whatever declared it: a page's
  // binding, a room's catalog, an app's catalog or a generated action. One that
  // is not makes the provider refuse every turn the surface is offered in.
  for (const s of surfaces) {
    for (const a of s.actions) {
      for (const problem of toolInputProblems(a.input)) {
        uniqueErrors.push({ file: a.declaredIn ?? s.id, line: 0, message: `${a.id} (tool ${a.name}): ${problem}` });
      }
    }
  }

  return { surfaces, pages: metas, frames, errors: uniqueErrors };
}

/**
 * The surface that goes to any page by its address: one action whose path
 * lists every route with its page's title, and the page the person is on.
 * Generated from the routes, so a page added is a page the PA can go to.
 */
function navigationSurface(routes: readonly { path: string; title: string }[]): ManifestSurface {
  const listed = routes.map(r => `${r.path} (${r.title})`).join(', ');
  return {
    id: NAVIGATION_SURFACE_ID,
    kind: 'navigation',
    title: 'Pages',
    description: 'Every page of the app, by its address, and the page the person is on.',
    routes: routes.map(r => r.path),
    actions: [
      {
        name: toolName(NAVIGATE_ACTION_ID),
        id: NAVIGATE_ACTION_ID,
        source: 'navigation',
        title: 'Go to a page',
        description:
          'Go to a page of the app, as following a link to it does. The page’s own tools are offered once it is open.',
        input: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `The page’s address, with an id in place of each :parameter. The pages: ${listed}.`,
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        reach: [],
      },
    ],
    observations: [
      {
        id: LOCATION_OBSERVATION_ID,
        description: 'The address of the page the person is on.',
        schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        id: PROBLEMS_OBSERVATION_ID,
        description:
          'What stops the page at this address from opening for the person: access it needs that they do not have, a load that failed. Reported here when the page itself is not open to report it; empty otherwise.',
        schema: PROBLEMS_SCHEMA,
      },
    ],
  };
}

function controlAction(
  c: FoundControl,
  page: PageInput,
  pageTitle: string,
  navFor: (route: string) => NavEntry | undefined,
  api: ApiOperations,
  allRoutes: readonly RouteEntry[],
  dialogBindings: ReadonlySet<string>,
  tabBindings: ReadonlySet<string>,
  errors: Finding[],
): ManifestAction | null {
  const at = { file: c.declaredIn, line: c.line };
  const idProblem = bindingIdProblem(c.binding.id);
  if (idProblem) {
    errors.push({ ...at, message: idProblem });
    return null;
  }
  let effect: ActionEffect | undefined = c.binding.effect;
  if (!effect) {
    const targets = navigateTargets(c.callbacks.map(cb => cb.expr));
    if (targets.length === 1) effect = { kind: 'navigate', to: targets[0] };
  }
  for (const problem of effectProblems(effect, { api, allRoutes, containers: new Set([...dialogBindings, ...tabBindings]) }))
    errors.push({ ...at, message: `"${c.binding.id}"${joined(problem)}` });

  const route = page.routes[0]?.path ?? '';
  const navEntry = navFor(route);
  const reach: ReachStep[] = [
    {
      kind: 'route',
      path: route,
      title: pageTitle,
      ...(navEntry ? { nav: [navEntry.group, navEntry.label].filter(Boolean).join(' › ') } : {}),
    },
    ...c.reach.map(cleanStep),
  ];
  const input = deriveInputSchema(c.kind, c.schemaProps, { itemized: c.itemized });
  return {
    name: toolName(c.binding.id),
    id: c.binding.id,
    source: 'control',
    control: c.kind,
    title: c.title || humanizeId(c.binding.id),
    description: toolDescription(c, effect, reach, api.operations),
    input,
    ...(effect ? { effect } : {}),
    ...(c.binding.destructive ? { destructive: true } : {}),
    ...(c.binding.confirm ? { confirm: true } : {}),
    ...(c.itemized ? { itemized: true } : {}),
    reach,
    declaredIn: c.declaredIn,
  };
}

/** A problem after what it is about: `: <shape problem>`, or ` <what it names>`. */
const joined = (problem: string) => (problem.startsWith(':') ? problem : ` ${problem}`);

/**
 * What is wrong with a declared effect: its shape (a problem starting `:`),
 * then what it names that the app does not have.
 */
function effectProblems(
  effect: ActionEffect | undefined,
  app: { api: ApiOperations; allRoutes: readonly RouteEntry[]; containers?: ReadonlySet<string> },
): string[] {
  if (effect === undefined) return [];
  const shape = effectProblem(effect);
  if (shape) return [`: ${shape}`];
  if (typeof effect !== 'object') return [];
  const problems: string[] = [];
  if (effect.kind === 'navigate' && !app.allRoutes.some(r => routeMatcher(r.path).test(effect.to) || r.path === effect.to))
    problems.push(`navigates to ${effect.to}, which is not a route`);
  if (effect.kind === 'open' && app.containers && !app.containers.has(effect.container))
    problems.push(`opens ${effect.container}, which is no bound dialog or tab set`);
  const operation = effect.kind === 'mutate' || effect.kind === 'transaction' ? effect.operation : undefined;
  if (operation !== undefined) {
    if (app.api.spec === null)
      problems.push(
        `saves through API operation ${operation}, but oui.config.json declares no API ("apiSpec": null)`,
      );
    else if (app.api.readable && !app.api.operations.has(operation))
      problems.push(`names API operation ${operation}, which ${app.api.spec} does not have`);
  }
  return problems;
}

/**
 * What an effect adds to a tool's description: where it goes, that the call
 * returns before the work is done, what it saves through, that it is
 * irreversible. Effects that only change the page itself add nothing.
 */
function effectSentences(effect: ActionEffect | undefined, api: ReadonlyMap<string, ApiOperation>): string[] {
  if (!effect || typeof effect !== 'object') return [];
  const through = (operation: string) => {
    const op = api.get(operation);
    return `${operation}${op ? ` (${op.method} ${op.url}${op.summary ? `: ${op.summary}` : ''})` : ''}`;
  };
  switch (effect.kind) {
    case 'navigate':
      return [`It goes to ${effect.to}.`];
    case 'job':
      return [
        `It starts a job${effect.estimatedDuration ? ` that takes about ${effect.estimatedDuration}` : ''}: ` +
          'the call returns once the job has started, and the job is done only when its status says complete.',
      ];
    case 'mutate':
      return [`It saves through ${through(effect.operation)}.`];
    case 'transaction':
      return [
        `It is irreversible: it runs only on the person’s approval of this exact call${effect.operation ? `, through ${through(effect.operation)}` : ''}.`,
      ];
    default:
      return [];
  }
}

function cleanStep(step: ReachStep | DialogStep): ReachStep {
  if (step.kind === 'panel') return { kind: 'panel', title: step.title, openedBy: [...step.openedBy] };
  if (step.kind !== 'dialog') return step;
  return {
    kind: 'dialog',
    title: step.title,
    openedBy: [...step.openedBy],
    ...('binding' in step && step.binding ? { binding: step.binding } : {}),
  };
}

function toolDescription(
  c: FoundControl,
  effect: ActionEffect | undefined,
  reach: ReachStep[],
  api: ReadonlyMap<string, ApiOperation>,
): string {
  // Each part is a sentence, so what follows the binding's own description starts a new one.
  const parts = [sentence(`${controlVerb(c.kind)} "${c.title || humanizeId(c.binding.id)}": ${c.binding.description}`)];
  if (c.hint && !c.binding.description.includes(c.hint)) parts.push(`The field's hint: ${sentence(c.hint)}`);
  if (c.placeholder) parts.push(`Its placeholder, an example of what goes in it: "${c.placeholder}".`);
  if (c.itemized) parts.push('It is one per row: say which row with `item`.');
  const where = reach.slice(1).map(describeStep).filter(Boolean);
  if (where.length) parts.push(`It is ${where.join(', ')}.`);
  parts.push(...effectSentences(effect, api));
  return parts.join(' ');
}

/** A text as a sentence: it ends with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  return /[.!?…"”)]$/.test(text) ? text : `${text}.`;
}

export function describeStep(step: ReachStep): string {
  switch (step.kind) {
    case 'route':
      return `on ${step.title} (${step.path})`;
    case 'tab':
      return `on the "${step.title}" tab (select it with ${toolName(step.binding)})`;
    case 'dialog':
      return `in the "${step.title}" dialog${step.openedBy.length ? ` (open it with ${step.openedBy.map(toolName).join(' or ')})` : ''}`;
    case 'menu':
      return `in the ${step.title} menu`;
    case 'panel':
      return `in the ${step.title}${step.openedBy.length ? ` (it shows after ${step.openedBy.map(toolName).join(' or ')})` : ''}`;
    case 'room':
      return step.where;
  }
}

function stateDescription(actions: readonly ManifestAction[]): string {
  const values = actions.filter(
    a => !a.itemized && a.control && a.control !== 'button' && a.control !== 'dialog',
  );
  const lists = [...new Set(actions.filter(a => a.itemized).map(a => a.id))];
  const parts = ['What the page shows now.'];
  if (values.length) parts.push(`values: ${values.map(a => `${a.id} (${a.title})`).join(', ')}.`);
  if (lists.length)
    parts.push(
      `lists: the rows on screen for ${lists.join(', ')}, as { key, title }; pass a key or title as \`item\`.`,
    );
  return parts.join(' ');
}

function pageDescription(page: PageInput, title: string): string {
  const subtitles = page.analysis?.header.subtitles ?? [];
  if (subtitles.length) return subtitles.join(' ');
  if (page.frame) {
    const where = page.routes.map(r => r.path);
    return `${title}: the app's frame, around ${where.includes('*') ? 'every page' : `the pages at ${where.join(', ')}`}. Its controls are there whatever page is open.`;
  }
  return `The ${title} page (${page.routes.map(r => r.path).join(', ')}).`;
}

function sortActions(actions: readonly ManifestAction[]): ManifestAction[] {
  return [...actions].sort((a, b) => a.name.localeCompare(b.name));
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.file}:${f.line}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `VoicesPage` → `Voices Page`. */
export function words(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\bPage$/, '')
      .trim() || name
  );
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

export function roomSurface(
  catalog: RoomCatalogData,
  routes: string[],
  api: ReadonlyMap<string, ApiOperation> = new Map(),
): ManifestSurface {
  const where = (control: string, selection?: readonly string[]): ReachStep => ({
    kind: 'room',
    room: catalog.room,
    where: control,
    ...(selection ? { selection } : {}),
  });
  const actions: ManifestAction[] = catalog.actions.map(a => ({
    name: roomToolName(catalog.room, a.id),
    id: `${catalog.room}/action/${a.id}`,
    source: 'room-action',
    title: a.title,
    description: [`${a.title}: ${a.description} (${a.control})`, ...effectSentences(a.effect, api)].join(' '),
    input: a.input,
    effect: a.effect,
    ...(a.destructive ? { destructive: true } : {}),
    reach: [where(a.control)],
  }));
  const observations: ManifestObservation[] = catalog.observations.map(o => ({ ...o }));
  if (!observations.some(o => o.id === PROBLEMS_OBSERVATION_ID)) {
    // In the room's own vocabulary when it declares its kinds of problem.
    const schema = problemsSchema(catalog.problems);
    observations.push({ id: PROBLEMS_OBSERVATION_ID, description: schema.description!, schema });
  }
  return {
    id: `room:${catalog.room}`,
    kind: 'room',
    title: catalog.title,
    description: catalog.description,
    routes,
    actions: [...actions].sort((a, b) => a.name.localeCompare(b.name)),
    observations,
  };
}

/**
 * What a room's catalog must declare for its fields and commands to be
 * reachable, and what its entries' effects and recipes name that the app or
 * the room does not have.
 */
function catalogProblems(
  { package: pkg, catalog }: LoadedCatalog,
  app: { api: ApiOperations; allRoutes: readonly RouteEntry[] },
): Finding[] {
  const out: Finding[] = [];
  for (const a of catalog.actions) {
    for (const problem of effectProblems(a.effect, app))
      out.push({ file: pkg, line: 0, message: `${catalog.room} action ${a.id}${joined(problem)}` });
  }
  for (const message of recipeProblems(catalog)) out.push({ file: pkg, line: 0, message });
  const ids = new Set(catalog.actions.map(a => a.id));
  if (catalog.fields.length && !ids.has(ROOM_SET_PROPERTIES_ID)) {
    out.push({
      file: pkg,
      line: 0,
      message: `${catalog.room} declares fields but no "${ROOM_SET_PROPERTIES_ID}" action to set them`,
    });
  }
  if (catalog.commands.some(c => c.status === 'available') && !ids.has(ROOM_RUN_COMMAND_ID)) {
    out.push({
      file: pkg,
      line: 0,
      message: `${catalog.room} declares commands but no "${ROOM_RUN_COMMAND_ID}" action to run them`,
    });
  }
  for (const a of catalog.actions) {
    const name = roomToolName(catalog.room, a.id);
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      out.push({ file: pkg, line: 0, message: `${catalog.room} action ${a.id}: its tool name ${name} is longer than ${MAX_TOOL_NAME_LENGTH}` });
    }
  }
  return out;
}
