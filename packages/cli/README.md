# @ouispec/cli

The assistant's surfaces and knowledge, generated from a React app's own code (ADR-0220, ADR-0226). A deterministic TypeScript pass (no LLM, no network, no clock) over the app's routes, its page component trees, its design system's bound controls, its room catalogs and its API's OpenAPI document.

```sh
oui generate            # writes <out>/oui-manifest.json and <out>/oui-knowledge.json
oui generate --check    # CI: fails if either is stale, or any declaration is invalid
```

`--config <path>` names the settings file (default `./oui.config.json`). The same command is installed as `closure-oui`.

## `oui.config.json`

Required, and explicit: nothing an app depends on has a default, so a misconfigured app fails naming the setting instead of generating an assistant that can do nothing.

```json
{
  "tsconfig": "tsconfig.json",
  "routes": "src/routes.tsx",
  "routeWrappers": ["Suspense", "ErrorBoundary"],
  "nav": ["src/nav.ts"],
  "shell": [{ "module": "src/app/AppFrame.tsx", "export": "AppFrame" }],
  "designSystem": ["@acme/ui"],
  "mappings": ["oui/mantine-core.mapping.json"],
  "apiSpec": "@acme/api-client/openapi.json",
  "appCatalogs": [{ "module": "src/studio/catalog.ts", "export": "canvasCatalog", "hosts": ["Canvas"] }],
  "unbound": [],
  "out": "src/agent/generated"
}
```

| Setting | Required | Meaning |
|---|---|---|
| `tsconfig` | yes | The tsconfig the app compiles with. |
| `routes` | yes | The file holding the routes: `<Route>` elements, or a data router. |
| `designSystem` | yes | Design-system packages whose controls carry bindings. `[]`: none. |
| `apiSpec` | yes | The API's OpenAPI 3 document, by module path as the installed API client ships it. `null`: the app has no API. |
| `out` | yes | Where the manifest and knowledge are written. |
| `routeWrappers` | no | Components a route's element is wrapped in that are never the page. |
| `nav` | no | Files whose `{ label, route, group }` object literals are the navigation. |
| `shell` | no | The app's frame: components mounted around the pages. Each becomes a `shell:` surface. |
| `mappings` | no | Tier 2 mappings of third-party design systems the app does not own (below). |
| `appCatalogs` | no | Room catalogs the app declares itself. Needs Vite (below). |
| `unbound` | no | Pages whose controls are not all bound yet. It may only shrink. |

`apiClient` was replaced by `apiSpec`.

## Design systems

Each package in `designSystem` must resolve from the app and name its control table in its `package.json`:

```json
{ "oui": { "agentControls": "./dist/agent-controls.json" } }
```

`closure.agentControls` is also read during the transition. A package declaring both is an error. A room package names its catalog the same way, under `oui.agentCatalog` (or `closure.agentCatalog`).

## Third-party design systems (tier 2, ADR-0226 §2.3)

An app on MUI, Mantine or shadcn/Radix maps that design system's controls in a JSON file per package (`tier2-mapping.json` in `@ouispec/contract`: `kind`, `callbacks`, `valueFrom`, `controlled`, `options`, `titleProps`, and `parts` for a control under a namespace or made of parts). For each mapping `oui generate` writes `<out>/bound/<package>.ts` (`@mantine/core` → `mantine-core.ts`) and its control table beside it:

- one wrapper per mapped control, under the package's own export names, built from `@ouispec/bindings/react`: it accepts `agent`, registers the mapped kind with the app's own callback, returns that callback's result, reports `disabled`, and renders the component unchanged (props, ref, static members);
- a namespace (`Select`, `Tabs`) keeps every other member (`Select.Trigger`, `Tabs.List`);
- each export keeps the component's own type, and the module imports `@ouispec/bindings/jsx`, which adds `agent` to JSX.

The app imports mapped controls from the bound module. Each use is read as a tier 1 control's: its binding, title, options (from the prop the mapping names, or from the items a compound control renders) and schema. The program reads the module as this run emits it, so a page resolves it in `--check` and on the first run. A use that does not pass the prop that shows its value (`controlled`) is printed as a warning and returned in `result.tier2.uncontrolled`, beside every use in `result.tier2.uses`, for the conformance kit's `checkTier2`.

