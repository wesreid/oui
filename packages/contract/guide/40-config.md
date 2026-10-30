## `oui.config.json`

The generator reads every setting from `oui.config.json` at the app's root; paths are relative to it. Nothing an app depends on has a default: a missing `tsconfig`, `routes`, `designSystem`, `apiSpec` or `out` is an error naming the setting, and so is a setting the generator does not know. `designSystem: []` says every control is tier 2 or in a room; `apiSpec: null` says the app has no API, and then a `mutate` effect fails.

```json
{
  "$schema": "https://schemas.closurestudio.ai/oui/v1/oui-config.json",
  "tsconfig": "tsconfig.json",
  "routes": "src/routes.tsx",
  "routeWrappers": ["Suspense", "ErrorBoundary"],
  "nav": ["src/nav.ts"],
  "shell": [{ "module": "src/app/AppFrame.tsx", "export": "AppFrame" }],
  "designSystem": ["@acme/ui"],
  "mappings": ["oui/mantine-core.mapping.json"],
  "apiSpec": "@acme/api-client/openapi.json",
  "appCatalogs": [{ "module": "src/strategy/catalog.ts", "export": "strategyCanvasCatalog", "hosts": ["StrategyCanvas"] }],
  "unbound": [],
  "outside": [
    { "component": "SignInPage", "reason": "before sign-in" },
    { "route": "/share/:token", "reason": "a public share link, opened signed out" }
  ],
  "out": "src/agent/generated"
}
```

`shell` names the app's frame where no route renders it (a layout route's element is one without being named), each part on the routes it is given (`routes`, default every page). A frame, and a component the pages share, says where it is in its description: on every page, or on every page under one path (`/dashboard`) when it is on all of them and on more than three, else the routes themselves. The manifest's `routes` list them all either way.

`apiSpec` names the OpenAPI 3 document inside the installed API client package, never a sibling checkout, so the generator reads exactly the spec of the client version the app installs. Every `mutate` effect names one of its `operationId`s.

`outside` names the pages the assistant is never on: pages before sign-in, and public pages a link opens. Each names its page by component or by route, with the reason. An outside page has no surface, its controls are not enforced, the assistant is not offered it as a page to go to, and the knowledge says the assistant is not there. A page is outside only when nothing around it or in it is the assistant's, so the list cannot hide a page of the app:

- no `shell` entry frames any of its routes;
- every element its routes render around it, a layout route's or a `routeWrappers` component's at any level, holds nothing someone can use (no control, bound or not, no display, no room) and no person-only component, which is how the assistant's own UI is declared;
- the page does not render the app's frame itself;
- the page has no binding, display or room of its own, on no page the assistant is on. One a component shares with pages the assistant is on is that component's, offered there.

A page in the app's frame fails the first three, and a page that binds anything only for itself fails the last. `unbound` is for pages the assistant is on that are not bound yet; a page is never in both lists.

`mappings` lists the app's tier 2 mappings; each emits a bound module into `<out>/bound/` (see [Tier 2](#tier-2-a-design-system-you-do-not-own)).

<!-- schema: oui-config.json -->
