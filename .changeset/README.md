# Changesets

Every change to a published package carries a changeset, and the same pull request versions it:

```sh
pnpm changeset            # say which packages change, how (patch / minor), and why
pnpm version-packages     # apply it: bump versions, write CHANGELOG.md, update the lockfile
```

Commit both. A pull request that changes a package without bumping its version, or that leaves an unapplied changeset here, fails CI (`pnpm release:check`). Releasing is a `v*` tag on `main`: see [RELEASING.md](../RELEASING.md).
