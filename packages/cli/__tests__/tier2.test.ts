/**
 * Tier 2 in the generator (ADR-0226 §2.3, §2.5 row 6): a mapping is checked
 * against the contract, the other mappings and the package's own types;
 * it emits a bound module and its control table; each use of a bound
 * control is read as a tier 1 control's; and a stale or orphaned bound
 * module fails `--check`. The real-library acceptance (Mantine, Radix) is in
 * `@ouispec/tier2-fixtures`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { generate, resolveConfig, writeOrCheck } from '../src/index.js';
import { boundModuleSlug } from '../src/tier2.js';
import { FIXTURES, tempDir } from './fixture-config.js';

const APP = join(FIXTURES, 'tier2');
const MAPPING = JSON.parse(readFileSync(join(APP, 'oui/acme-kit.mapping.json'), 'utf8')) as {
  package: string;
  controls: Record<string, Record<string, unknown>>;
};

const SETTINGS = {
  tsconfig: 'tsconfig.json',
  routes: 'src/routes.tsx',
  designSystem: [],
  mappings: ['oui/acme-kit.mapping.json'],
  apiSpec: null,
  out: 'src/agent/generated',
};

/** A mapping file with `change` applied, written beside the app's own in a temp dir, and the settings naming it. */
function withMapping(change: (m: typeof MAPPING) => unknown): Record<string, unknown> {
  const dir = tempDir('oui-tier2-mapping-');
  const file = join(dir, 'acme-kit.mapping.json');
  writeFileSync(file, JSON.stringify(change(structuredClone(MAPPING))));
  return { ...SETTINGS, mappings: [file] };
}

const messages = (result: { errors: readonly { file: string; message: string }[] }) => result.errors.map(e => e.message);

describe('a mapping is checked', () => {
  it('names a mapping file that does not exist', async () => {
    const result = await generate(resolveConfig(APP, { ...SETTINGS, mappings: ['oui/missing.mapping.json'] }));
    expect(messages(result)).toContain('"mappings" lists oui/missing.mapping.json, which does not exist');
  });

  it('refuses "mappings" that is not a list of paths', () => {
    expect(() => resolveConfig(APP, { ...SETTINGS, mappings: 'oui/acme-kit.mapping.json' })).toThrow('"mappings" must be a list of paths');
  });

  it('holds the mapping to the contract', async () => {
    const result = await generate(resolveConfig(APP, withMapping(m => ({ ...m, controls: { Picker: { kind: 'choice', callbacks: ['onPick'] } } }))));
    expect(messages(result).join('\n')).toMatch(/the mapping does not match the OUI contract \(tier2-mapping\.json\):.*valueFrom/);
  });

  it('refuses a package that is a tier 1 design system too', async () => {
    const result = await generate(
      resolveConfig(APP, { ...SETTINGS, designSystem: ['acme-kit'] }, { controlTables: { 'acme-kit': {} }, catalogs: [] }),
    );
    expect(messages(result)).toContain(
      'maps acme-kit, which "designSystem" also lists: a package is a tier 1 design system or mapped, never both',
    );
  });

  it('refuses two mappings of one package', async () => {
    const twin = withMapping(m => m);
    const result = await generate(resolveConfig(APP, { ...SETTINGS, mappings: ['oui/acme-kit.mapping.json', ...(twin.mappings as string[])] }));
    expect(messages(result).some(m => /^maps acme-kit, which oui\/acme-kit\.mapping\.json maps too: one mapping per package$/.test(m))).toBe(true);
  });

  it('refuses a kind no design system registers', async () => {
    const result = await generate(
      resolveConfig(
        APP,
        withMapping(m => {
          m.controls.Press = { kind: 'x-squeeze', callbacks: ['onPress'], valueFrom: { arg: 0 }, controlled: 'children' };
          return m;
        }),
      ),
    );
    expect(messages(result), messages(result).join('\n')).toContain('Press has the kind x-squeeze, which no design system in "designSystem" registers');
  });

  it('holds the mapping to the package’s types: a prop the component does not take', async () => {
    const result = await generate(
      resolveConfig(
        APP,
        withMapping(m => {
          m.controls.Picker.callbacks = ['onPik'];
          (m.controls.Menu.parts as { item: { valueProp: string } }).item.valueProp = 'key';
          return m;
        }),
      ),
    );
    expect(messages(result)).toEqual(
      expect.arrayContaining([
        "Picker names onPik as a callback, but acme-kit's Picker takes no onPik prop",
        "Menu names key as its items’ value, but acme-kit's Menu.Choice takes no key prop",
      ]),
    );
  });

  it('holds the mapping to the package’s types: an export the package does not have', async () => {
    const result = await generate(
      resolveConfig(
        APP,
        withMapping(m => {
          m.controls.Spinner = { kind: 'button', callbacks: ['onSpin'] };
          m.controls.Menu.parts = { root: { export: 'Menu.Root' }, item: { export: 'Menu.Option', valueProp: 'id' } };
          return m;
        }),
      ),
    );
    const text = messages(result).join('\n');
    expect(text).toMatch(/does not fit acme-kit: Module '"acme-kit"' has no exported member 'Spinner'/);
  });
});

