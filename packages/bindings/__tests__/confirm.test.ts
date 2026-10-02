/**
 * What the assistant asks the person before using (ADR-0220). A destructive
 * control (it removes, sends or spends) and a `confirm` control (it changes
 * what the person is working in: their account, project or role) are both
 * offered with `confirm`, so the assistant asks first. Anything else is not.
 *
 * On dev (2026-09-30) the PA, refused a page, switched the person's account
 * on its own to try to get in.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it } from 'vitest';

import { createBindingRegistry, deriveInputSchema, type OuiManifest } from '../src/index.js';
import { connectBindings } from '../src/oui.js';

const button = (id: string, flags: { destructive?: boolean; confirm?: boolean } = {}) => ({
  name: id.replace(/[.-]/g, '_'),
  id,
  source: 'control' as const,
  control: 'button' as const,
  title: id,
  description: id,
  input: deriveInputSchema('button', {}),
  reach: [],
  ...flags,
});

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'shell:Shell',
      kind: 'shell',
      title: 'Shell',
      description: 'On every page',
      routes: ['*'],
      actions: [
        button('shell.account.switch', { confirm: true }),
        button('shell.items.delete', { destructive: true }),
        button('shell.help'),
      ],
      observations: [],
    },
  ],
};

describe('what the assistant asks first', () => {
  it('offers a control that changes the account, and a destructive one, with confirm; a plain one without', async () => {
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false });
    const disconnect = connectBindings({ registry, runtime, manifest });
    for (const id of ['shell.account.switch', 'shell.items.delete', 'shell.help']) {
      registry.registerControl({ id, kind: 'button', title: id, valueSchema: null, run: () => ({ ok: true }) });
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    const actions = runtime.snapshot().surfaces.find(s => s.id === 'shell:Shell')!.actions;
    const confirm = Object.fromEntries(actions.map(a => [a.id, a.confirm]));
    expect(confirm).toEqual({
      shell_account_switch: true,
      shell_items_delete: true,
      shell_help: undefined,
    });
    disconnect();
  });
});
