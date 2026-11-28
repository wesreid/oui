/**
 * One record drawn twice on a page is one row.
 *
 * A row action names the rows on screen as its item's `enum`. On Nova
 * (2026-11-24) a unit's "Open vehicle" was drawn on a lead's card
 * and again under the lead: the enum listed the unit twice, a provider would
 * not compile the schema, and every call to the action was refused. The count
 * said two rows where there was one.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it } from 'vitest';

import { createBindingRegistry, deriveInputSchema, itemSchema, uniqueRows, type OuiManifest } from '../src/index.js';
import { connectBindings, pageState } from '../src/oui.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:LeadPage',
      kind: 'page',
      title: 'Lead',
      description: 'One lead',
      routes: ['/leads/:id'],
      actions: [
        {
          name: 'inventory_vehicle_open',
          id: 'inventory.vehicle.open',
          source: 'control',
          control: 'button',
          title: 'Open vehicle',
          description: 'Open the vehicle',
          input: deriveInputSchema('button', {}, { itemized: true }),
          itemized: true,
          reach: [],
        },
      ],
      observations: [{ id: 'state', description: 'The page', schema: { type: 'object' } }],
    },
  ],
};

const vehicle = (key: string, title: string, opened: string[], disabled = false) => ({
  id: 'inventory.vehicle.open',
  kind: 'button' as const,
  title: 'Open vehicle',
  valueSchema: null,
  item: { key, title },
  disabled,
  run: () => {
    opened.push(`${key}:${title}`);
    return { ok: true as const };
  },
});

describe('a record drawn twice', () => {
  it('is named once in the item enum, and counted once, its first title standing for it', () => {
    const schema = itemSchema([
      { key: 'u1', title: '2024 Civic' },
      { key: 'u2', title: '2023 Accord' },
      { key: 'u1', title: 'Civic (on the card)' },
    ]);
    expect(schema.enum).toEqual(['u1', 'u2']);
    expect(schema.description).toContain('(2 on screen now)');
    expect(uniqueRows([{ key: 'a', n: 1 }, { key: 'b', n: 2 }, { key: 'a', n: 3 }])).toEqual([{ key: 'a', n: 1 }, { key: 'b', n: 2 }]);
  });

  it('is one row of the page state, as first drawn', () => {
    const opened: string[] = [];
    const state = pageState([vehicle('u1', '2024 Civic', opened), vehicle('u2', '2023 Accord', opened), vehicle('u1', 'Civic', opened)]);
    expect(state.lists['inventory.vehicle.open']).toEqual([
      { key: 'u1', title: '2024 Civic' },
      { key: 'u2', title: '2023 Accord' },
    ]);
  });

  it('is offered once and runs by its id or its title, through a drawing that can be used', async () => {
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const disconnect = connectBindings({ registry, runtime, manifest });
    const opened: string[] = [];
    registry.registerControl(vehicle('u1', '2024 Civic', opened, true));
    registry.registerControl(vehicle('u2', '2023 Accord', opened));
    registry.registerControl(vehicle('u1', '2024 Civic', opened));
    await new Promise(resolve => setTimeout(resolve, 0));

    const action = runtime.snapshot().surfaces.find(s => s.id === 'page:LeadPage')!.actions[0];
    const item = (action.input as { properties: { item: { enum?: string[]; description: string; 'x-row-of'?: string } } }).properties.item;
    // The rows counted once each; the input takes a key or a title, which the action resolves.
    expect(item.enum).toBeUndefined();
    expect(item['x-row-of']).toBe('state/lists/inventory.vehicle.open');
    expect(item.description).toContain('(2 on screen now)');

    const run = (ref: string) =>
      runtime.execute({ requestId: ref, surfaceId: 'page:LeadPage', actionId: 'inventory_vehicle_open', params: { item: ref }, timestamp: 0 });
    expect(await run('u1')).toMatchObject({ success: true });
    // By its title: one row, not "several rows are called".
    expect(await run('2024 Civic')).toMatchObject({ success: true });
    expect(opened).toEqual(['u1:2024 Civic', 'u1:2024 Civic']);
    disconnect();
  });
});