describe('the bound module', () => {
  it('is named after the package', () => {
    expect(boundModuleSlug('@mantine/core')).toBe('mantine-core');
    expect(boundModuleSlug('radix-ui')).toBe('radix-ui');
    expect(boundModuleSlug('@mui/material')).toBe('mui-material');
  });

  it('wraps every mapped control under the package’s own export names, and ships its control table', async () => {
    const result = await generate(resolveConfig(APP, SETTINGS));
    expect(result.errors).toEqual([]);
    const module = result.files.find(f => f.path === join(APP, 'src/agent/generated/bound/acme-kit.ts'))!.content;
    expect(module).toContain("import { Menu as UnboundMenu, Picker as UnboundPicker, Press as UnboundPress } from 'acme-kit';");
    expect(module).toContain("import { boundCompound, boundControl, withMembers } from '@ouispec/bindings/react';");
    expect(module).toContain("import '@ouispec/bindings/jsx';");
    expect(module).toContain("const menuParts = boundCompound(UnboundMenu.Root, UnboundMenu.Choice, 'Menu', ");
    expect(module).toContain('export const Menu = withMembers(UnboundMenu, { Choice: menuParts.item, Root: menuParts.root });');
    expect(module).toMatch(/export const Picker = boundControl\(UnboundPicker, 'Picker', \{.*"valueFrom":\{"arg":1\}\}\);/);
    const table = JSON.parse(result.files.find(f => f.path.endsWith('acme-kit.agent-controls.json'))!.content);
    expect(table).toEqual({
      Menu: { callbacks: ['onSelect'], kind: 'choice', titleProps: ['label'] },
      Picker: { callbacks: ['onPick'], kind: 'choice', options: { prop: 'options', title: 'name', value: 'id' }, titleProps: ['label'] },
      Press: { callbacks: ['onPress'], kind: 'button', titleProps: ['children'] },
    });
    // The same mapping always gives the same bytes.
    const again = await generate(resolveConfig(APP, SETTINGS));
    expect(again.files).toEqual(result.files);
  });

  it('is read before it is on disk: pages that import it resolve it from this run’s output', async () => {
    expect(existsSync(join(APP, 'src/agent/generated'))).toBe(false);
    const result = await generate(resolveConfig(APP, SETTINGS));
    expect(result.manifest.surfaces.find(s => s.id === 'page:KitPage')?.actions.map(a => a.id).sort()).toEqual([
      'kit.colour',
      'kit.grid',
      'kit.paint',
      'kit.shade',
      'kit.size',
    ]);
  });
});

