/**
 * The tier 2 runtime (ADR-0226 §2.3): what a mapping means, and the bound
 * wrappers `oui generate` emits from it. A wrapper registers the mapped kind
 * with the app's own callback, hands it the value where `valueFrom` says,
 * returns its result, reports `disabled`, and renders the third-party
 * component unchanged; the #209 job rules hold through it.
 */
import { act, render } from '@testing-library/react';
import { createRef, forwardRef, useState, type ReactNode } from 'react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentEvent,
  createBindingRegistry,
  deriveInputSchema,
  mappedOptions,
  tier2CallbackArgs,
  tier2ControlTable,
  type BindingRegistry,
  type OuiManifest,
  type Tier2Control,
} from '../src/index.js';
import { connectBindings, type JobOutcome, type JobTracker } from '../src/oui.js';
import { AgentBindingProvider, boundCompound, boundControl, withMembers } from '../src/react.js';

// What every emitted bound module imports, so a page passes `agent` to a bound control.
import '../src/jsx.js';

// ─── A stand-in third-party design system ────────────────────────────────────

interface PickerProps {
  label?: string;
  value?: string;
  options: readonly { id: string; name: string }[];
  onPick?: (event: unknown, id: string) => unknown;
  disabled?: boolean;
}
const RawPicker = forwardRef<HTMLDivElement, PickerProps>(function RawPicker({ label }, ref) {
  return <div ref={ref} data-testid="picker">{label}</div>;
});
(RawPicker as unknown as { Group: string }).Group = 'the picker group';

function RawPress({ children }: { children?: ReactNode; onPress?: (event: unknown) => unknown; disabled?: boolean }) {
  return <span>{children}</span>;
}

function RawMenuRoot({ children }: { selected?: string; onSelect?: (id: string) => unknown; label?: string; children?: ReactNode }) {
  return <div>{children}</div>;
}
function RawMenuChoice({ children }: { id: string; children?: ReactNode; disabled?: boolean }) {
  return <div>{children}</div>;
}
const RawMenu = Object.freeze({ Root: RawMenuRoot, Choice: RawMenuChoice, Label: ({ children }: { children?: ReactNode }) => <b>{children}</b> });

const PICKER: Tier2Control = {
  kind: 'choice',
  callbacks: ['onPick'],
  valueFrom: { arg: 1 },
  controlled: 'value',
  options: { prop: 'options', value: 'id', title: 'name' },
  titleProps: ['label'],
};
const PRESS: Tier2Control = { kind: 'button', callbacks: ['onPress'], titleProps: ['children'] };
const MENU: Tier2Control = {
  kind: 'choice',
  callbacks: ['onSelect'],
  valueFrom: { arg: 0 },
  controlled: 'selected',
  titleProps: ['label'],
  parts: { root: { export: 'Menu.Root' }, item: { export: 'Menu.Choice', valueProp: 'id', titleProps: ['children'] } },
};

const Picker = boundControl(RawPicker, 'Picker', PICKER);
const Press = boundControl(RawPress, 'Press', PRESS);
const menuParts = boundCompound(RawMenu.Root, RawMenu.Choice, 'Menu', MENU);
const Menu = withMembers(RawMenu, { Root: menuParts.root, Choice: menuParts.item });

const COLOURS = [
  { id: 'red', name: 'Red' },
  { id: 'blue', name: 'Blue' },
];

function mount(node: ReactNode): BindingRegistry {
  const registry = createBindingRegistry();
  render(<AgentBindingProvider registry={registry}>{node}</AgentBindingProvider>);
  return registry;
}

const control = (registry: BindingRegistry, id: string) => {
  const found = registry.controls().find(c => c.id === id);
  if (!found) throw new Error(`${id} is not registered: ${registry.controls().map(c => c.id).join(', ')}`);
  return found;
};

// ─── What a mapping means ────────────────────────────────────────────────────

