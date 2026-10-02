/**
 * Tier 2 acceptance on Mantine (ADR-0226 §2.3, §6; plan §5 W4): an app on a
 * design system it does not own is bound through a mapping and the wrappers
 * `oui generate` emits from it. It passes `generate --check` and the
 * conformance kit; a direct import of a mapped control on an enforced page
 * fails the build, naming the bound import; an uncontrolled use is reported.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';

import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';

import type { ControlTableFile, OuiManifest } from '@ouispec/bindings';
import { assertConformant, checkApp, checkTier2, formatReport, type ControlExample } from '@ouispec/testing';

import * as bound from '../mantine-app/src/agent/generated/bound/mantine-core';
import { ScreenerPage } from '../mantine-app/src/pages/ScreenerPage';
import { generateCheck, generated, generatedWith, MANTINE_APP, mappingOf } from './support/apps';

const Theme = ({ children }: { children: ReactNode }) => <MantineProvider>{children}</MantineProvider>;

const MARKETS = [
  { value: 'us', label: 'United States' },
  { value: 'eu', label: 'Europe' },
];

/** Each mapped control used as the app uses it, its callback named as the mapping's first. */
const EXAMPLES: Record<string, ControlExample> = {
  Button: ({ agent, on }) => (
    <bound.Button agent={agent()} onClick={on('onClick')}>
      Run screen
    </bound.Button>
  ),
  Select: ({ agent, on }) => <bound.Select label="Market" data={MARKETS} value="us" agent={agent()} onChange={on('onChange')} />,
  MultiSelect: ({ agent, on }) => (
    <bound.MultiSelect label="Markets" data={MARKETS} value={['us']} agent={agent()} onChange={on('onChange')} />
  ),
  TextInput: ({ agent, on }) => <bound.TextInput label="Symbol" maxLength={8} value="AA" agent={agent()} onChange={on('onChange')} />,
  NumberInput: ({ agent, on }) => (
    <bound.NumberInput label="Minimum price" min={0} max={100} step={1} value={10} agent={agent()} onChange={on('onChange')} />
  ),
  Switch: ({ agent, on }) => <bound.Switch label="Live prices" checked={false} agent={agent()} onChange={on('onChange')} />,
  Modal: ({ agent, on }) => (
    <bound.Modal opened title="Save screen" agent={agent()} onClose={on('onClose')}>
      Name it
    </bound.Modal>
  ),
  Tabs: ({ agent, on }) => (
    <bound.Tabs value="results" aria-label="View" agent={agent()} onChange={on('onChange')}>
      <bound.Tabs.List>
        <bound.Tabs.Tab value="results">Results</bound.Tabs.Tab>
        <bound.Tabs.Tab value="history">History</bound.Tabs.Tab>
      </bound.Tabs.List>
    </bound.Tabs>
  ),
};

