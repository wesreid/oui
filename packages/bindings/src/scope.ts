/**
 * One build, several audiences: what a session may see of the build.
 *
 * A build can serve several brands or audiences, each opening some pages to
 * its people and not others (a route wrapped in `<FeatureRoute
 * feature="campaigns">`). The generator records each route's gates
 * (`routeGates` in `oui.config.json`, `gates` on a page's manifest surface and
 * knowledge), and carries the app's map line by line (`map`). The host says
 * which gates the session's person has (`allows`), and everything the
 * assistant is told of the app is the build as that person sees it: the
 * app's map, the app-wide search (`oui.find`), the page guide (`oui.guide`),
 * and the pages `app.navigate` goes to.
 *
 * A route is open when the host allows every gate it lists; a page is open
 * when any of its routes is. Without `allows`, or in a build with no gates,
 * everything is open and nothing here changes a byte.
 */
import type {
  AppMapLine,
  GeneratedKnowledge,
  KnowledgeEntry,
  KnowledgeRecipe,
  ManifestSurface,
  OuiManifest,
  PageKnowledge,
  RouteGates,
} from '@ouispec/contract';

import { NAVIGATION_SURFACE_ID, pageForPath, pageRouteForPath, routeMatcher, type ResolvedKnowledge } from './manifest.js';
import { scopedNavigationSurface } from './navigation.js';

/** Which gates the session may see: true for a gate its person has (a brand's feature, an audience). */
export type GateFilter = (gate: string) => boolean;

export type { AppMapLine, RouteGates } from '@ouispec/contract';

/** Whether a route is open to the session: the host allows every gate it lists. A route with none always is. */
export function routeOpen(gates: RouteGates | undefined, route: string, allows?: GateFilter): boolean {
  const on = gates?.[route];
  return !on || !allows || on.every(gate => allows(gate));
}

/** The routes of a page (a manifest page surface, or its knowledge) open to the session, in its order. */
export function openRoutes(page: { routes: readonly string[]; gates?: RouteGates }, allows?: GateFilter): string[] {
  return page.routes.filter(route => routeOpen(page.gates, route, allows));
}

/** Every gate a build's pages name, once each, sorted. */
export function buildGates(pages: readonly { gates?: RouteGates }[]): string[] {
  return [...new Set(pages.flatMap(p => Object.values(p.gates ?? {}).flat()))].sort();
}

/**
 * What a session may see, as a key: the build's gates it is allowed, or null
 * when nothing is gated for it (no `allows`, or a build with no gates). Two
 * sessions with one key see the same build.
 */
export function scopeKey(gates: readonly string[], allows?: GateFilter): string | null {
  if (!allows || gates.length === 0) return null;
  return gates.filter(gate => allows(gate)).join('\n');
}

/**
 * The app's map as text, from its lines (`GeneratedKnowledge.map`): a page's
 * line with the route `routeOf` gives it, or left out when it gives none; a
 * heading only when a page line under it is shown. Without `routeOf`, every
 * page with its own route: the map's `overview.content`.
 */
export function appMapContent(
  lines: readonly AppMapLine[],
  routeOf: (line: Extract<AppMapLine, { kind: 'page' }>) => string | null = line => line.route,
): string {
  const out: string[] = [];
  let heading: string | null = null;
  for (const line of lines) {
    if (line.kind === 'page') {
      const route = routeOf(line);
      if (route === null) continue;
      if (heading !== null) {
        out.push(heading);
        heading = null;
      }
      // What the page says it is for comes first; what it offers follows it.
      const said = line.says ? `: ${line.says}${line.offers ? ` ${line.offers}` : ''}` : line.offers ? `: ${line.offers}` : '';
      out.push(`${'  '.repeat(line.depth)}- ${line.title} ${route}${line.from !== undefined ? ` (from ${line.from})` : ''}${said}`);
      continue;
    }
    // A heading waits for a page line under it; any other line ends what it heads.
    heading = line.kind === 'heading' ? line.text : null;
    if (line.kind === 'text') out.push(line.text);
  }
  return out.join('\n');
}

/**
 * The routes of a build and which of them are shut to a session: a route of a
 * page that is not open to it, and open on no other page.
 */
export interface RouteScope {
  /** Every route of the build's pages. */
  routes: readonly string[];
  /** The routes the session may not see. */
  shut: ReadonlySet<string>;
}

/** The build's routes and those shut to the session, from its pages (the manifest's page surfaces, or the knowledge's pages). */
export function routeScope(pages: readonly { routes: readonly string[]; gates?: RouteGates }[], allows?: GateFilter): RouteScope {
  const open = new Set<string>();
  const closed = new Set<string>();
  for (const page of pages) for (const route of page.routes) (routeOpen(page.gates, route, allows) ? open : closed).add(route);
  return { routes: [...new Set([...open, ...closed])], shut: new Set([...closed].filter(r => !open.has(r))) };
}

