/**
 * A package ships its components from its root or from a subpath export, and
 * both are that package's. A design system whose React controls are exported
 * from `<package>/react` (its control table declared once, in the package's
 * own package.json) is read as the package it is: each control imported from
 * the subpath is bound against the package's table, an unbound one on an
 * enforced page is still reported, and a package whose name merely starts the
 * same is not mistaken for it. Person-only components and room hosts are read
 * through subpaths the same way; tier 2 mappings are in `tier2.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { ControlTable } from '@ouispec/bindings';

import { generate, resolveConfig, type ConfigInjection } from '../src/index.js';
import { listedPackage, packageName } from '../src/specifier.js';
import { CATALOG, TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};
/** Its control table is the package's; its components are exported only from `@fixture/kit/react`. */
const KIT = {
  name: '@fixture/kit',
  packageJson: {
    oui: { agentControls: './dist/agent-controls.json' },
    exports: { './react': './dist/react.js', './package.json': './package.json' },
  },
  files: {
    'dist/agent-controls.json': JSON.stringify({ TriggerPanel: TABLE.Input } satisfies ControlTable),
  },
};
const REASON = 'Only the person approves an irreversible action';
const AGENT_REACT = {
  name: '@fixture/agent-react',
  packageJson: { oui: { personOnly: { ApprovalCard: REASON } } },
};

const page = (imports: string[], elements: string[]) =>
  [
    "import { Route, Routes } from 'react-router';",
    "import { Button } from '@fixture/ds';",
    ...imports,
    'function HomePage() {',
    '  return (',
    '    <>',
    "      <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>",
    ...elements.map(e => `      ${e}`),
    '    </>',
    '  );',
    '}',
    'export function AppRoutes() {',
    '  return <Routes><Route path="/" element={<HomePage />} /></Routes>;',
    '}',
  ].join('\n');

const BOUND_TRIGGER =
  "<TriggerPanel agent={{ id: 'home.trigger', description: 'The trigger' }} label=\"Trigger\" onChange={() => {}} />";

async function generateWith(
  imports: string[],
  elements: string[],
  designSystem: string[] = ['@fixture/ds', '@fixture/kit'],
  inject: ConfigInjection = {},
) {
  const root = tempApp([DS, KIT, AGENT_REACT], page(imports, elements));
  return generate(
    resolveConfig(
      root,
      { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem, apiSpec: null, out: 'src/agent/generated' },
      inject,
    ),
  );
}

const located = (r: Awaited<ReturnType<typeof generateWith>>) => r.errors.map(e => `${e.file}:${e.line}: ${e.message}`);
const actions = (r: Awaited<ReturnType<typeof generateWith>>) =>
  r.manifest.surfaces.flatMap(s => s.actions).map(a => a.name).sort();

describe('a design-system control imported from a subpath export of its package', () => {
  it('is bound against the package’s control table, beside a control imported from a package root', async () => {
    const r = await generateWith(["import { TriggerPanel } from '@fixture/kit/react';"], [BOUND_TRIGGER]);
    expect(located(r)).toEqual([]);
    expect(actions(r)).toEqual(['app_navigate', 'home_start', 'home_trigger']);
    const trigger = r.manifest.surfaces.flatMap(s => s.actions).find(a => a.name === 'home_trigger');
    expect(trigger?.input).toMatchObject({ properties: { value: { type: 'string' } } });
  });

  it('reads it through an `as` rename too', async () => {
    const r = await generateWith(
      ["import { TriggerPanel as Trigger } from '@fixture/kit/react';"],
      ["<Trigger agent={{ id: 'home.trigger', description: 'The trigger' }} label=\"Trigger\" onChange={() => {}} />"],
    );
    expect(located(r)).toEqual([]);
    expect(actions(r)).toEqual(['app_navigate', 'home_start', 'home_trigger']);
  });

  it('is still reported on an enforced page when it has no binding', async () => {
    const r = await generateWith(
      ["import { TriggerPanel } from '@fixture/kit/react';"],
      [BOUND_TRIGGER, '<TriggerPanel label="Other" onChange={() => {}} />'],
    );
    expect(located(r)).toEqual([
      'src/routes.tsx:9: <TriggerPanel> has no agent binding (on HomePage, whose bindings are enforced)',
    ]);
  });

  it('names the package’s table for an export the table leaves out', async () => {
    const r = await generateWith(["import { FlowPanel } from '@fixture/kit/react';"], ['<FlowPanel onChange={() => {}} />']);
    expect(located(r)).toEqual([
      'src/routes.tsx:8: <FlowPanel> from @fixture/kit takes onChange, but is not in @fixture/kit\'s control table: bind it there, or data-non-agent="<reason>" (on HomePage, whose bindings are enforced)',
    ]);
  });

  it('is not one when the package’s name merely starts the same as a design system’s', async () => {
    const r = await generateWith(
      ["import { TriggerPanel } from '@fixture/kit-extras/react';"],
      ['<TriggerPanel label="Trigger" onChange={() => {}} />'],
    );
    expect(located(r)).toEqual([
      'src/routes.tsx:8: <TriggerPanel> from @fixture/kit-extras/react takes onChange, but is neither a design-system control nor a room host: use a bound control that does the same, or data-non-agent="<reason>" (on HomePage, whose bindings are enforced)',
    ]);
  });

  it('is read against the longest design system it is a subpath of', async () => {
    const r = await generateWith(
      ["import { Picker } from '@fixture/kit/legacy/react';", "import { Picker as KitPicker } from '@fixture/kit/react';"],
      [
        "<Picker agent={{ id: 'home.legacy', description: 'The legacy picker' }} label=\"Legacy\" options={[]} onChange={() => {}} />",
        '<KitPicker label="Kit" onChange={() => {}} />',
      ],
      ['@fixture/ds', '@fixture/kit', '@fixture/kit/legacy'],
      { controlTables: { '@fixture/kit/legacy': { Picker: TABLE.Select } } },
    );
    expect(located(r)).toEqual([
      'src/routes.tsx:10: <KitPicker> from @fixture/kit takes onChange, but is not in @fixture/kit\'s control table: bind it there, or data-non-agent="<reason>" (on HomePage, whose bindings are enforced)',
    ]);
    expect(actions(r)).toEqual(['app_navigate', 'home_legacy', 'home_start']);
  });
});

