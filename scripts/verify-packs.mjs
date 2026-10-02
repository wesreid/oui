#!/usr/bin/env node
/**
 * What each published package would put on npm, checked before anything is
 * published (run after `pnpm build`):
 *
 * - its name is `oui-spec` or in the `@ouispec` scope;
 * - it is MIT, and its tarball carries LICENSE and README.md;
 * - it names this repository and its own directory, which npm's provenance
 *   statement is checked against;
 * - it publishes publicly, with provenance;
 * - every file its `main`, `module`, `types`, `exports` and `bin` name is in
 *   the tarball;
 * - it is still 0.x: every package stays pre-1.0 until the first outside
 *   product is live (VERSIONING.md). The pull request that releases 1.0
 *   removes this rule.
 */
import { execFileSync } from 'node:child_process';
import { REPOSITORY_URL, publishedPackages } from './workspace.mjs';

const problems = [];

/** Every file path an `exports` value names, wildcard entries as their fixed prefix. */
function exportTargets(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) exportTargets(nested, out);
  return out;
}

const normalise = path => path.replace(/^\.\//, '');

for (const { dir, path, pkg } of publishedPackages()) {
  const name = pkg.name;
  const fail = message => problems.push(`${name}: ${message}`);

  if (name !== 'oui-spec' && !name.startsWith('@ouispec/')) fail('publishes outside oui-spec and the @ouispec scope');
  if (pkg.license !== 'MIT') fail(`license is ${JSON.stringify(pkg.license)}, not MIT`);
  if (pkg.repository?.url !== REPOSITORY_URL) fail(`repository.url is not ${REPOSITORY_URL}`);
  if (pkg.repository?.directory !== dir) fail(`repository.directory is not ${dir}`);
  if (pkg.publishConfig?.access !== 'public') fail('publishConfig.access is not "public"');
  if (pkg.publishConfig?.provenance !== true) fail('publishConfig.provenance is not true');
  if (!/^0\.\d+\.\d+/.test(pkg.version)) fail(`is ${pkg.version}: every package stays 0.x until the first outside product is live`);

  const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: path, encoding: 'utf8' }));
  const files = new Set(report.files.map(file => file.path));
  for (const required of ['LICENSE', 'README.md', 'package.json']) if (!files.has(required)) fail(`the tarball has no ${required}`);

  const named = [
    pkg.main,
    pkg.module,
    pkg.types,
    ...exportTargets(pkg.exports),
    ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})),
  ].filter(Boolean);
  for (const target of named.map(normalise)) {
    if (target.includes('*')) {
      const prefix = target.slice(0, target.indexOf('*'));
      if (![...files].some(file => file.startsWith(prefix))) fail(`nothing in the tarball matches ${target}`);
    } else if (!files.has(target)) {
      fail(`names ${target}, which is not in the tarball (built?)`);
    }
  }
  console.log(`${name}@${pkg.version}: ${files.size} files`);
}

if (problems.length > 0) {
  console.error(`package check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