/** The route an address or a route pattern written in a text is: the pattern itself, else the most specific one it matches. */
function routeOfToken(token: string, routes: readonly string[]): string | null {
  if (routes.includes(token)) return token;
  let best: { route: string; score: number } | null = null;
  for (const route of routes) {
    if (route === '*' || !routeMatcher(route).test(token)) continue;
    const score = route.split('/').filter(seg => seg && !seg.startsWith(':')).length * 10 - (route.match(/:/g)?.length ?? 0);
    if (!best || score > best.score) best = { route, score };
  }
  return best?.route ?? null;
}

/**
 * An address or a route a generated text names: `/war-room` in "(goes to
 * /war-room)", "on /, /war-room." or "Person (/clients/:id, /people/:id)".
 * Not a path prefix ("every page under /dashboard"), and not a slash between
 * words ("⌘G / Ctrl+G").
 */
const PATH_TOKEN = /(^|[\s(])(\/[^\s,;)]*)/g;

/**
 * A sentence without the shut routes it names: one in a list of routes
 * ("on /, /war-room") leaves the list; a sentence that names one otherwise
 * ("It goes to /war-room.", "leads to War Room (/war-room).") is about that
 * page, and is null.
 */
function sentenceWithout(sentence: string, scope: RouteScope): string | null {
  // Every shut route the sentence names, found in one reading, then taken out from the last to the first so the
  // places of those before it stay where they are.
  const found: { start: number; end: number }[] = [];
  PATH_TOKEN.lastIndex = 0;
  for (let m = PATH_TOKEN.exec(sentence); m; m = PATH_TOKEN.exec(sentence)) {
    const start = m.index + m[1].length;
    const token = m[2].replace(/[.:]+$/, '');
    const end = start + token.length;
    if (token === '/' && /\s/.test(sentence[end] ?? '')) continue;
    if (/\bunder $/.test(sentence.slice(0, start))) continue;
    const route = routeOfToken(token, scope.routes);
    if (route !== null && scope.shut.has(route)) found.push({ start, end });
  }
  let text = sentence;
  for (const { start, end } of found.reverse()) {
    const after = text.slice(end);
    const before = text.slice(0, start);
    // One of a list of routes: it leaves the list, with its separator.
    if (/^, \//.test(after)) text = before + after.slice(2);
    else if (/(^|[\s(])\/[^\s,;)]*, $/.test(before)) text = before.slice(0, -2) + after;
    else return null;
  }
  return text;
}

/**
 * A generated text as a session sees it: every sentence that names a page it
 * may not see by its route or address left out (an item of a list, a line
 * starting "- ", whole), and such a route taken out of a list of routes. A
 * heading line ("On the page:") whose items all went goes too. Empty when nothing is left. The same text when it names no shut
 * route.
 */
export function scopeText(text: string, scope: RouteScope): string {
  if (scope.shut.size === 0 || ![...scope.shut].some(route => text.includes(route.split('/:')[0] || '/'))) return text;
  const lines = text.split('\n');
  const kept: (string | null)[] = lines.map(line => {
    // Sentences, each with the space before it, so a line keeps its own spacing.
    const parts = line.split(/(?<=[.!?])(\s+)(?=\S)/);
    let out = '';
    let any = false;
    let dropped = false;
    for (let i = 0; i < parts.length; i += 2) {
      const said = sentenceWithout(parts[i], scope);
      if (said === null) {
        dropped = true;
        continue;
      }
      out += (any ? (parts[i - 1] ?? ' ') : '') + said;
      any = true;
    }
    if (!dropped) return out;
    // An item of a list ("- My Replica [open_my_replica]: Goes to …") is about one thing: all of it goes.
    if (line.trimStart().startsWith('- ')) return null;
    return any ? out : null;
  });
  // A heading whose items all went goes with them.
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    if (line === null) continue;
    if (line.trimEnd().endsWith(':') && lines[i + 1]?.trimStart().startsWith('- ')) {
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith('- ')) j++;
      if (kept.slice(i + 1, j).every(l => l === null)) continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Every `description` in a value (a surface, an action's input schema) as the session sees it. */
function scopeDescriptions<T>(value: T, scope: RouteScope): T {
  if (Array.isArray(value)) return value.map(v => scopeDescriptions(v, scope)) as T;
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const next = key === 'description' && typeof v === 'string' ? scopeText(v, scope) : scopeDescriptions(v, scope);
    if (next !== v) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}

/** A knowledge entry as the session sees it; null when nothing of it is left. */
function scopeEntry<E extends { title: string; content: string }>(entry: E, scope: RouteScope): E | null {
  const content = scopeText(entry.content, scope);
  if (!content.trim()) return null;
  const title = scopeText(entry.title, scope) || entry.title;
  return content === entry.content && title === entry.title ? entry : { ...entry, title, content };
}

/** A page's or a frame's knowledge as the session sees it. */
function scopePage(page: PageKnowledge, scope: RouteScope, open: ReadonlySet<string>): PageKnowledge {
  const recipes = page.recipes.flatMap(recipe => {
    const name = scopeText(recipe.name, scope);
    const trigger = scopeText(recipe.trigger, scope);
    const steps = recipe.steps.map(step => scopeText(step, scope));
    // A recipe one of whose steps goes to a page the session may not see is not one it can follow.
    if (!name || !trigger || steps.some(step => !step)) return [];
    return [{ ...recipe, name, trigger, steps }];
  });
  const routes = page.routes.filter(route => !scope.shut.has(route));
  // An entry all of whose sentences name a page the session may not see (a description that says where it
  // leads) is said by the page's name and its open routes alone, never as it was.
  const named = (entry: KnowledgeEntry): KnowledgeEntry => ({
    ...entry,
    title: scopeText(entry.title, scope) || page.summary.title,
    content: `${page.summary.title}${routes.length ? ` (${routes.join(', ')})` : ''}.`,
  });
  return {
    ...page,
    routes,
    summary: scopeEntry(page.summary, scope) ?? named(page.summary),
    detail: scopeEntry(page.detail, scope) ?? named(page.detail),
    relationships: page.relationships ? scopeEntry(page.relationships, scope) : null,
    recipes,
    adjacent: page.adjacent.filter(id => open.has(id)),
  };
}

/**
 * The knowledge as the session sees it: only the pages open to it, each with
 * only its open routes and the open pages it leads to or is reached from; the
 * app's map without the others; and no sentence of any entry or recipe that
 * names a page it may not see (`scopeText`): a control that goes to one, a
 * shared part's other pages, a route list. The same object when nothing is
 * gated for the session.
 */
export function scopeKnowledge(knowledge: GeneratedKnowledge, allows?: GateFilter): GeneratedKnowledge {
  if (scopeKey(buildGates(knowledge.pages), allows) === null) return knowledge;
  const scope = routeScope(knowledge.pages, allows);
  const kept = knowledge.pages.filter(page => openRoutes(page, allows).length > 0);
  const open = new Set(kept.map(p => p.surface));
  const pages = kept.map(page => scopePage(page, scope, open));
  const bySurface = new Map(pages.map(p => [p.surface, p]));
  const frames = knowledge.frames
    ?.map(frame => ({ ...scopePage(frame, scope, open), routes: frame.routes.filter(route => !scope.shut.has(route)) }))
    .filter(frame => frame.routes.length > 0);
  const { map, frames: _frames, ...rest } = knowledge;
  const overview = map
    ? {
        ...knowledge.overview,
        content: appMapContent(
          map.flatMap((line): AppMapLine[] => {
            if (line.kind === 'page') {
              // What an open page says it is for, without what names a page the session may not see.
              if (!line.says) return [line];
              const says = scopeText(line.says, scope);
              if (says === line.says) return [line];
              const { says: _says, ...rest } = line;
              return [says ? { ...line, says } : rest];
            }
            const text = scopeText(line.text, scope);
            return text ? [{ ...line, text }] : [];
          }),
          line => {
            const page = bySurface.get(line.surface);
            if (!page) return null;
            return page.routes.includes(line.route) ? line.route : page.routes[0];
          },
        ),
      }
    : { ...knowledge.overview, content: scopeText(knowledge.overview.content, scope) };
  return { ...rest, overview, pages, ...(frames ? { frames } : {}) };
}

/** Whether an action only goes to a page the session may not see: a control that leads nowhere for it. */
function goesToShut(action: ManifestSurface['actions'][number], scope: RouteScope): boolean {
  const effect = action.effect;
  if (!effect || typeof effect !== 'object' || effect.kind !== 'navigate') return false;
  const route = routeOfToken(effect.to.split(/[?#]/)[0], scope.routes);
  return route !== null && scope.shut.has(route);
}

/**
 * The manifest as the session sees it: its page surfaces only with their open
 * routes (a page with none is left out); a shared part, a room or a frame
 * only on routes still open (one left with none is left out); no action that
 * only goes to a page the session may not see; no route step to such a page
 * in an action's reach; every description without what names such a page
 * (`scopeText`); and the navigation surface listing only the open pages. The
 * same object when nothing is gated for the session.
 */
export function scopeManifest(manifest: OuiManifest, allows?: GateFilter): OuiManifest {
  const pageSurfaces = manifest.surfaces.filter(s => s.kind === 'page');
  if (scopeKey(buildGates(pageSurfaces), allows) === null) return manifest;
  const scope = routeScope(pageSurfaces, allows);
  const titles = new Map<string, string>();
  for (const page of pageSurfaces) for (const route of page.routes) if (!scope.shut.has(route)) titles.set(route, page.title);
  const surfaces: ManifestSurface[] = [];
  for (const surface of manifest.surfaces) {
    if (surface.kind === 'navigation' && surface.id === NAVIGATION_SURFACE_ID) {
      surfaces.push(scopedNavigationSurface(surface, route => !scope.shut.has(route), route => titles.get(route) ?? route));
      continue;
    }
    const routes = surface.kind === 'page' ? openRoutes(surface, allows) : surface.routes.filter(route => !scope.shut.has(route));
    if (surface.routes.length > 0 && routes.length === 0) continue;
    const actions = surface.actions
      .filter(action => !goesToShut(action, scope))
      .map(action => {
        const reach = action.reach.filter(step => !(step.kind === 'route' && scope.shut.has(step.path)));
        return reach.length === action.reach.length ? action : { ...action, reach };
      });
    const kept =
      routes.length === surface.routes.length && actions.every((a, i) => a === surface.actions[i]) && actions.length === surface.actions.length
        ? surface
        : { ...surface, routes, actions };
    surfaces.push(scopeDescriptions(kept, scope));
  }
  return { ...manifest, surfaces };
}

/** The tool names of a build's actions a session is not offered: each goes only to a page it may not see. */
export function closedActions(manifest: OuiManifest, allows?: GateFilter): Set<string> {
  const scoped = scopeManifest(manifest, allows);
  if (scoped === manifest) return new Set();
  const kept = new Set(scoped.surfaces.flatMap(s => s.actions.map(a => a.id)));
  return new Set(manifest.surfaces.flatMap(s => s.actions.filter(a => !kept.has(a.id)).map(a => a.id)));
}

/**
 * The page at a path, when the session may see it (`allows`): the
 * path is matched against every route of the build, so an address on a page
 * the session may not see is no page, never a less specific one it may.
 */
export function openPageForPath(knowledge: GeneratedKnowledge, path: string, allows?: GateFilter): PageKnowledge | null {
  const at = pageRouteForPath(knowledge, path);
  return at && routeOpen(at.page.gates, at.route, allows) ? at.page : null;
}

/** What `resolveKnowledge` is given beside the knowledge and the path. */
export interface ResolveKnowledgeOptions {
  /**
   * Which gates the session may see (`routeGates`). The map then
   * lists only the pages open to it, and a page it may not see is neither the
   * page it is on nor one beside it. Without it, every page.
   */
  allows?: GateFilter;
}

/**
 * The knowledge for the page the user is on: the app's map (also apart, as
 * `map`), then the frame, the page in full with its relationships and
 * recipes, and one paragraph for each adjacent page. With `allows`, as the
 * session sees the build.
 */
export function resolveKnowledge(knowledge: GeneratedKnowledge, path: string, options: ResolveKnowledgeOptions = {}): ResolvedKnowledge {
  const scoped = scopeKnowledge(knowledge, options.allows);
  const entries: KnowledgeEntry[] = [scoped.overview];
  const workflows: KnowledgeRecipe[] = [];
  // The frame is on the page too: what it offers comes first, as it is always
  // there, and so do the recipes of the rooms it holds open.
  const clean = path.split(/[?#]/)[0] || '/';
  for (const frame of scoped.frames ?? []) {
    if (!frame.routes.some(route => routeMatcher(route).test(clean))) continue;
    entries.push(frame.detail);
    workflows.push(...frame.recipes);
  }
  const bySurface = new Map(scoped.pages.map(p => [p.surface, p]));
  const at = scoped === knowledge ? pageForPath(knowledge, path) : openPageForPath(knowledge, path, options.allows);
  const page = at ? bySurface.get(at.surface) ?? null : null;
  if (page) {
    entries.push(page.detail);
    if (page.relationships) entries.push(page.relationships);
    workflows.push(...page.recipes);
    for (const id of page.adjacent) {
      const other = bySurface.get(id);
      if (other) entries.push(other.summary);
    }
  }
  return { map: scoped.overview, entries, workflows };
}
