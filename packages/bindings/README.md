# @ouispec/bindings

Every UI capability declared once, in the code that implements it. A design-system control carries a binding (an id, a label, a description, and an input schema derived from its props) and registers its real handler under it, so the agent and the person go through the same code path.

```sh
npm install @ouispec/bindings
```

| Entry | What it has |
|---|---|
| `@ouispec/bindings` | The binding and control-table types, action effects (`effectKind`, `effectAccess`, `requiresApproval`), the room catalog contract, the generated manifest and knowledge and how they're read, and the registry of what is mounted. No dependencies on React, so the build-time generator reads it in plain Node. |
| `@ouispec/bindings/react` | `AgentBindingProvider`, `useAgentBinding`, `useAgentBindings`, `useRoomRegistration`, `useAgentProblems`, `useAgentFacts`. |
| `@ouispec/bindings/oui` | `connectBindings`, which turns what is mounted into the tab's OUI surfaces, and `createDeclaredJobTracker`, which follows a job on the product's declared events. |

A design system declares its control table in `package.json` under `oui.agentControls`; a room names its catalog under `oui.agentCatalog`. `@ouispec/cli` generates an app's surfaces and knowledge from them, and `@ouispec/testing` checks that a design system keeps the contract.

An app must have exactly one copy of this package and of `oui-spec`: two copies split the registry, and the agent sees no controls.

Start with [the integrator guide](https://github.com/wesreid/oui/blob/main/packages/contract/INTEGRATOR-GUIDE.md).
