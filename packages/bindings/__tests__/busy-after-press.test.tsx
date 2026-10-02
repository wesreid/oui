/**
 * A control its own press disables for a moment is busy, not gone.
 *
 * On dev the PA pressed a document form's Add. Add disabled itself while it
 * saved, so the answer said the tool was removed, and the PA took that for
 * "Add is unavailable" although the document had been saved. Now it stays
 * offered and the page state lists it as busy; pressing it meanwhile says it is
 * busy; it is offered as before once it re-enables. A control that leaves the
 * page after its press is gone as usual.
 */
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBindingRegistry, deriveInputSchema, type OuiManifest } from '../src/index.js';
import { connectBindings } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding } from '../src/react.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:FormPage',
      kind: 'page',
      title: 'Form',
      description: 'A form',
      routes: ['/form'],
      actions: [
        {
          name: 'form_save',
          id: 'form.save',
          source: 'control',
          control: 'button',
          title: 'Save',
          description: 'Save the form',
          input: deriveInputSchema('button', {}),
          reach: [],
        },
      ],
      observations: [{ id: 'state', description: 'What the page shows', schema: { type: 'object' } }],
    },
  ],
};

/** A Save button that disables itself while it saves, and optionally closes the form when done. */
let finishSave: (() => void) | null = null;
function Form({ closeWhenSaved = false }: { closeWhenSaved?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(true);
  finishSave = () => {
    setSaving(false);
    if (closeWhenSaved) setOpen(false);
  };
  return open ? <SaveButton saving={saving} onSave={() => setSaving(true)} /> : null;
}
function SaveButton({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  useAgentBinding({
    agent: { id: 'form.save', description: 'Save the form' },
    kind: 'button',
    title: 'Save',
    disabled: saving,
    run: () => onSave(),
  });
  return null;
}

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.useRealTimers();
});

async function mount(closeWhenSaved = false) {
  const registry = createBindingRegistry();
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
  disconnect = connectBindings({ registry, runtime, manifest });
  render(
    <AgentBindingProvider registry={registry}>
      <Form closeWhenSaved={closeWhenSaved} />
    </AgentBindingProvider>,
  );
  await act(async () => {});
  const tools = () => runtime.snapshot().surfaces.flatMap(s => s.actions.map(a => a.id));
  const state = () =>
    runtime.snapshot().observations['page:FormPage']?.state as { unavailable: string[]; busy?: string[] } | undefined;
  let n = 0;
  const press = () =>
    act(() =>
      runtime.execute({ requestId: `r${++n}`, surfaceId: 'page:FormPage', actionId: 'form_save', params: {}, timestamp: 0 }),
    );
  return { tools, state, press };
}

describe('a control its own press disables', () => {
  it('stays offered and is reported busy, then is offered as before once it re-enables', async () => {
    const page = await mount();
    expect((await page.press()).success).toBe(true);

    // Saving: still offered, busy rather than unavailable.
    expect(page.tools()).toContain('form_save');
    expect(page.state()).toMatchObject({ busy: ['form.save'], unavailable: [] });

    // Pressing it meanwhile says it is busy.
    const again = await page.press();
    expect(again).toMatchObject({ success: false, error: { code: 'BUSY' } });

    // Saved: enabled again, no longer busy.
    act(() => finishSave?.());
    await act(async () => {});
    expect(page.tools()).toContain('form_save');
    expect(page.state()?.busy).toBeUndefined();
    expect((await page.press()).success).toBe(true);
  });

  it('is gone as usual when its press takes it off the page', async () => {
    const page = await mount(true);
    await page.press();
    act(() => finishSave?.());
    await act(async () => {});
    expect(page.tools()).not.toContain('form_save');
  });

  it('is only unavailable once it has stayed disabled past the busy window', async () => {
    vi.useFakeTimers();
    const page = await mount();
    await page.press();
    expect(page.tools()).toContain('form_save');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(page.tools()).not.toContain('form_save');
  });
});
