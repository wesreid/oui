/**
 * Tier 2 acceptance on Radix (ADR-0226 §2.3, §6; plan §5 W4): compound
 * primitives (`Select.Root` / `Select.Item`) take their options from the
 * items they render, and single primitives exported under a namespace
 * (`Switch.Root`) are mapped by their root alone. The app passes
 * `generate --check` and the conformance kit, and a direct import fails.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { OuiManifest } from '@ouispec/bindings';
import { assertConformant, checkApp, checkTier2, formatReport, type ControlExample } from '@ouispec/testing';

import * as bound from '../radix-app/src/agent/generated/bound/radix-ui';
import { OrderTicketPage } from '../radix-app/src/pages/OrderTicketPage';
import { generateCheck, generated, generatedWith, mappingOf, RADIX_APP } from './support/apps';

const EXAMPLES: Record<string, ControlExample> = {
  Select: ({ agent, on }) => (
    <bound.Select.Root value="cash" name="Account" agent={agent()} onValueChange={on('onValueChange')}>
      <bound.Select.Trigger aria-label="Account">
        <bound.Select.Value />
      </bound.Select.Trigger>
      <bound.Select.Portal>
        <bound.Select.Content>
          <bound.Select.Viewport>
            <bound.Select.Item value="cash">
              <bound.Select.ItemText>Cash</bound.Select.ItemText>
            </bound.Select.Item>
            <bound.Select.Item value="margin">
              <bound.Select.ItemText>Margin</bound.Select.ItemText>
            </bound.Select.Item>
          </bound.Select.Viewport>
        </bound.Select.Content>
      </bound.Select.Portal>
    </bound.Select.Root>
  ),
  RadioGroup: ({ agent, on }) => (
    <bound.RadioGroup.Root value="buy" aria-label="Side" agent={agent()} onValueChange={on('onValueChange')}>
      <bound.RadioGroup.Item value="buy" aria-label="Buy" />
      <bound.RadioGroup.Item value="sell" aria-label="Sell" />
    </bound.RadioGroup.Root>
  ),
  Tabs: ({ agent, on }) => (
    <bound.Tabs.Root value="ticket" aria-label="Panel" agent={agent()} onValueChange={on('onValueChange')}>
      <bound.Tabs.List>
        <bound.Tabs.Trigger value="ticket">Ticket</bound.Tabs.Trigger>
        <bound.Tabs.Trigger value="orders">Open orders</bound.Tabs.Trigger>
      </bound.Tabs.List>
    </bound.Tabs.Root>
  ),
  Switch: ({ agent, on }) => <bound.Switch.Root checked={false} aria-label="Extended hours" agent={agent()} onCheckedChange={on('onCheckedChange')} />,
  Checkbox: ({ agent, on }) => (
    <bound.Checkbox.Root checked aria-label="Confirm each fill" agent={agent()} onCheckedChange={on('onCheckedChange')} />
  ),
};

describe('a Radix app bound through its mapping', () => {
  it('passes `oui generate --check`', () => {
    const run = generateCheck(RADIX_APP);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/^Up to date: 1 pages, 0 rooms, 6 actions; 0 pages not yet bound; 1 bound modules; build [0-9a-f]{16}$/m);
    expect(run.stderr).toBe('');
  });

  it('takes a compound control’s options from the items it renders', async () => {
    const result = await generated(RADIX_APP);
    expect(result.errors).toEqual([]);
    const page = result.manifest.surfaces.find(s => s.id === 'page:OrderTicketPage')!;
    expect(page.actions.map(a => a.id).sort()).toEqual([
      'ticket.account',
      'ticket.confirm-fill',
      'ticket.extended-hours',
      'ticket.panel',
      'ticket.side',
    ]);
    const action = (id: string) => page.actions.find(a => a.id === id)!;
    expect(action('ticket.account').input).toMatchObject({ properties: { value: { enum: ['cash', 'margin'] } } });
    expect(action('ticket.account').input).toMatchObject({ properties: { value: { description: expect.stringContaining('Margin') } } });
    expect(action('ticket.side').input).toMatchObject({ properties: { value: { enum: ['buy', 'sell'] } } });
    expect(action('ticket.panel').input).toMatchObject({ properties: { value: { enum: ['ticket', 'orders'] } } });
    expect(action('ticket.extended-hours').input).toMatchObject({ properties: { value: { type: 'boolean' } } });
  });

  it('emits namespaces that keep every other part of each primitive', async () => {
    const result = await generated(RADIX_APP);
    const module = result.files.find(f => f.path === join(RADIX_APP, 'src/agent/generated/bound/radix-ui.ts'));
    expect(module?.content).toContain("import { Checkbox as UnboundCheckbox, RadioGroup as UnboundRadioGroup, Select as UnboundSelect, Switch as UnboundSwitch, Tabs as UnboundTabs } from 'radix-ui';");
    expect(typeof bound.Select.Trigger).toBe('object'); // Radix's own forwardRef part, untouched
    expect(bound.Tabs.List).toBeDefined();
  });

  it('passes the conformance kit: every wrapper forwards valueFrom and returns its callback’s result', async () => {
    const result = await generated(RADIX_APP);
    expect(result.tier2.uncontrolled).toEqual([]);
    const report = await checkTier2({
      mapping: mappingOf(RADIX_APP),
      wrappers: bound,
      examples: EXAMPLES,
      uses: result.tier2.uses,
      reported: result.tier2.uncontrolled,
    });
    assertConformant(report);
    expect(report.checked['registers-declared-kind'], formatReport(report)).toBe(5);
    expect(report.checked['tier2-forwards-value']).toBe(5);
    expect(report.checked['run-returns-result']).toBe(5);
  });

  it('passes the conformance kit: every action of its generated manifest has a handler mounted on the page', async () => {
    const result = await generated(RADIX_APP);
    const report = await checkApp({
      name: 'the Radix fixture app',
      manifest: result.manifest as OuiManifest,
      pages: { 'page:OrderTicketPage': <OrderTicketPage /> },
    });
    assertConformant(report);
    expect(report.checked['actions-mounted']).toBe(5);
  });

  it('fails the build when an enforced page imports a mapped primitive straight from radix-ui, naming the bound import', async () => {
    const result = await generatedWith(RADIX_APP, { routes: 'src/direct-routes.tsx' });
    expect(result.errors.map(e => `${e.file}:${e.line}: ${e.message}`)).toEqual([
      'src/pages/DirectImportPage.tsx:4: Switch is imported straight from radix-ui, which oui/radix-ui.mapping.json maps: import it from "../agent/generated/bound/radix-ui", whose Switch carries the assistant’s binding (on DirectImportPage, whose bindings are enforced)',
    ]);
  });
});