## Routes

- JSX: `<Route path element>`, nested routes joined to their parent's path, `index` routes at their parent's path, pathless routes that group their children, `Component` and `lazy` props.
- Data routers: `createBrowserRouter([...])`, `createHashRouter`, `createMemoryRouter`, `createStaticRouter` and `useRoutes`, with `children` (literal or constant arrays), `index`, `element`, `Component` and `lazy: () => import('./route')` route modules (their `Component` export, else their default).
- `lazy(() => import(...))` and `React.lazy(...)`, a default export or `.then(m => ({ default: m.X }))`.
- A route whose element has child routes is a layout: it becomes the `shell:` frame of the pages under it, when it holds anything someone can use.
- Splats (`*`) and redirects (a `<Navigate>`, or a component that only renders one) are not pages.

## What fails the build

- A missing or unknown setting in `oui.config.json`.
- A `designSystem` package that cannot be resolved, declares no control table, or declares both keys.
- On an enforced page: a control with no binding, a raw element someone can use (a `button`, an `input`, or anything with `onClick`, `onChange`, `onInput`, `onSubmit`, `onDoubleClick`, `onPointerDown`, `onMouseDown` or `onKeyDown`), and a component with no control table entry that takes a callback prop, whether from a third-party library or a design-system export the table leaves out. Each is fixed by a bound control, or by `data-non-agent="<reason>"` saying why the assistant never needs it.
- A route the generator cannot read (a path, children or `lazy` that is not known at build time).
- An `apiSpec` that cannot be read or is not OpenAPI 3; a `mutate` or `transaction` naming an `operationId` the document does not have; either in an app with `apiSpec: null`.
- An effect that is not one of the vocabulary's, or a `transaction` whose `approvalMinutes` is not 1–30.
- A control table entry of a kind the table does not register, or a registration that is not valid.
- A room recipe naming an entry the room does not have.
- On an enforced page, a mapped control imported straight from its package (§2.5 row 6): the error names the bound import.
- A mapping that does not match its schema, names a package the app cannot resolve, maps a package also in `designSystem`, maps a package another mapping maps, uses a kind no design system registers, or does not fit the package's types (an export it does not have, a prop its component does not take).
- A stale bound module or control table, or a file in `<out>/bound/` no mapping emits (`--check`; writing removes it).

## Person-only components (ADR-0228)

Some components exist so that the person, and only the person, can do something. The approval card where someone approves an irreversible action is one. A package lists them in its `package.json`, each with the reason:

```json
{ "oui": { "personOnly": { "ApprovalCard": "Only the person approves an irreversible action" } } }
```

On one of these components, the generator fails the build for:
- an `agent` prop, even `{ nonAgent }`;
- a spread of props, which could carry a binding the build cannot see.

What such a component renders is never bound, so its callbacks need no `data-non-agent`. `@ouispec/agent-react` declares `ApprovalCard` this way.

## The contract's vocabulary (ADR-0226 §2.6)

- **Effects.** A binding, a room action and an API tool declare one `ActionEffect`: `view`, `selection`, `navigate`, `open`, `edit`, `file`, `mutate` (an API `operationId`), `job` (settles on its outcome) or `transaction` (irreversible: runs only on the person's approval of the exact call, ADR-0228). `destructive: true` marks a write that removes what the person made.
- **Control kinds.** The built-in kinds are closed. A design system adds an `x-` kind by registering it (`registerControlKind`) and listing the same registration under `$kinds` in its control table, with its schema derivation as data.
- **Rooms.** A field animates only when it declares `animation: { keyframeable: true }`. A room may declare its own `problems` kinds and `recipes`; recipes name the room's entries with `{action:<id>}`, `{command:<id>}`, `{field:<id>}`, `{keyframeable}` and `{room}`. The generator infers no recipe.

## App room catalogs need Vite

A catalog in `appCatalogs` is code: its entries may be built by functions, and its imports resolve only as the app's build resolves them. The generator loads each one through the app's own Vite config (`vite` must be in the app's own `node_modules`) and keeps only its declarations. An app without Vite ships its catalog in a package under `oui.agentCatalog` instead, as plain data.