describe('a person-only component imported from a subpath export of its package', () => {
  it('refuses an agent binding, as from the package root', async () => {
    const r = await generateWith(
      ["import { ApprovalCard } from '@fixture/agent-react/approval';"],
      ["<ApprovalCard agent={{ id: 'approval.approve', description: 'Approve' }} onDecided={() => {}} />"],
    );
    expect(located(r)).toEqual([
      `src/routes.tsx:8: <ApprovalCard> from @fixture/agent-react/approval is the person's own and takes no agent binding: ${REASON}`,
    ]);
  });

  it('builds clean when it is used as itself', async () => {
    const r = await generateWith(
      ["import { ApprovalCard } from '@fixture/agent-react/approval';"],
      ['<ApprovalCard onDecided={() => {}} />'],
    );
    expect(located(r)).toEqual([]);
  });
});

describe('a room host imported from a subpath export of its package', () => {
  it('is the package’s room', async () => {
    const r = await generateWith(["import { DemoRoom } from '@fixture/rooms/react';"], ['<DemoRoom onChange={() => {}} />'], undefined, {
      catalogs: [{ package: '@fixture/rooms', hosts: ['DemoRoom'], catalog: CATALOG }],
    });
    expect(located(r)).toEqual([]);
    expect(r.manifest.surfaces.filter(s => s.kind === 'room').map(s => s.id)).toEqual([`room:${CATALOG.room}`]);
  });
});

describe('listedPackage', () => {
  const listed = ['@acme/kit', '@acme/kit/legacy', 'kit'];
  it.each([
    ['@acme/kit', '@acme/kit'],
    ['@acme/kit/react', '@acme/kit'],
    ['@acme/kit/legacy', '@acme/kit/legacy'],
    ['@acme/kit/legacy/react', '@acme/kit/legacy'],
    ['kit/react', 'kit'],
    ['@acme/kit-extras', null],
    ['@acme/kit-extras/react', null],
    ['@acme/kitchen', null],
    ['kitchen/react', null],
    ['@acme', null],
    ['./kit', null],
  ])('%s → %s', (specifier, expected) => {
    expect(listedPackage(specifier, listed)).toBe(expected);
  });
});

describe('packageName', () => {
  it.each([
    ['@acme/kit', '@acme/kit'],
    ['@acme/kit/react', '@acme/kit'],
    ['@acme/kit/react/deep', '@acme/kit'],
    ['kit', 'kit'],
    ['kit/react', 'kit'],
    ['@acme', null],
    ['@/kit', null],
    ['./kit', null],
    ['../kit', null],
    ['/abs/kit', null],
    ['#internal', null],
    ['node:fs', null],
    ['', null],
  ])('%s → %s', (specifier, expected) => {
    expect(packageName(specifier)).toBe(expected);
  });
});
