/**
 * What the generator emits for each build, and how the
 * runtime reads it: the manifest of every surface, action and observation the
 * build's UI offers, and the knowledge generated from the same declarations.
 *
 * Both are data. The runtime offers the intersection of the manifest and the
 * handlers mounted right now; the knowledge rides each turn for the page the
 * user is on.
 */

import type { GeneratedKnowledge, KnowledgeEntry, KnowledgeRecipe, PageKnowledge } from '@ouispec/contract';

// The manifest and the knowledge are the contract's (`oui-manifest.json`,
// `generated-knowledge.json`), generated from its schemas, and versioned with
// its major.
export { MANIFEST_VERSION } from '@ouispec/contract';
export type {
  GeneratedKnowledge,
  KnowledgeEntry,
  KnowledgeRecipe,
  ManifestAction,
  ManifestActionSource,
  ManifestDisplay,
  ManifestObservation,
  ManifestSurface,
  ManifestSurfaceKind,
  OuiManifest,
  PageKnowledge,
  ReachStep,
} from '@ouispec/contract';

/** What rides a turn as `context.uiKnowledge`. */
export interface ResolvedKnowledge {
  /**
   * The app's map: every page, how to reach it and what it offers. The same
   * for every page of a build, so an agent runtime that reads it here keeps it
   * apart from the page's entries, where the prompt cache reads it on every
   * turn. It is also the first of `entries`, for a runtime that reads only
   * those; one that reads `map` leaves that entry out.
   */
  map?: KnowledgeEntry;
  entries: KnowledgeEntry[];
  workflows: KnowledgeRecipe[];
}

/** A route pattern (`/voices/:id`) as a matcher for a path. */
export function routeMatcher(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map(seg =>
      seg.startsWith(':') ? '[^/]+' : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}/?$`);
}

/** The page surface for a path: the one whose route matches, preferring the most specific pattern. */
export function pageForPath(knowledge: GeneratedKnowledge, path: string): PageKnowledge | null {
  return pageRouteForPath(knowledge, path)?.page ?? null;
}

/** The page surface for a path and the route of it that matches, the most specific pattern first. */
export function pageRouteForPath(knowledge: GeneratedKnowledge, path: string): { page: PageKnowledge; route: string } | null {
  const clean = path.split(/[?#]/)[0] || '/';
  let best: { page: PageKnowledge; route: string; score: number } | null = null;
  for (const page of knowledge.pages) {
    for (const route of page.routes) {
      if (!routeMatcher(route).test(clean)) continue;
      const score =
        route.split('/').filter(s => s && !s.startsWith(':')).length * 10 - (route.match(/:/g)?.length ?? 0);
      if (!best || score > best.score) best = { page, route, score };
    }
  }
  return best ? { page: best.page, route: best.route } : null;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

/** The id of the surface that goes to a page by its address, generated from the app's routes. */
export const NAVIGATION_SURFACE_ID = 'app:navigation';
/** Its one action: go to a page. */
export const NAVIGATE_ACTION_ID = 'app.navigate';
/** Its observation: the address of the page the person is on. */
export const LOCATION_OBSERVATION_ID = 'location';

/** Whether a path is one of these route patterns, a `:param` standing for any one segment. */
export function isRoutePath(routes: readonly string[], path: string): boolean {
  const clean = path.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  return routes.some(route => routeMatcher(route).test(clean));
}
