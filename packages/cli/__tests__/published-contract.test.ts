/**
 * The generator reads and writes the published contract (ADR-0226 §3.1, W3):
 * what it emits matches the schemas, and a control table, room catalog or
 * `oui.config.json` the schemas refuse fails the build, naming what is wrong.
 */
import { describe, expect, it } from 'vitest';

import { contractProblems } from '@ouispec/contract/validate';

import { generate, resolveConfig } from '../src/index.js';
import { CATALOG, config, FIXTURE, TABLE } from './fixture-config.js';

describe('what the generator emits matches the contract', () => {
  it('the fixture app’s manifest and knowledge validate against their schemas', async () => {
    const result = await generate(config());
    expect(result.errors).toEqual([]);
    expect(contractProblems('oui-manifest.json', result.manifest)).toEqual([]);
    expect(contractProblems('generated-knowledge.json', result.knowledge)).toEqual([]);
    // Pages, the frame, a room and the navigation are all there to be checked.
    expect(new Set(result.manifest.surfaces.map(s => s.kind))).toEqual(new Set(['page', 'room', 'navigation', 'shell']));
  });
});

describe('what the generator reads must match the contract', () => {
  it('fails a control table the schema refuses, naming the package and the problem', async () => {
    const table = { ...TABLE, Button: { ...TABLE.Button, label: 'Save' } };
    const result = await generate(config({ controlTables: { '@closurestudio/ui': table } }));
    expect(result.errors.map(e => e.message)).toContainEqual(
      '"@closurestudio/ui"\'s control table does not match the OUI contract (control-table.json): /Button has "label", which the contract does not define',
    );
  });

  it('fails a room catalog the schema refuses, naming the package and the problem', async () => {
    const catalog = { ...CATALOG, fields: CATALOG.fields.map(f => ({ ...f, keyframable: true })) };
    const result = await generate(config({ catalogs: [{ package: '@closurestudio/vector-studio', hosts: ['VectorStudio'], catalog }] }));
    expect(result.errors.map(e => e.message)).toContainEqual(
      expect.stringMatching(/^the room catalog of "@closurestudio\/vector-studio" does not match the OUI contract \(room-catalog-data\.json\): \/fields\/0 has "keyframable"/),
    );
  });

  it('refuses an oui.config.json the schema refuses, though every setting is known', () => {
    const settings = {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      designSystem: [],
      apiSpec: null,
      out: 'out',
      appCatalogs: [{ module: 'src/catalog.ts', export: 'catalog' }],
    };
    expect(() => resolveConfig(FIXTURE, settings)).toThrow(/the contract's oui-config\.json: \/appCatalogs\/0 must have required property 'hosts'/);
  });
});
