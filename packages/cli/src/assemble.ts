/**
 * The build's surfaces: one per page, one per component shared
 * between pages, one per room, each with its actions, their reach paths and
 * the page's observations — validated as it is put together.
 */

import {
  manifestBudgetProblems,
  bindingIdProblem,
  controlVerb,
  deriveInputSchema,
  effectProblem,
  generatedNavigationSurface,
  MAX_TOOL_NAME_LENGTH,
  pageQueryProblems,
  PROBLEMS_OBSERVATION_ID,
  PROBLEMS_SCHEMA,
  problemsSchema,
  ROOM_RUN_COMMAND_ID,
  ROOM_SET_PROPERTIES_ID,
  roomListProblems,
  roomMeasureProblems,
  routeMatcher,
  SHOWN_ROWS,
  toolInputProblems,
  toolName,
  type ActionEffect,
  type JsonSchema,
  type ManifestAction,
  type ManifestObservation,
  type ManifestSurface,
  type PageQuery,
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
import { contractFindings } from './contract.js';
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
  /** The query the page reads from its address (`readQuery`), every declaration it reads in one; absent when it reads none. */
  query?: PageQuery;
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
        'What the page shows that is not a control, by display: its binding id, heading and facts, each as text by its label; facts that describe one row of a list (a card each) carry the row as item, and a long list of them keeps an index of its rows',
      items: { type: 'object' },
      'x-rows': { ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] },
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

  // Binding ids of controls are unique across the build.
  const byId = new Map<string, string[]>();
  for (const [site, { control }] of sites)
    byId.set(control.binding.id, [...(byId.get(control.binding.id) ?? []), site]);
  // A display may share an id: with the control whose rows it describes (a
  // card bound to open reports what it shows under that binding), or with
  // itself shown from several places (a notice in two branches). Every
  // declaration of the id then says the same thing.
  const described = new Map<string, { description: string; site: string }>();
  for (const [site, { control }] of sites)
    if (!described.has(control.binding.id)) described.set(control.binding.id, { description: control.binding.description, site });
  for (const page of pages) {
    for (const d of page.analysis?.displays ?? []) {
      const before = described.get(d.binding.id);
      if (!before) described.set(d.binding.id, { description: d.binding.description, site: d.site });
      else if (before.description !== d.binding.description) {
        errors.push({
          file: d.declaredIn,
          line: d.line,
          message: `Binding id "${d.binding.id}" is described differently at ${before.site} and ${d.site}: a display shares an id only with the control or display it is, in the same words`,
        });
      }
    }
  }
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

  const allPaths = allRoutes.map(r => r.path);
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
  // A reason a control gives for not being the assistant's often names what the assistant uses
  // instead: "(editor.add-asset.open)", or "the insert.media command". That name is checked, since
  // a reason pointing at an action that does not exist leaves the assistant with no way to do it
  // and nothing saying so.
  const bindingIds = new Set<string>();
  const commandIds = new Set<string>();
  for (const page of pages) {
    for (const control of page.analysis?.controls ?? []) bindingIds.add(control.binding.id);
    for (const display of page.analysis?.displays ?? []) bindingIds.add(display.binding.id);
    for (const room of page.analysis?.rooms ?? []) {
      for (const action of room.catalog.actions) bindingIds.add(action.id);
      for (const command of room.catalog.commands ?? []) commandIds.add(command.id);
    }
  }
  for (const page of pages) {
    for (const reason of page.analysis?.nonAgent ?? []) {
      for (const problem of nonAgentReferenceProblems(reason.message, bindingIds, commandIds)) {
        errors.push({ file: reason.file, line: reason.line, message: problem });
      }
    }
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
  // The query each page reads from its address: its declarations, each held
  // to the contract, as one. A parameter two declarations give different
  // meanings is refused: the address can only hold one.
  const pageQueries = new Map<string, PageQuery>();
  for (const page of pages) {
    if (page.frame) continue;
    const merged: Record<string, { param: PageQuery[string]; from: string }> = {};
    for (const q of page.analysis?.queries ?? []) {
      const from = `${q.name} (${q.file}:${q.line})`;
      const contract = contractFindings('page-query.json', q.declaration, q.file, `The query ${q.name}`).map(f => ({ ...f, line: q.line }));
      if (contract.length) {
        errors.push(...contract);
        continue;
      }
      const declaration = q.declaration as PageQuery;
      const problems = pageQueryProblems(declaration);
      if (problems.length) {
        errors.push(...problems.map(message => ({ file: q.file, line: q.line, message: `The query ${q.name}: ${message}` })));
        continue;
      }
      for (const [name, param] of Object.entries(declaration)) {
        const before = merged[name];
        if (before && JSON.stringify(before.param) !== JSON.stringify(param)) {
          errors.push({
            file: q.file,
            line: q.line,
            message: `${page.component} reads ?${name} from two declarations that differ, ${before.from} and ${from}: the address holds one ?${name}, so declare it once`,
          });
          continue;
        }
        merged[name] = { param, from };
      }
    }
    if (Object.keys(merged).length) {
      pageQueries.set(page.component, Object.fromEntries(Object.entries(merged).map(([name, { param }]) => [name, param])));
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
    const description = pageDescription(page, pageTitle(page), allPaths);
    const observations: ManifestObservation[] = [
      { id: 'state', description: stateDescription(found?.actions ?? []), schema: PAGE_STATE_SCHEMA },
      { id: PROBLEMS_OBSERVATION_ID, description: PROBLEMS_SCHEMA.description!, schema: PROBLEMS_SCHEMA },
    ];
    const shown = (page.analysis?.displays ?? [])
      .map(d => ({
        id: d.binding.id,
        title: d.title || humanizeId(d.binding.id),
        description: d.binding.description,
        labels: d.labels,
        reach: d.reach.map(cleanStep),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    // Each display once, by binding id: what its state's `shown` can hold.
    const displays = [...new Map(shown.map(({ reach: _reach, ...d }) => [d.id, d])).values()];
    surfaces.push({
      id,
      kind,
      title: pageTitle(page),
      description,
      routes: page.routes.map(r => r.path),
      actions: sortActions(found?.actions ?? []),
      observations,
      ...(displays.length ? { displays } : {}),
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
      shown,
      ...(pageQueries.has(page.component) ? { query: pageQueries.get(page.component)! } : {}),
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
      description: `${s.title}, on ${everyPage([...s.routes], allPaths) ?? [...s.routes].sort().join(', ')}.`,
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
    generatedNavigationSurface(
      pages
        .filter(p => !p.frame)
        .flatMap(p => p.routes.map(r => ({ path: r.path, title: pageTitle(p), query: pageQueries.get(p.component) })))
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

  // What the build offers fits what carries it: an index
  // entry, a definition and a surface's index each have a size they must stay
  // under, or the page that mounts them cannot be sent to the assistant.
  for (const problem of manifestBudgetProblems({ surfaces })) {
    uniqueErrors.push({ file: problem.declaredIn ?? problem.surface, line: 0, message: problem.message });
  }

  return { surfaces, pages: metas, frames, errors: uniqueErrors };
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

/** The fewest routes listed before a surface on every page under one path is said to be there instead. */
const LISTED_ROUTES = 3;

/**
 * Where a frame or a shared component is, when that is on every page: of the
 * app ("every page"), or under one path ("every page under /dashboard"), as
 * long as it is on more than `LISTED_ROUTES` pages. Null when its routes are
 * better listed. A surface on every page says so: listing a hundred routes
 * only says the same at length, in every turn's index of what is on the page.
 */
export function everyPage(routes: readonly string[], allRoutes: readonly string[]): string | null {
  const on = new Set(routes);
  if (on.has('*')) return 'every page';
  const pages = [...new Set(allRoutes)].filter(r => r !== '*');
  if (on.size <= LISTED_ROUTES) return null;
  if (pages.length && pages.every(r => on.has(r))) return 'every page';
  // The path every route is under, segment by segment.
  const split = [...on].map(r => r.split('/').filter(Boolean));
  const common: string[] = [];
  for (let i = 0; split.every(segments => i < segments.length && segments[i] === split[0][i]); i++) common.push(split[0][i]);
  if (!common.length) return null;
  const prefix = `/${common.join('/')}`;
  const under = pages.filter(r => r === prefix || r.startsWith(`${prefix}/`));
  return under.every(r => on.has(r)) ? `every page under ${prefix}` : null;
}

function pageDescription(page: PageInput, title: string, allRoutes: readonly string[]): string {
  const subtitles = page.analysis?.header.subtitles ?? [];
  if (subtitles.length) return subtitles.join(' ');
  if (page.frame) {
    const where = page.routes.map(r => r.path);
    return `${title}: the app's frame, around ${everyPage(where, allRoutes) ?? `the pages at ${where.join(', ')}`}. Its controls are there whatever page is open.`;
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
  // Its lists are readable and its inputs address lists it has.
  for (const message of roomListProblems(catalog)) out.push({ file: pkg, line: 0, message });
  // Every number it takes says its unit.
  for (const message of roomMeasureProblems(catalog)) out.push({ file: pkg, line: 0, message });
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

/** An id with a dot in it, as a binding or a command is named: `editor.add-asset.open`, `insert.media`. */
const DOTTED_ID = String.raw`[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+`;

/**
 * What a non-agent reason names that does not exist. Two forms are read, and
 * nothing else in the sentence: an id in parentheses, `(editor.add-asset.open)`,
 * is a binding or a room action; an id followed by "command", `the insert.media
 * command`, is a room's command.
 */
export function nonAgentReferenceProblems(
  reason: string,
  bindingIds: ReadonlySet<string>,
  commandIds: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const match of reason.matchAll(new RegExp(String.raw`\((${DOTTED_ID})\)`, 'g'))) {
    const id = match[1];
    if (!bindingIds.has(id) && !commandIds.has(id)) {
      problems.push(
        `A non-agent reason names "${id}", which is no binding, room action or command of the app: ` +
          'name the action the assistant uses instead, or bind this control',
      );
    }
  }
  for (const match of reason.matchAll(new RegExp(String.raw`(${DOTTED_ID}) command\b`, 'g'))) {
    const id = match[1];
    if (!commandIds.has(id)) {
      problems.push(
        `A non-agent reason names the command "${id}", which no room’s catalog has: ` +
          'name a command the assistant can run, or bind this control',
      );
    }
  }
  return problems;
}