describe('each use of a bound control', () => {
  it('takes its options from the prop its mapping names, or the items it renders, read through nested elements', async () => {
    const result = await generate(resolveConfig(APP, SETTINGS));
    const page = result.manifest.surfaces.find(s => s.id === 'page:KitPage')!;
    const value = (id: string) => (page.actions.find(a => a.id === id)!.input as { properties: { value: Record<string, unknown> } }).properties.value;
    expect(value('kit.colour')).toMatchObject({ enum: ['red', 'blue'], description: 'The option to choose: red = Red; blue = Blue' });
    expect(value('kit.size')).toMatchObject({ enum: ['s', 'm'], description: 'The option to choose: s = Small; m = Medium' });
    // Items made by a .map cannot be read at build time: no enum, never a narrower one.
    expect(value('kit.grid').enum).toBeUndefined();
  });

  it('is reported when it does not pass the prop that shows its value, as a warning that does not fail', async () => {
    const result = await generate(resolveConfig(APP, SETTINGS));
    expect(result.errors).toEqual([]);
    expect(result.tier2.uses.map(u => [u.component, u.line])).toEqual([
      ['Picker', 18],
      ['Picker', 25],
      ['Press', 26],
      ['Menu', 29],
      ['Menu', 36],
    ]);
    expect(result.tier2.uncontrolled).toEqual([
      { component: 'Picker', file: 'src/pages/KitPage.tsx', line: 25, props: ['label', 'options', 'onPick', 'agent'] },
    ]);
    expect(result.warnings).toEqual([
      {
        file: 'src/pages/KitPage.tsx',
        line: 25,
        message:
          '<Picker> does not pass value, the prop that shows its value: the assistant can set it, but the control will not show what it set. ' +
          'Pass value, kept in state. (A spread may carry it, but the build cannot see what a spread holds: write it out.)',
      },
    ]);
  });
});

describe('§2.5 row 6: a mapped control imported straight from its package', () => {
  it('fails on an enforced page, naming the bound import, by name and through a namespace', async () => {
    const result = await generate(resolveConfig(APP, { ...SETTINGS, routes: 'src/direct-routes.tsx' }));
    expect(result.errors.map(e => `${e.file}:${e.line}: ${e.message}`)).toEqual([
      'src/pages/DirectPage.tsx:2: Press is imported straight from acme-kit, which oui/acme-kit.mapping.json maps: import it from "../agent/generated/bound/acme-kit", whose Press carries the assistant’s binding (on DirectPage, whose bindings are enforced)',
      'src/pages/DirectPage.tsx:3: Picker is imported straight from acme-kit, which oui/acme-kit.mapping.json maps: import it from "../agent/generated/bound/acme-kit", whose Picker carries the assistant’s binding (on DirectPage, whose bindings are enforced)',
    ]);
  });

  it('is allowed on a page not yet bound, which then stays listed', async () => {
    const result = await generate(resolveConfig(APP, { ...SETTINGS, routes: 'src/direct-routes.tsx', unbound: ['DirectPage'] }));
    expect(result.errors).toEqual([]);
  });
});

describe('`--check`', () => {
  it('fails on a bound module no mapping emits any more, and writing removes it', async () => {
    // Inside the app, where the bound module's own imports resolve; removed after.
    const out = join(APP, '.oui-check-out');
    onTestFinished(() => rmSync(out, { recursive: true, force: true }));
    const settings = { ...SETTINGS, routes: 'src/plain-routes.tsx', out };
    const config = resolveConfig(APP, settings);
    const first = await generate(config);
    expect(first.errors).toEqual([]);
    writeOrCheck(first, config, false);
    writeFileSync(join(out, 'bound', 'old-kit.ts'), '// from a mapping since removed\n');
    const result = await generate(config);
    const stale = writeOrCheck(result, config, true);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/bound\/old-kit\.ts \(no mapping emits it\)$/);
    writeOrCheck(result, config, false);
    expect(existsSync(join(out, 'bound', 'old-kit.ts'))).toBe(false);
    expect(existsSync(join(out, 'bound', 'acme-kit.ts'))).toBe(true);
    expect(writeOrCheck(await generate(config), config, true)).toEqual([]);
  });
});
