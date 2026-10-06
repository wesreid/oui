#!/usr/bin/env node
/**
 * Every release is decided in a pull request, so `main` always holds the
 * versions a `v*` tag publishes (RELEASING.md). This check holds a pull
 * request, and `main`, to that:
 *
 * 1. No unapplied changeset: a changeset is applied (`pnpm version-packages`)
 *    in the pull request that adds it, so the bump and its CHANGELOG entry are
 *    reviewed with the change.
 * 2. With `--base <ref>`: every published package whose shipped source changed
 *    since `<ref>` has a new version, and no version goes backwards. Tests,
 *    evals and test configuration are not shipped, so changing only them needs
 *    no release.
 * 3. No published package is left depending on an old release of another. A
 *    package still at the version its release tag (`<name>@<version>`) records
 *    was published with each `workspace:` dependency resolved to that
 *    dependency's version then. When the dependency has since moved outside
 *    that range, the package must be released again; otherwise an app that
 *    takes the latest of everything installs a second, older copy of the
 *    dependency through it (@ouispec/cli 0.3.0 kept `@ouispec/bindings ^0.2.3`
 *    after bindings 0.3 was released). Needs the release tags (CI checks out
 *    with `fetch-depth: 0`).
 *
 *   node scripts/release-check.mjs                  # (1) only
 *   node scripts/release-check.mjs --base origin/main
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, publishedPackages } from './workspace.mjs';

/** Paths inside a package that never reach its tarball. */
const NOT_SHIPPED = [
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.test-d\.ts$/,
  /(^|\/)evals\//,
  /(^|\/)vitest(\.[a-z]+)?\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig\.test\.json$/,
  /(^|\/)CHANGELOG\.md$/,
];

const problems = [];

const pending = readdirSync(join(ROOT, '.changeset')).filter(name => name.endsWith('.md') && name !== 'README.md');
if (pending.length > 0) {
  problems.push(
    `unapplied changeset${pending.length > 1 ? 's' : ''} in .changeset/: ${pending.join(', ')}. ` +
      'Run `pnpm version-packages` and commit the bumped versions and CHANGELOG entries.',
  );
}

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
if (baseIndex !== -1 && !base) problems.push('--base needs a git ref');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** [major, minor, patch] of a plain x.y.z version; prereleases compare by their core. */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`not a version: ${version}`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

if (base) {
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  // Each package at the base, by name, wherever it was: a package that moved
  // keeps its version line.
  const atBase = new Map();
  for (const path of git('ls-tree', '-r', '--name-only', mergeBase).split('\n')) {
    if (!/^(packages\/[^/]+\/)?package\.json$/.test(path)) continue;
    const pkg = JSON.parse(git('show', `${mergeBase}:${path}`));
    if (pkg.name) atBase.set(pkg.name, pkg);
  }
  for (const { dir, pkg } of publishedPackages()) {
    const before = atBase.get(pkg.name);
    if (!before) continue; // new in this change: its first version is whatever it declares
    const shipped = git('diff', '--name-only', mergeBase, 'HEAD', '--', dir)
      .split('\n')
      .filter(Boolean)
      .map(path => path.slice(dir.length + 1))
      .filter(path => !NOT_SHIPPED.some(pattern => pattern.test(path)));
    const order = compare(pkg.version, before.version);
    if (order < 0) problems.push(`${pkg.name} goes back from ${before.version} to ${pkg.version}`);
    if (shipped.length > 0 && order === 0) {
      problems.push(
        `${pkg.name} changes ${shipped.slice(0, 5).join(', ')}${shipped.length > 5 ? `, and ${shipped.length - 5} more` : ''} ` +
          `but is still ${pkg.version}: add a changeset (\`pnpm changeset\`) and apply it (\`pnpm version-packages\`).`,
      );
    }
  }
}

// (3) Published packages that still depend on an old release of another.
const tags = new Set(git('tag', '--list').split('\n').filter(Boolean));
if (![...tags].some(tag => tag.includes('@'))) {
  problems.push('no release tags (`<name>@<version>`) in this clone: fetch them (`git fetch --tags`) so stale dependencies can be checked');
}

/** Whether `version` is inside the range `workspace:<kind>` resolved to against `at` when published. */
function admits(kind, at, version) {
  const [a, b, c] = parts(at);
  const [x, y, z] = parts(version);
  if (kind === '*' || kind === '') return a === x && b === y && c === z;
  if (compare(version, at) < 0) return false;
  if (kind === '~') return a === x && b === y;
  // ^: the left-most non-zero part is fixed.
  if (a > 0) return x === a;
  if (b > 0) return x === 0 && y === b;
  return x === 0 && y === 0 && z === c;
}

const current = new Map(publishedPackages().map(({ pkg }) => [pkg.name, pkg.version]));
for (const { dir, pkg } of publishedPackages()) {
  const tag = `${pkg.name}@${pkg.version}`;
  if (!tags.has(tag)) continue; // not released yet at this version: it is published with today's versions
  const atTag = name => {
    for (const path of git('ls-tree', '-r', '--name-only', tag).split('\n')) {
      if (!/^packages\/[^/]+\/package\.json$/.test(path)) continue;
      const other = JSON.parse(git('show', `${tag}:${path}`));
      if (other.name === name) return other.version;
    }
    return undefined;
  };
  const published = JSON.parse(git('show', `${tag}:${dir}/package.json`));
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(published[field] ?? {})) {
      const match = /^workspace:([\^~*]?)/.exec(String(range));
      const now = current.get(name);
      if (!match || !now) continue;
      const then = atTag(name);
      if (!then || admits(match[1], then, now)) continue;
      const resolved = `${match[1] === '*' ? '' : match[1]}${then}`;
      problems.push(
        `${pkg.name} ${pkg.version} was published depending on ${name} ${resolved}, which ${name} ${now} is outside: ` +
          `release ${pkg.name} again (a patch changeset, applied) so it depends on the current release.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`release check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(base ? `release check passed against ${base}` : 'release check passed: no unapplied changesets');
