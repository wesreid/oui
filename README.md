# OUI

**The open contract for agent-controllable user interfaces.** An application declares what its UI can do, what a person can see in it and what each operation takes; an agent reads that declaration and acts through typed calls, with no screenshots, DOM scraping or guessing. Everything here is MIT-licensed and published to the public npm registry from this repository's CI, with provenance.

| Package | What it is |
|---|---|
| [`oui-spec`](packages/oui-spec) | The OUI specification and its runtime: surfaces, actions, observations, the answer to every action request, and approvals for irreversible actions. |

[The OUI specification](packages/oui-spec/spec/OUI-SPEC-v0.1.md) is the protocol; [`oui-spec`'s README](packages/oui-spec/README.md) explains it with examples.

## Installing

```sh
npm install oui-spec
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
pnpm test         # agent-realtime's tests use REDIS_URL, or start a local redis-server
pnpm site         # the documentation site, into site/
```

A change to a published package carries a changeset, applied in the same pull request (`pnpm changeset`, then `pnpm version-packages`). A `v*` tag on `main` publishes every version that isn't on npm yet: see [RELEASING.md](RELEASING.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
