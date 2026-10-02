# @ouispec/agent-core

What the rest of the agent SDK shares: the turn protocol's event names and payload types, the schema and entity types a product's tools are declared with, intent resolution, the UI-surface types a tab sends with a turn, and the approval types and `argsHash` an irreversible call is bound by.

```sh
npm install @ouispec/agent-core
```

It has no runtime of its own. `@ouispec/agent-worker` (the agent), `@ouispec/agent-realtime` (the server between the agent and the browser) and `@ouispec/agent-react` (the browser) build on it, and all four release together under one version.

- The turn events come from `@ouispec/agent-events`, and the approval messages from `@ouispec/contract`'s `approvals.json`.
- `argsHash` and the approval rules are `oui-spec`'s. `@ouispec/agent-core/approval-vectors.json` re-exports its test vectors, so an engine in another language can hold its own hash to them.

See [the integrator guide](https://github.com/wesreid/oui/blob/main/packages/contract/INTEGRATOR-GUIDE.md) for how the pieces fit, and [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md) for what a release may change.
