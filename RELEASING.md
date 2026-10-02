# Releasing

Packages are published to the public npm registry by CI only, never from a laptop, and every tarball carries an npm provenance statement naming the commit and the workflow that built it.

## 1. In the pull request: decide the versions

A pull request that changes a published package carries a changeset and applies it:

```sh
pnpm changeset            # which packages, patch or minor (see VERSIONING.md), and a line for the changelog
pnpm version-packages     # bumps the versions, writes each CHANGELOG.md entry, updates the lockfile
```

Commit the result. CI fails a pull request that leaves a changeset unapplied, changes a package's shipped source without a new version, or moves a version backwards (`pnpm release:check`), and checks every tarball's contents (`pnpm packs:check`). So `main` always holds exactly the versions the next release publishes.

## 2. On main: tag the release

```sh
git tag v2026.10.02 origin/main     # vYYYY.MM.DD; a second release that day is vYYYY.MM.DD.2
git push origin v2026.10.02
```

The tag names when, not what. [`release.yml`](.github/workflows/release.yml) then:

1. refuses a tag that isn't on a commit of `main`;
2. runs the whole build, the tests, the package check and the release check on the tagged commit;
3. publishes every package whose version isn't on npm yet (`changeset publish`), with provenance, using the repository secret `OUISPEC_SCOPE_TOKEN` in the `npm-publish` environment;
4. pushes a tag per published version (`<name>@<version>`) and opens a GitHub release with its changelog entry.

A version already on npm is skipped, so tagging again after a partial failure publishes only what is missing.

## The token

`OUISPEC_SCOPE_TOKEN` is an npm automation token that can publish the `@ouispec` scope and `oui-spec`. The release job prints the account it publishes as (`npm whoami`) and never the token. When it is rotated, replace the repository secret; nothing else names it.

## The documentation site

[`pages.yml`](.github/workflows/pages.yml) builds the site from the repository's Markdown and schemas (`pnpm site`) on every push to `main`, and publishes it to GitHub Pages once Pages is set to deploy from Actions.