describe('a mapping', () => {
  it('reads options as objects with the named keys, strings or numbers, and groups; and refuses what it cannot read', () => {
    const source = { prop: 'data', value: 'value', title: 'label' };
    expect(mappedOptions(source, [{ value: 'us', label: 'US' }, 'eu', 3, { group: 'Asia', items: [{ value: 'jp', label: 'Japan', disabled: true }] }])).toEqual([
      { value: 'us', title: 'US' },
      { value: 'eu', title: 'eu' },
      { value: 3, title: '3' },
      { value: 'jp', title: 'Japan', disabled: true },
    ]);
    expect(mappedOptions(source, [{ value: 'us', label: 'US' }, { label: 'no value' }])).toBeNull();
    expect(mappedOptions(source, 'us')).toBeNull();
  });

  it('builds the callback’s arguments where valueFrom says, events before the value', () => {
    const mui = tier2CallbackArgs({ ...PICKER, valueFrom: { arg: 1 } }, 'blue');
    expect(mui).toHaveLength(2);
    expect(mui[0]).toMatchObject({ type: 'oui-agent', isTrusted: false });
    expect(mui[1]).toBe('blue');
    const native = tier2CallbackArgs({ ...PICKER, valueFrom: { arg: 0, path: 'currentTarget.value' } }, 'AA') as [{ currentTarget: { value: string } }];
    expect(native[0].currentTarget.value).toBe('AA');
    expect(tier2CallbackArgs(PRESS, undefined)).toHaveLength(1);
    const event = agentEvent();
    event.preventDefault();
    expect(event.defaultPrevented).toBe(true);
  });

  it('makes a control table, with tabs and dialogs as containers of the state they show', () => {
    const table = tier2ControlTable({
      package: 'acme',
      controls: { Picker: PICKER, Modal: { kind: 'dialog', callbacks: ['onClose'], controlled: 'opened', titleProps: ['title'] } },
    });
    expect(table.Picker).toEqual({ kind: 'choice', callbacks: ['onPick'], titleProps: ['label'], options: PICKER.options });
    expect(table.Modal).toEqual({ kind: 'dialog', callbacks: ['onClose'], titleProps: ['title'], container: { kind: 'dialog', stateProp: 'opened' } });
  });
});

// ─── The bound wrappers ──────────────────────────────────────────────────────

describe('a bound control', () => {
  it('registers the mapped kind, title, options and value, and hands the app’s callback the value where valueFrom says', async () => {
    const onPick = vi.fn((_event: unknown, id: string) => ({ ok: true as const, data: { picked: id } }));
    const registry = mount(<Picker label="Colour" options={COLOURS} value="red" onPick={onPick} agent={{ id: 'kit.colour', description: 'The colour' }} />);
    const reg = control(registry, 'kit.colour');
    expect(reg).toMatchObject({ kind: 'choice', title: 'Colour', value: 'red', disabled: false });
    expect(reg.valueSchema).toMatchObject({ enum: ['red', 'blue'] });
    const result = await act(() => reg.run({ value: 'blue' }));
    expect(onPick.mock.calls[0][1]).toBe('blue');
    expect(onPick.mock.calls[0][0]).toMatchObject({ isTrusted: false });
    // #209: run returns what the app's callback returned.
    expect(result).toEqual({ ok: true, data: { picked: 'blue' } });
  });

  it('says so when the page gave it no callback, rather than claiming it worked', async () => {
    const registry = mount(<Picker label="Colour" options={COLOURS} agent={{ id: 'kit.colour', description: 'The colour' }} />);
    expect(await act(() => control(registry, 'kit.colour').run({ value: 'blue' }))).toEqual({
      ok: false,
      code: 'NOT_WIRED',
      message: 'Picker was given no onPick, so there is nothing for it to do',
    });
  });

  it('reports disabled, renders the component unchanged with its ref, and keeps its static members', () => {
    const ref = createRef<HTMLDivElement>();
    const registry = mount(<Picker ref={ref} label="Colour" options={COLOURS} disabled onPick={() => {}} agent={{ id: 'kit.colour', description: 'The colour' }} />);
    expect(control(registry, 'kit.colour').disabled).toBe(true);
    expect(ref.current?.textContent).toBe('Colour');
    expect((Picker as unknown as { Group: string }).Group).toBe('the picker group');
    expect((RawPicker as unknown as { displayName?: string }).displayName).toBeUndefined();
  });

  it('registers nothing without an agent binding, and nothing without a provider', () => {
    const registry = mount(<Press onPress={() => {}}>Paint</Press>);
    expect(registry.controls()).toEqual([]);
    expect(() => render(<Press onPress={() => {}} agent={{ id: 'kit.paint', description: 'Paint' }}>Paint</Press>)).not.toThrow();
  });
});

