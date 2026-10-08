#!/usr/bin/env node
/**
 * The packages as a product outside this repository gets them: installed with
 * npm into an empty directory, with an npm configuration that names only the
 * public registry and holds no credentials, then used.
 *
 *   node scripts/consumer-smoke/run.mjs --dir <empty dir> [--from tarballs|registry]
 *
 * - `--from tarballs` (the default, and what CI runs): packs every package of
 *   this workspace and installs the tarballs, so a release is tried as a
 *   consumer would get it before it is published.
 * - `--from registry`: installs the workspace's versions from
 *   registry.npmjs.org, to prove a published release.
 *
 * What runs in it:
 * - `entries.test.ts`: every entry point, the contract, the generator's
 *   command, one copy of each package;
 * - the worker's fixture product, unchanged but for importing the installed
 *   packages: a product with its own users, rooms and events, whose tab
 *   answers a UI action through `oui-spec`, on the real realtime server (it
 *   needs Redis: `REDIS_URL`, or a `redis-server` on the PATH) and both worker
 *   adapters, with two providers' recorded model responses.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, publishedPackages } from '../workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const option = name => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const dirArg = option('--dir');
const from = option('--from') ?? 'tarballs';
if (!dirArg || !['tarballs', 'registry'].includes(from)) {
  console.error('usage: run.mjs --dir <empty dir> [--from tarballs|registry]');
  process.exit(2);
}
const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });
if (readdirSync(dir).length > 0) {
  console.error(`${dir} is not empty`);
  process.exit(2);
}

const packages = publishedPackages();
const worker = packages.find(entry => entry.pkg.name === '@ouispec/agent-worker');

// Where each package comes from.
let specs;
if (from === 'tarballs') {
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs);
  for (const entry of packages) {
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], { cwd: entry.path, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const files = readdirSync(tarballs);
  specs = Object.fromEntries(
    packages.map(({ pkg }) => {
      const file = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
      if (!files.includes(file)) throw new Error(`pnpm pack wrote no ${file}`);
      return [pkg.name, `file:./tarballs/${file}`];
    }),
  );
} else {
  specs = Object.fromEntries(packages.map(({ pkg }) => [pkg.name, pkg.version]));
}

// What the copied tests import besides the packages: the worker's own test dependencies.
const testDeps = Object.fromEntries(
  Object.entries(worker.pkg.devDependencies).filter(([name, range]) => !range.startsWith('workspace:') && !name.startsWith('@types/') && name !== 'typescript'),
);

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: 'ouispec-consumer-smoke',
      private: true,
      type: 'module',
      scripts: { test: 'vitest run' },
      dependencies: { ...specs, react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: testDeps,
      // From tarballs, the packages' dependencies on each other resolve to the tarballs too.
      ...(from === 'tarballs' ? { overrides: specs } : {}),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
writeFileSync(
  join(dir, 'vitest.config.ts'),
  "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 } });\n",
);

// The tests: the entry points, and the worker's fixture product on the installed packages.
const test = join(dir, 'test');
mkdirSync(join(test, 'fixtures'), { recursive: true });
cpSync(join(HERE, 'entries.test.ts'), join(test, 'entries.test.ts'));
cpSync(join(ROOT, 'packages/testing/__tests__/fixtures/tier2/mapping.json'), join(test, 'fixtures/tier2-mapping.json'));
const workerTests = join(worker.path, 'src/__tests__');
cpSync(join(workerTests, 'fixtures/fixture-turn.bedrock.json'), join(test, 'fixtures/fixture-turn.bedrock.json'));
mkdirSync(join(test, 'support'));
const copied = ['fixture-turn.e2e.test.ts', ...readdirSync(join(workerTests, 'support')).map(name => `support/${name}`)];
for (const name of copied) {
  const source = readFileSync(join(workerTests, name), 'utf8');
  // The worker's own modules, imported by path in its repository, are the installed package here: its test
  // support from its `testing` entry, everything else from its main one.
  const text = source
    .replace(/from '(?:\.\.\/)+testing\/[\w/.-]+\.js'/g, "from '@ouispec/agent-worker/testing'")
    .replace(/from '(?:\.\.\/)+(?!fixtures\/)[\w/.-]+\.js'/g, "from '@ouispec/agent-worker'");
  if (/from '\.\.\/\.\.\//.test(text)) throw new Error(`${name} still imports the worker's source by path`);
  writeFileSync(join(test, name), text);
}

// An npm that knows the public registry and nothing else: no user or global
// configuration, no tokens, no registry settings from the environment.
const home = join(dir, '.home');
mkdirSync(home);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_|^NODE_AUTH_TOKEN$|^AWS_|^CODEARTIFACT_/i.test(name)),
);
Object.assign(env, { HOME: home, NPM_CONFIG_USERCONFIG: join(dir, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'npmrc'), NPM_CONFIG_CACHE: join(home, 'npm-cache') });
const run = (command, args) => execFileSync(command, args, { cwd: dir, env, stdio: 'inherit' });

console.log(`installing from ${from === 'registry' ? 'registry.npmjs.org' : 'the packed tarballs'} into ${dir}`);
run('npm', ['install', '--no-audit', '--no-fund']);
const registries = new Set(
  Object.values(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages)
    .map(entry => entry.resolved)
    .filter(resolved => resolved?.startsWith('http'))
    .map(resolved => new URL(resolved).host),
);
if ([...registries].some(host => host !== 'registry.npmjs.org')) throw new Error(`installed from ${[...registries].join(', ')}`);
if (!existsSync(join(dir, 'node_modules/@ouispec/agent-worker/package.json'))) throw new Error('the packages were not installed');
run('npx', ['vitest', 'run']);
console.log(`consumer smoke passed: ${packages.map(({ pkg }) => `${pkg.name}@${pkg.version}`).join(', ')} from ${from === 'registry' ? 'registry.npmjs.org' : 'tarballs'}`);
