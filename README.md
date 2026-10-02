# OUI

**The open contract for agent-controllable user interfaces.** An application declares what its UI can do, what a person can see in it and what each operation takes; an agent reads that declaration and acts through typed calls, with no screenshots, DOM scraping or guessing. Everything here is MIT-licensed and published to the public npm registry from this repository's CI, with provenance.

| Package | What it is |
|---|---|
| [`oui-spec`](packages/oui-spec) | The OUI specification and its runtime: surfaces, actions, observations, the answer to every action request, and approvals for irreversible actions. |
| [`@ouispec/contract`](packages/contract) | The integrator contract: the JSON Schemas a product builds against, the TypeScript types generated from them, a validator, and [the integrator guide](packages/contract/INTEGRATOR-GUIDE.md). |
| [`@ouispec/bindings`](packages/bindings) | The binding a design-system control carries, the room catalog, the registry of what is mounted, and `connectBindings`, which turns it into the tab's OUI surfaces. |
| [`@ouispec/cli`](packages/cli) | The generator: `oui generate [--check]` writes an app's surfaces and knowledge from its code, deterministically. |
| [`@ouispec/testing`](packages/testing) | The conformance kit: checks a design system, an app or a tier 2 mapping against the contract, in your own test runner. |
| [`@ouispec/agent-core`](packages/agent-core) | What the agent SDK shares: the turn protocol, tool and entity types, approval types. |
| [`@ouispec/agent-events`](packages/agent-events) | Event contracts the product declares, and the catalog the server, the worker and the UI follow. |
| [`@ouispec/agent-worker`](packages/agent-worker) | The agent: runs a turn with any `ai` model, UI tools from the tab's surfaces, API tools generated from an OpenAPI document, approvals. Lambda + SQS and container adapters. |
| [`@ouispec/agent-realtime`](packages/agent-realtime) | The realtime server between the agent and the browser: rooms, room tokens, UI action results, approvals, declared events. |
| [`@ouispec/agent-react`](packages/agent-react) | The agent in a React app: the provider, the chat hooks, the approval card. |
| [`@ouispec/agent-mcp`](packages/agent-mcp) | A Model Context Protocol server for the generated API tools, each call as the client's own principal. |

A product supplies the seams (its model, auth, persistence, event declarations, OpenAPI document, persona) and the packages supply the rest: start with [the integrator guide](packages/contract/INTEGRATOR-GUIDE.md).

[The OUI specification](packages/oui-spec/spec/OUI-SPEC-v0.1.md) is the protocol; [`oui-spec`'s README](packages/oui-spec/README.md) explains it with examples.

## Installing

```sh
# the UI side of a React product
npm install oui-spec @ouispec/bindings @ouispec/agent-react
npm install --save-dev @ouispec/cli @ouispec/testing

# the server side
npm install @ouispec/agent-worker @ouispec/agent-realtime @ouispec/agent-events
```

Every package is published from this repository by CI, with an npm provenance statement that links the tarball to the commit and workflow that built it. Check one with `npm audit signatures`.

## Versions

Every package is 0.x until the first product outside Closure Studio runs on it in production: in 0.x a minor release may break, and a patch release does not. [VERSIONING.md](VERSIONING.md) is the whole policy, and each package's `CHANGELOG.md` says what changed in every release.

## Working in this repository

```sh
pnpm install
pnpm build        # every package, in dependency order
pnpm typecheck
pnpm lint
pnpm test         # the realtime and worker tests start their own redis-server (or use REDIS_URL)
pnpm smoke --dir /tmp/oui-smoke   # the packed tarballs, installed and used as an outside product would
pnpm site         # the documentation site, into site/
```

A change to a published package carries a changeset, applied in the same pull request (`pnpm changeset`, then `pnpm version-packages`). A `v*` tag on `main` publishes every version that isn't on npm yet: see [RELEASING.md](RELEASING.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
