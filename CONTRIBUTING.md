# Contributing

1. Branch from `main` and open a pull request into it.
2. Keep each package's tests next to its code, and add the test that fails without your change.
3. Before pushing, run what CI runs: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm packs:check`, and `pnpm smoke --dir <an empty directory>`. The pre-commit hook lints the staged files and typechecks, tests and builds every package your change touches.
4. If a published package changes, add a changeset and apply it in the same pull request (`pnpm changeset`, then `pnpm version-packages`). [VERSIONING.md](VERSIONING.md) says whether it is a patch or a minor.
5. A change to the OUI protocol also updates [the specification](packages/oui-spec/spec/OUI-SPEC-v0.1.md). A change to a schema also updates the contract's guide, and regenerates its types and guide (`pnpm --filter @ouispec/contract generate`).

Releases are tagged on `main` by the maintainers: see [RELEASING.md](RELEASING.md).
