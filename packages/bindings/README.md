# @ouispec/bindings

Every UI capability declared once, in the code that implements it. A design-system control carries a binding (an id, a label, a description, and an input schema derived from its props) and registers its real handler under it, so the agent and the person go through the same code path.

```sh
npm install @ouispec/bindings
```

| Entry | What it has |
|---|---|
| `@ouispec/bindings` | The binding and control-table types, action effects (`effectKind`, `effectAccess`, `requiresApproval`), the room catalog contract, the generated manifest and knowledge and how they're read, and the registry of what is mounted. No dependencies on React, so the build-time generator reads it in plain Node. |
| `@ouispec/bindings/react` | `AgentBindingProvider`, `useAgentBinding`, `useAgentBindings`, `useRoomRegistration`, `useAgentProblems`, `useAgentFacts`. |
| `@ouispec/bindings/oui` | `connectBindings`, which turns what is mounted into the tab's OUI surfaces (given the build's `knowledge`, it also answers the assistant's app-wide search and page guide, `oui.find` and `oui.guide`, in the tab), and `createDeclaredJobTracker`, which follows a job on the product's declared events. |

### One build, several brands

A build whose config names `routeGates` (`@ouispec/cli`) records each route's gates. The tab says which gates the session's person has, as a predicate, and everything the assistant is told of the app is the build as that person sees it:

```ts
const allows = (gate: string) => brand.features.has(gate);
connectBindings({ registry, runtime, manifest, knowledge, navigation, allows }); // app_navigate, ui_find, ui_guide { page }
const uiKnowledge = resolveKnowledge(knowledge, location.pathname, { allows }); // the map and the page's knowledge, sent with the turn
```

A route is open when every one of its gates is allowed, and a page when any of its routes is. A page the session may not see is then named nowhere the assistant reads: not in any surface's, action's or observation's description, not in the navigation action, not in a page's entries, relationships or recipes, not in the map, and not in what `oui.find` and `oui.guide` answer. A sentence that names it by its route or an address on it is left out, and a list of routes loses it (`scopeText`); a control that only goes to it is not offered. `scopeKnowledge` and `scopeManifest` give the whole build as a session sees it, and `appMapContent` renders the map's lines. Without `allows`, or for a build with no gates, nothing changes.

A design system declares its control table in `package.json` under `oui.agentControls`; a room names its catalog under `oui.agentCatalog`. `@ouispec/cli` generates an app's surfaces and knowledge from them, and `@ouispec/testing` checks that a design system keeps the contract.

An app must have exactly one copy of this package and of `oui-spec`: two copies split the registry, and the agent sees no controls.

Start with [the integrator guide](https://github.com/wesreid/oui/blob/main/packages/contract/INTEGRATOR-GUIDE.md).
