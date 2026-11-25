/**
 * A build whose config names no route gates (`routeGates`) generates exactly
 * what it did before gates existed: the same manifest and knowledge, byte for
 * byte. The golden files under `fixtures/golden/` were written by the
 * generator of 0.17.1, before gates, from the fixture apps below; a change to
 * them is a change to every ungated build's output, so it is made on purpose
 * (`OUI_WRITE_GOLDEN=1 pnpm test` rewrites them) and reviewed as one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generate, resolveConfig, type GeneratorConfig } from '../src/index.js';
import { config, FIXTURES, TABLE, tempDir } from './fixture-config.js';

const GOLDEN = join(FIXTURES, 'golden');
const WRITE = process.env.OUI_WRITE_GOLDEN === '1';

const SETTINGS = { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@closurestudio/ui'], apiSpec: null };
const routeFixture = (name: string, routes: string): GeneratorConfig =>
  resolveConfig(
    join(FIXTURES, name),
    { ...SETTINGS, routes, out: tempDir('oui-gen-') },
    { controlTables: { '@closurestudio/ui': TABLE }, catalogs: [] },
  );

const APPS: [string, () => GeneratorConfig][] = [
  ['app', () => config()],
  ['routes-jsx', () => routeFixture('routes-jsx', 'src/routes.tsx')],
  ['routes-data', () => routeFixture('routes-data', 'src/router.tsx')],
];

describe('a build with no route gates', () => {
  for (const [name, configOf] of APPS) {
    it(`generates the ${name} fixture's manifest and knowledge byte for byte as before gates`, async () => {
      const result = await generate(configOf());
      const emitted = result.files.filter(f => /oui-(manifest|knowledge)\.json$/.test(f.path));
      expect(emitted.map(f => basename(f.path)).sort()).toEqual(['oui-knowledge.json', 'oui-manifest.json']);
      for (const file of emitted) {
        const golden = join(GOLDEN, `${name}.${basename(file.path)}`);
        if (WRITE) {
          mkdirSync(GOLDEN, { recursive: true });
          writeFileSync(golden, file.content);
        }
        expect(existsSync(golden), `${golden} is missing: OUI_WRITE_GOLDEN=1 writes it`).toBe(true);
        expect(file.content).toBe(readFileSync(golden, 'utf8'));
      }
      expect(result.knowledge.map).toBeUndefined();
      for (const s of result.manifest.surfaces) expect(s.gates).toBeUndefined();
      for (const p of result.knowledge.pages) expect(p.gates).toBeUndefined();
    });
  }

  it('generates the same with routeGates naming no component the routes render, or none at all', async () => {
    const without = await generate(config());
    for (const routeGates of [{}, { FeatureRoute: 'feature' }] as Record<string, string>[]) {
      const withGates = await generate(config({ routeWrappers: ['LazyRoute', 'Suspense', 'FeatureRoute'], routeGates }));
      expect(withGates.files.find(f => f.path.endsWith('oui-manifest.json'))!.content).toBe(
        without.files.find(f => f.path.endsWith('oui-manifest.json'))!.content,
      );
      expect(withGates.files.find(f => f.path.endsWith('oui-knowledge.json'))!.content).toBe(
        without.files.find(f => f.path.endsWith('oui-knowledge.json'))!.content,
      );
    }
  });
});
