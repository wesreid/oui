# Versioning

Every package in this repository follows [semantic versioning](https://semver.org/), with the rules below on top. CI holds a pull request to them (`pnpm packs:check`, `pnpm release:check`), and so does the contract's own test suite.

## Everything is 0.x until the first outside product is live

No package releases 1.0 until a product built outside Closure Studio runs on these packages in production. Until then:

- a **minor** release (0.**Y**.0) may break: a removed or renamed export, a changed schema, a seam that becomes required;
- a **patch** release (0.Y.**Z**) never breaks;
- so pin a minor: `^0.Y.Z` admits exactly the releases that can't break you.

The pull request that releases 1.0 removes the 0.x rule from `scripts/verify-packs.mjs` and this section.

## The contract's major follows `MANIFEST_VERSION`

`@ouispec/contract` holds the JSON Schemas everything else is built against: the control table, the tier 2 mapping, the binding, the action effect, the room catalog, the manifest, the knowledge, `oui.config.json`, approvals and event declarations. They are versioned together by one number, `MANIFEST_VERSION`, which every generated manifest carries and which names the schemas' `$id` path (`…/oui/v<MANIFEST_VERSION>/<file>`).

- **From 1.0, the contract's major is `MANIFEST_VERSION`.** A breaking change to any schema bumps `MANIFEST_VERSION`, the `$id` path and the contract's major together, in one release.
- **Before 1.0, `MANIFEST_VERSION` is 1**, and a breaking schema change is a minor release of the contract, like any other 0.x break. 1.0.0 is released with `MANIFEST_VERSION` 1.
- The contract's tests fail a version that breaks either rule.

`@ouispec/bindings`, `@ouispec/cli` (the generator) and `@ouispec/testing` (the conformance kit) read and write what the contract defines, so they are *linked* with it: when they release together they share a version.

## The conformance kit is the compatibility gate

`@ouispec/testing` checks a design system, an app or a tier 2 mapping against the contract: what it ships, what it declares, and what its controls do when the agent uses them. **Something that passes the kit of a contract major works with every package of that major.** A product pins the contract major, runs the kit in its own CI, and takes every release within the major.

## The agent SDK moves as one

`@ouispec/agent-core`, `-events`, `-worker`, `-realtime`, `-react` and `-mcp` are linked: a release that bumps several of them gives them one version, so a product installs one version of the whole SDK.

## `oui-spec`

`oui-spec` is the protocol and its runtime. Its version is its own: a change to the protocol a client and a runtime must agree on is a minor release while it is 0.x. The packages that use it depend on a range, so a product has one copy of it.

## Dependencies between the packages

- Each package depends on the others with a caret range on the version it was built with (`^0.Y.Z`), so a product that takes the latest release of each has exactly one copy of each. Two copies of `oui-spec` or `@ouispec/bindings` in one app would split its registry, and the agent would see no controls.
- Peer dependencies are written as a range over the whole 0.x line (`>=0.Y.Z <1.0.0`), so a release of the peer never forces a release of the package that names it.

## Changelogs

Each package's `CHANGELOG.md` is written from the changesets of the pull requests that changed it, and each release's GitHub release carries its entry.