describe('a Mantine app bound through its mapping', () => {
  it('passes `oui generate --check`, and reports its one uncontrolled use without failing', () => {
    const run = generateCheck(MANTINE_APP);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/^Up to date: 1 pages, 0 rooms, 14 actions; 0 pages not yet bound; 1 bound modules; build [0-9a-f]{16}$/m);
    expect(run.stderr.trim().split('\n')).toEqual([
      'src/pages/ScreenerPage.tsx:93: warning: <Select> does not pass value, the prop that shows its value: the assistant can set it, but the control will not show what it set. Pass value, kept in state.',
    ]);
  });

  it('generates an action for every bound control, with the schema its props give', async () => {
    const result = await generated(MANTINE_APP);
    expect(result.errors).toEqual([]);
    const page = result.manifest.surfaces.find(s => s.id === 'page:ScreenerPage');
    expect(page?.actions.map(a => a.id).sort()).toEqual([
      'screener.alerts',
      'screener.live',
      'screener.market',
      'screener.min-price',
      'screener.run',
      'screener.save',
      'screener.save-confirm',
      'screener.save-dialog',
      'screener.save-name',
      'screener.sectors',
      'screener.sort',
      'screener.symbol',
      'screener.view',
    ]);
    const action = (id: string) => page!.actions.find(a => a.id === id)!;
    expect(action('screener.market').input).toMatchObject({
      properties: { value: { enum: ['us', 'eu', 'jp'] } },
    });
    expect(action('screener.sectors').input).toMatchObject({
      properties: { value: { type: 'array', items: { enum: ['tech', 'energy', 'health'] } } },
    });
    expect(action('screener.min-price').input).toMatchObject({ properties: { value: { minimum: 0, maximum: 10000 } } });
    expect(action('screener.symbol').input).toMatchObject({ properties: { value: { type: 'string', maxLength: 8 } } });
    expect(action('screener.live').input).toMatchObject({ properties: { value: { type: 'boolean' } } });
    // The tabs' options are the tabs it renders.
    expect(action('screener.view').input).toMatchObject({ properties: { value: { enum: ['results', 'history'] } } });
    // The dialog's own controls are reached through it, and it is opened by the button that sets its state.
    expect(action('screener.save-name').reach).toEqual([
      { kind: 'route', path: '/screener', title: 'Screener' },
      { kind: 'dialog', binding: 'screener.save-dialog', openedBy: ['screener.save'], title: 'Save screen' },
    ]);
  });

  it('emits the bound module and its control table, which ships like a tier 1 package', async () => {
    const result = await generated(MANTINE_APP);
    const out = join(MANTINE_APP, 'src/agent/generated/bound');
    const paths = result.files.map(f => f.path).filter(p => p.startsWith(out)).sort();
    expect(paths).toEqual([join(out, 'mantine-core.agent-controls.json'), join(out, 'mantine-core.ts')]);
    const table = JSON.parse(readFileSync(join(out, 'mantine-core.agent-controls.json'), 'utf8')) as ControlTableFile;
    expect(Object.keys(table).sort()).toEqual(['Button', 'Modal', 'MultiSelect', 'NumberInput', 'Select', 'Switch', 'Tabs', 'TextInput']);
    expect(table.Modal).toEqual({ kind: 'dialog', callbacks: ['onClose'], titleProps: ['title'], container: { kind: 'dialog', stateProp: 'opened' } });
  });

  it('passes the conformance kit: every wrapper forwards valueFrom and returns its callback’s result, and every uncontrolled use is reported', async () => {
    const result = await generated(MANTINE_APP);
    expect(result.tier2.uses.length).toBe(13);
    expect(result.tier2.uncontrolled).toEqual([
      { component: 'Select', file: 'src/pages/ScreenerPage.tsx', line: 93, props: ['label', 'data', 'defaultValue', 'onChange', 'agent'] },
    ]);
    const report = await checkTier2({
      mapping: mappingOf(MANTINE_APP),
      wrappers: bound,
      examples: EXAMPLES,
      uses: result.tier2.uses,
      reported: result.tier2.uncontrolled,
      wrapper: Theme,
    });
    assertConformant(report);
    expect(report.checked['registers-declared-kind'], formatReport(report)).toBe(8);
    expect(report.checked['tier2-forwards-value']).toBe(6); // every control with a valueFrom
    expect(report.checked['run-returns-result']).toBe(8);
    expect(report.checked['tier2-reports-uncontrolled']).toBe(1);
  });

  it('passes the conformance kit: every action of its generated manifest has a handler mounted on the page', async () => {
    const result = await generated(MANTINE_APP);
    const report = await checkApp({
      name: 'the Mantine fixture app',
      manifest: result.manifest as OuiManifest,
      pages: { 'page:ScreenerPage': [<ScreenerPage key="closed" />, <ScreenerPage key="saving" saving />] },
      wrapper: Theme,
    });
    assertConformant(report);
    expect(report.checked['actions-mounted']).toBe(13);
  });
});

describe('what the mapping enforces', () => {
  it('fails the build when an enforced page imports a mapped control straight from @mantine/core, naming the bound import', async () => {
    const result = await generatedWith(MANTINE_APP, { routes: 'src/direct-routes.tsx' });
    expect(result.errors.map(e => `${e.file}:${e.line}: ${e.message}`)).toEqual([
      'src/pages/DirectImportPage.tsx:5: Select is imported straight from @mantine/core, which oui/mantine-core.mapping.json maps: import it from "../agent/generated/bound/mantine-core", whose Select carries the assistant’s binding (on DirectImportPage, whose bindings are enforced)',
    ]);
  });

  it('allows the direct import on a page listed as not yet bound, which stays listed', async () => {
    const result = await generatedWith(MANTINE_APP, { routes: 'src/direct-routes.tsx', unbound: ['DirectImportPage'] });
    expect(result.errors).toEqual([]);
  });
});
