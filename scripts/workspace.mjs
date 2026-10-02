/**
 * The workspace's packages, read once for the release scripts: each
 * `packages/<dir>/package.json` with its directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository every published package names, and npm's provenance checks against. */
export const REPOSITORY_URL = 'git+https://github.com/wesreid/oui.git';

/** @returns {{ dir: string, path: string, pkg: Record<string, any> }[]} */
export function workspacePackages() {
  const base = join(ROOT, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map(entry => ({
      dir: `packages/${entry.name}`,
      path: join(base, entry.name),
      pkg: JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8')),
    }))
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/** The packages that publish: every workspace package not marked private. */
export function publishedPackages() {
  return workspacePackages().filter(entry => !entry.pkg.private);
}
