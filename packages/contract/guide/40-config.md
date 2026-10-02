## `oui.config.json`

The generator reads every setting from `oui.config.json` at the app's root; paths are relative to it (ADR-0226 §2.4). Nothing an app depends on has a default: a missing `tsconfig`, `routes`, `designSystem`, `apiSpec` or `out` is an error naming the setting, and so is a setting the generator does not know. `designSystem: []` says every control is tier 2 or in a room; `apiSpec: null` says the app has no API, and then a `mutate` effect fails.

```json
{
  "$schema": "https://schemas.closurestudio.ai/oui/v1/oui-config.json",
  "tsconfig": "tsconfig.json",
  "routes": "src/routes.tsx",
  "routeWrappers": ["Suspense", "ErrorBoundary"],
  "nav": ["src/nav.ts"],
  "shell": [{ "module": "src/app/AppFrame.tsx", "export": "AppFrame" }],
  "designSystem": ["@acme/ui"],
  "apiSpec": "@acme/api-client/openapi.json",
  "appCatalogs": [{ "module": "src/strategy/catalog.ts", "export": "strategyCanvasCatalog", "hosts": ["StrategyCanvas"] }],
  "unbound": [],
  "out": "src/agent/generated"
}
```

`apiSpec` names the OpenAPI 3 document inside the installed API client package, never a sibling checkout, so the generator reads exactly the spec of the client version the app installs. Every `mutate` effect names one of its `operationId`s.

<!-- schema: oui-config.json -->