describe('a bound compound control', () => {
  it('takes its options from the items rendered under it, titled by their text, nested elements included', () => {
    const registry = mount(
      <Menu.Root label="Size" selected="s" onSelect={() => {}} agent={{ id: 'kit.size', description: 'The size' }}>
        <Menu.Label>Sizes</Menu.Label>
        <Menu.Choice id="s">Small</Menu.Choice>
        <Menu.Choice id="m">
          <b>Medium</b>
        </Menu.Choice>
        <Menu.Choice id="l" disabled>
          Large
        </Menu.Choice>
      </Menu.Root>,
    );
    expect(control(registry, 'kit.size').valueSchema).toMatchObject({ enum: ['s', 'm'], description: 'The option to choose: s = Small; m = Medium' });
  });

  it('follows its items as they come and go', () => {
    function Sizes() {
      const [large, setLarge] = useState(false);
      return (
        <>
          <Press onPress={() => setLarge(true)} agent={{ id: 'kit.more', description: 'Show more sizes' }}>
            More
          </Press>
          <Menu.Root label="Size" selected="s" onSelect={() => {}} agent={{ id: 'kit.size', description: 'The size' }}>
            <Menu.Choice id="s">Small</Menu.Choice>
            {large && <Menu.Choice id="l">Large</Menu.Choice>}
          </Menu.Root>
        </>
      );
    }
    const registry = mount(<Sizes />);
    expect(control(registry, 'kit.size').valueSchema).toMatchObject({ enum: ['s'] });
    act(() => void control(registry, 'kit.more').run({}));
    expect(control(registry, 'kit.size').valueSchema).toMatchObject({ enum: ['s', 'l'] });
  });

  it('leaves the third-party namespace as it was', () => {
    expect(Menu).not.toBe(RawMenu);
    expect(RawMenu.Root).toBe(RawMenuRoot);
    expect(Menu.Label).toBe(RawMenu.Label);
  });
});

// ─── The #209 job rules, through a wrapper ───────────────────────────────────

describe('a bound job control', () => {
  const manifest: OuiManifest = {
    version: 1,
    buildId: 'test',
    surfaces: [
      {
        id: 'page:StudioPage',
        kind: 'page',
        title: 'Studio',
        description: 'Makes images',
        routes: ['/studio'],
        actions: [
          {
            name: 'studio_generate',
            id: 'studio.generate',
            source: 'control',
            control: 'button',
            title: 'Generate',
            description: 'Generate the image',
            input: deriveInputSchema('button', {}),
            effect: { kind: 'job', timeoutMs: 5_000 },
            reach: [],
          },
        ],
        observations: [{ id: 'state', description: 'What the page shows', schema: { type: 'object' } }],
      },
    ],
  };
  let disconnect: (() => void) | null = null;
  afterEach(() => {
    disconnect?.();
    disconnect = null;
    vi.useRealTimers();
  });

  it('is tracked at dispatch, and followed while the page disables it, until its job settles', async () => {
    vi.useFakeTimers();
    const tracked = new Set<string>();
    const outcomes = new Map<string, JobOutcome>();
    const jobs: JobTracker = { track: id => void tracked.add(id), outcome: id => outcomes.get(id) ?? null, forget: id => void outcomes.delete(id) };
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    disconnect = connectBindings({ registry, runtime, manifest, jobs });
    function Generate() {
      const [busy, setBusy] = useState(false);
      return (
        <Press
          disabled={busy}
          onPress={() => {
            setBusy(true);
            return { ok: true, pending: { jobId: 'job-1' } };
          }}
          agent={{ id: 'studio.generate', description: 'Generate the image', effect: { kind: 'job' } }}
        >
          Generate
        </Press>
      );
    }
    render(
      <AgentBindingProvider registry={registry}>
        <Generate />
      </AgentBindingProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const result = await act(async () => {
      const pending = runtime.execute({ requestId: 'r1', surfaceId: 'page:StudioPage', actionId: 'studio_generate', params: {}, timestamp: 0 });
      await vi.advanceTimersByTimeAsync(100);
      return pending;
    });
    expect(result).toMatchObject({ success: true, data: { status: 'started', jobId: 'job-1' } });
    expect(tracked.has('job-1')).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(runtime.snapshot().surfaces.flatMap(s => s.actions).some(a => a.id === 'studio_generate')).toBe(true);
    outcomes.set('job-1', { status: 'complete', jobId: 'job-1' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(runtime.snapshot().observations['page:StudioPage']?.['page:StudioPage:studio_generate:status']).toMatchObject({ status: 'complete', interim: false });
  });
});
