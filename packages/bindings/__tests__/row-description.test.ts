/**
 * A row's description that arrives or changes after the row is drawn is announced again.
 *
 * A list can draw a row before everything it says about the row is known: an item's lineage, say,
 * named "another item" until the name of what it came from has been read. The registry compared a
 * row by its key and title only, so the later description never reached the page state, and the
 * assistant kept reading the placeholder the person no longer saw.
 */
import { describe, expect, it } from 'vitest';

import { createBindingRegistry, type RegistryChange } from '../src/index.js';
import { pageState } from '../src/oui.js';

const row = (description?: string) => ({
  id: 'library.item.pick',
  kind: 'button' as const,
  title: 'Use',
  valueSchema: null,
  item: { key: 'item-1', title: 'Cropped screen', ...(description !== undefined ? { description } : {}) },
  run: () => ({ ok: true as const }),
});

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('a row whose description changes', () => {
  it('is announced as a change of structure, and the page state carries the new description', async () => {
    const registry = createBindingRegistry();
    const heard: RegistryChange[] = [];
    registry.subscribe(change => heard.push(change));
    const handle = registry.registerControl(row('Edited from another item'));
    await flush();
    heard.length = 0;

    handle.update({ item: { key: 'item-1', title: 'Cropped screen', description: 'Edited from Home page' } });
    await flush();

    expect(heard).toEqual(['structure']);
    expect(pageState(registry.controls()).lists['library.item.pick']).toEqual([
      { key: 'item-1', title: 'Cropped screen', description: 'Edited from Home page' },
    ]);
  });

  it('is announced when a description first arrives, and when it goes', async () => {
    const registry = createBindingRegistry();
    const heard: RegistryChange[] = [];
    registry.subscribe(change => heard.push(change));
    const handle = registry.registerControl(row());
    await flush();
    heard.length = 0;

    handle.update({ item: { key: 'item-1', title: 'Cropped screen', description: 'Edited from Home page' } });
    await flush();
    handle.update({ item: { key: 'item-1', title: 'Cropped screen' } });
    await flush();

    expect(heard).toEqual(['structure', 'structure']);
  });

  it('is not announced again when the same row is drawn with the same description', async () => {
    const registry = createBindingRegistry();
    const heard: RegistryChange[] = [];
    registry.subscribe(change => heard.push(change));
    const handle = registry.registerControl(row('Edited from Home page'));
    await flush();
    heard.length = 0;

    handle.update({ item: { key: 'item-1', title: 'Cropped screen', description: 'Edited from Home page' } });
    await flush();

    expect(heard).toEqual([]);
  });
});
