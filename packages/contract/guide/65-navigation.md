## Going to a page, already filtered

The generator gives every build one navigation surface, `app:navigation`, with one action, `app.navigate` (tool `app_navigate`): go to a page by its address, as following a link does. Its `path` lists every page's route with its title. `connectBindings({ navigation })` runs it with the app's router.

A list page that keeps its filters in its address (`/dashboard/service-lane?view=declined&period=this_month`) can be opened by the assistant exactly as the person asked, in one call, when the page declares the query it reads. The page declares it once, where it reads it:

```ts
import { defineQuery, readQuery, writeQuery } from '@ouispec/bindings';

export const LANE_QUERY = defineQuery({
  view: { values: LANE_VIEWS, default: 'lane', description: 'The open lane, or closed repair orders with declined work' },
  period: { values: DECLINED_PERIODS, default: 'this_month', description: 'The declined list’s period' },
  advisor: { type: 'string', description: 'A service advisor, by name as the lane shows it' },
  page: { type: 'integer', minimum: 1, default: 1, description: 'The page of the list' },
});

function ServiceLanePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = readQuery(LANE_QUERY, searchParams); // { view: 'lane' | 'declined', period, advisor?: string, page: number }
  const setView = (view: string) => setSearchParams(writeQuery(LANE_QUERY, searchParams, { view, page: undefined }));
  // …
}
```

- `values` is the option list the page's select or tabs already render: strings, or `{ value, label, description }`. Other kinds are `type: 'string'` (free text), `'integer'` or `'number'` (with `minimum`, `maximum`, `unit`), `'boolean'` (`1` on, `0` off) and `'date'` (`YYYY-MM-DD`). `multiple: true` takes several, comma-separated.
- `readQuery` reads the address as the declaration says: a value the page does not take falls back to its `default` (or is left out), so a hand-edited address never breaks the page. `writeQuery` writes changes back and leaves out a default or empty value, so the plain address stays plain.
- The generator finds `readQuery(<a defineQuery constant>, …)` in the page, in a component it renders, or in an app hook they call, and fails the build when the declaration is not a build-time constant or does not match the schema below, or when two declarations on one page give the same parameter different meanings.

What the build then offers:

- `app.navigate` takes `query` beside `path`: one alternative per page that declares one, each with `x-routes` naming its routes and a property per parameter (`enum` and meanings, range, default). `path` names the parameters beside each such page (`/dashboard/service-lane (Service lane; ?view, ?period, ?advisor, ?page)`), and the page's knowledge lists them.
- `params` fills a route's `:parameters` when `path` is written as its route (`{ "path": "/dashboard/inventory/:unitId", "params": { "unitId": "u 7" } }` goes to `/dashboard/inventory/u%207`).
- The runtime builds the address from the path, `params` and `query`, encoding each part. It refuses a path that is not one of the build's routes, one that could leave the app (`//host`, a backslash, a scheme, `.` or `..` segments), a query parameter a declaring page does not take, and a value it does not accept, naming what the page takes. A query in `path` itself (`?view=declined`) is read the same way. A page that declares no query takes its address as before.
- Going to the address the person is already on does nothing, and says so (`alreadyThere`).
- A page known only by its manifest reads its address the same way: `pageQueryOf` reads a page's alternative of `query` back into the declaration `readQuery` and `writeQuery` take (its values, ranges and defaults; a choice's labels are not in it), so a test page shows the filters the address holds (an eval's `controls` bound by `query`). `generatedNavigationSurface` is the navigation surface the generator emits, for a page made without a manifest.

<!-- schema: page-query.json -->

<!-- schema: page-query.json#/$defs/QueryChoice -->
