/**
 * The surface that goes to any page by its address, as the generator emits
 * it: one place, so the generator's manifest and a page made without one (an
 * eval's fixture page) offer the same action, with the same input, checked
 * the same way.
 */
import type { PageQuery } from '@ouispec/contract';

import { toolName } from './binding.js';
import type { JsonSchema } from './json-schema.js';
import { LOCATION_OBSERVATION_ID, NAVIGATE_ACTION_ID, NAVIGATION_SURFACE_ID, type ManifestSurface } from './manifest.js';
import { NAVIGATION_QUERY_ROUTES, pageQuerySchema } from './query.js';
import { PROBLEMS_OBSERVATION_ID, PROBLEMS_SCHEMA } from './room.js';

/** One page's address, as the navigation surface lists it: its route, its title, and the query it reads, if any. */
export interface NavigationRoute {
  path: string;
  title: string;
  query?: PageQuery;
}

/**
 * The surface that goes to any page by its address: one action whose path
 * lists every route with its page's title, and the page the person is on.
 * Generated from the routes, so a page added is a page the PA can go to.
 *
 * A page that declares the query it reads (`readQuery`) is opened filtered:
 * the action takes `query`, one alternative per such page with the routes it
 * is on (`x-routes`) and a property per parameter, and `path` names the
 * parameters beside the page. `params` fills a route's `:parameters`. A build
 * where no page declares a query has the action as it always was, plus
 * `params`.
 */
export function generatedNavigationSurface(routes: readonly NavigationRoute[]): ManifestSurface {
  // One alternative per page, with every route it is on.
  const byQuery = new Map<PageQuery, { routes: string[]; title: string }>();
  for (const r of routes) {
    if (!r.query) continue;
    const entry = byQuery.get(r.query) ?? { routes: [], title: r.title };
    entry.routes.push(r.path);
    byQuery.set(r.query, entry);
  }
  // Each alternative leaves `additionalProperties` open: a query is checked
  // against its route's alternative when it runs (`navigationTarget`), which
  // names the page's parameters, rather than against every page's at once.
  const queries: JsonSchema[] = [...byQuery.entries()].map(([query, { routes: on, title }]) => ({
    type: 'object',
    description: `${title}: what its address takes.`,
    properties: pageQuerySchema(query).properties,
    [NAVIGATION_QUERY_ROUTES]: on,
  }));
  return navigationSurface(
    routes.map(r => ({ path: r.path, title: r.title, queryNames: r.query ? Object.keys(r.query) : null })),
    queries,
  );
}

/**
 * The navigation surface with only the routes `open` keeps: what the
 * generator would emit for a build of only those pages. Its `path` lists
 * them, and `query` keeps the alternatives of the pages left, each with only
 * their routes left. A route's title is its page's (`titleOf`), as the
 * generator lists it. This is how a session that may not see some pages
 * (`allows`) is offered none of them to go to.
 */
export function scopedNavigationSurface(
  surface: ManifestSurface,
  open: (route: string) => boolean,
  titleOf: (route: string) => string,
): ManifestSurface {
  const routes = surface.routes.filter(open);
  const position = new Map(routes.map((r, i) => [r, i]));
  const navigate = surface.actions.find(a => a.id === NAVIGATE_ACTION_ID);
  const alternatives = (navigate?.input.properties?.query?.anyOf ?? [])
    .map(alt => ({ ...alt, [NAVIGATION_QUERY_ROUTES]: (alt[NAVIGATION_QUERY_ROUTES] ?? []).filter(r => position.has(r)) }))
    .filter(alt => alt[NAVIGATION_QUERY_ROUTES].length > 0)
    // In the order the generator gives them: by the first route of each, as the routes are listed.
    .sort((a, b) => position.get(a[NAVIGATION_QUERY_ROUTES][0])! - position.get(b[NAVIGATION_QUERY_ROUTES][0])!);
  const namesOf = (route: string) => {
    const alt = alternatives.find(a => a[NAVIGATION_QUERY_ROUTES].includes(route));
    return alt ? Object.keys(alt.properties ?? {}) : null;
  };
  return navigationSurface(
    routes.map(path => ({ path, title: titleOf(path), queryNames: namesOf(path) })),
    alternatives,
  );
}

/** One route as `path` lists it: its address, its page's title, and the query parameters its page takes. */
function listing(r: { path: string; title: string; queryNames: readonly string[] | null }): string {
  return `${r.path} (${r.title}${r.queryNames ? `; ${r.queryNames.map(n => `?${n}`).join(', ')}` : ''})`;
}

/** The navigation surface for these routes, each listed, and the query alternatives of the pages that declare one. */
function navigationSurface(
  routes: readonly { path: string; title: string; queryNames: readonly string[] | null }[],
  queries: readonly JsonSchema[],
): ManifestSurface {
  const listed = routes.map(listing).join(', ');
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
        description: queries.length
          ? 'Go to a page of the app, as following a link to it does, already filtered when its address takes a query. The page’s own tools are offered once it is open.'
          : 'Go to a page of the app, as following a link to it does. The page’s own tools are offered once it is open.',
        input: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: `The page’s address, with an id in place of each :parameter (or the route as listed, with params). ${
                queries.length ? 'A page whose address takes a query names its parameters (?name). ' : ''
              }The pages: ${listed}.`,
            },
            params: {
              type: 'object',
              description:
                'Each :parameter of the route by name, when path is written as the route: {"id": "v_1"} for /voices/:id. Encoded for you.',
              additionalProperties: { type: 'string' },
            },
            ...(queries.length
              ? {
                  query: {
                    type: 'object',
                    description:
                      'The page’s filters, by name, as its address takes them: {"view": "declined"} opens ?view=declined. Only the page’s own: each alternative is one page’s, for the routes in its x-routes.',
                    anyOf: [...queries],
                  },
                }
              : {}),
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
