import { act, render } from '@testing-library/react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBindingRegistry,
  deriveInputSchema,
  type AgentProp,
  type OuiManifest,
  type RoomCatalogData,
} from '../src/index.js';
import { connectBindings } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding, useAgentFacts, useRoomRegistration } from '../src/react.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:VoicesPage',
      kind: 'page',
      title: 'Voices',
      description: 'The voice library',
      routes: ['/voices'],
      actions: [
        {
          name: 'voices_library',
          id: 'voices.library',
          source: 'control',
          control: 'tabs',
          title: 'Library',
          description: 'Which library to show',
          input: deriveInputSchema('tabs', {
            options: [
              { value: 'user', title: 'My Voices' },
              { value: 'account', title: 'Account Voices' },
            ],
          }),
          reach: [],
        },
        {
          name: 'voices_design',
          id: 'voices.design',
          source: 'control',
          control: 'choice',
          title: 'Design',
          description: 'One design category',
          input: deriveInputSchema('choice', {}, { itemized: true }),
          itemized: true,
          reach: [],
        },
        {
          name: 'voices_open',
          id: 'voices.open',
          source: 'control',
          control: 'button',
          title: 'Open',
          description: 'Open a voice',
          input: deriveInputSchema('button', {}, { itemized: true }),
          itemized: true,
          reach: [],
        },
      ],
      observations: [
        { id: 'state', description: 'What the page shows', schema: { type: 'object' } },
        { id: 'problems', description: 'What is wrong', schema: { type: 'array' } },
      ],
    },
    {
      id: 'room:demo',
      kind: 'room',
      title: 'Demo room',
      description: 'A room',
      routes: ['/demo'],
      actions: [
        {
          name: 'demo_add',
          id: 'demo/action/add',
          source: 'room-action',
          title: 'Add',
          description: 'Add a shape',
          input: { type: 'object', properties: { size: { type: 'number' } } },
          reach: [],
        },
        {
          name: 'demo_set_properties',
          id: 'demo/action/set-properties',
          source: 'room-action',
          title: 'Set properties',
          description: 'Set fields',
          input: { type: 'object', properties: { values: { type: 'object' } } },
          reach: [],
        },
      ],
      observations: [
        { id: 'document', description: 'The document', schema: { type: 'object' } },
        { id: 'problems', description: 'What is wrong', schema: { type: 'array' } },
      ],
    },
  ],
};

function Tabs({
  agent,
  value,
  onChange,
}: {
  agent?: AgentProp;
  value: string;
  onChange: (v: string) => void;
}) {
  useAgentBinding({
    agent,
    kind: 'tabs',
    title: 'Library',
    schemaProps: {
      options: [
        { value: 'user', title: 'My Voices' },
        { value: 'account', title: 'Account Voices' },
      ],
    },
    value,
    run: ({ value: next }) => onChange(next as string),
  });
  return <div data-testid="tab">{value}</div>;
}

function Row({
  id,
  name,
  onOpen,
  disabled,
}: {
  id: string;
  name: string;
  onOpen: (id: string) => void;
  disabled?: boolean;
}) {
  useAgentBinding({
    agent: { id: 'voices.open', description: 'Open a voice', item: { key: id, title: name } },
    kind: 'button',
    title: 'Open',
    disabled,
    run: () => onOpen(id),
  });
  return null;
}

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
});

function setup() {
  const registry = createBindingRegistry();
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 5, timeoutMs: 200 } });
  const defects: unknown[] = [];
  disconnect = connectBindings({ registry, runtime, manifest, onDefect: d => defects.push(d) });
  return { registry, runtime, defects };
}

const flush = () => act(async () => new Promise(r => setTimeout(r, 0)));

describe('connectBindings', () => {
  it('offers what is declared and mounted, and runs the control’s own handler', async () => {
    const { registry, runtime } = setup();
    const opened: string[] = [];
    function Page() {
      const [tab, setTab] = useState('user');
      return (
        <>
          <Tabs
            agent={{ id: 'voices.library', description: 'Which library' }}
            value={tab}
            onChange={setTab}
          />
          <Row id="v1" name="Ava" onOpen={id => opened.push(id)} />
          <Row id="v2" name="Ben" onOpen={id => opened.push(id)} />
        </>
      );
    }
    const view = render(
      <AgentBindingProvider registry={registry}>
        <Page />
      </AgentBindingProvider>,
    );
    await flush();

    const snap = runtime.snapshot();
    const page = snap.surfaces.find(s => s.id === 'page:VoicesPage')!;
    expect(page.actions.map(a => a.id)).toEqual(['voices_library', 'voices_open']);
    const open = page.actions.find(a => a.id === 'voices_open')!;
    expect(open.input.properties?.item?.enum).toEqual(['v1', 'v2']);
    expect(snap.observations['page:VoicesPage'].state).toEqual({
      values: { 'voices.library': 'user' },
      lists: {
        'voices.open': [
          { key: 'v1', title: 'Ava' },
          { key: 'v2', title: 'Ben' },
        ],
      },
      unavailable: [],
    });

    const tabResult = await act(() =>
      runtime.execute({
        requestId: 'r1',
        surfaceId: 'page:VoicesPage',
        actionId: 'voices_library',
        params: { value: 'account' },
        timestamp: 0,
      }),
    );
    expect(tabResult.success).toBe(true);
    expect(view.getByTestId('tab').textContent).toBe('account');

    const byTitle = await act(() =>
      runtime.execute({
        requestId: 'r2',
        surfaceId: 'page:VoicesPage',
        actionId: 'voices_open',
        params: { item: 'ben' },
        timestamp: 0,
      }),
    );
    expect(byTitle.success).toBe(true);
    expect(opened).toEqual(['v2']);
  });

  it('validates each row against its own options when rows differ', async () => {
    const { registry, runtime } = setup();
    const chosen: string[] = [];
    function Category({ name, options }: { name: string; options: string[] }) {
      useAgentBinding({
        agent: { id: 'voices.design', description: 'One design category', item: { key: name, title: name } },
        kind: 'choice',
        title: name,
        schemaProps: { options: options.map(o => ({ value: o, title: o })) },
        run: ({ value }) => {
          chosen.push(`${name}=${value}`);
        },
      });
      return null;
    }
    render(
      <AgentBindingProvider registry={registry}>
        <Category name="age" options={['child', 'elderly']} />
        <Category name="pitch" options={['low', 'high']} />
      </AgentBindingProvider>,
    );
    await flush();
    const tool = runtime.snapshot().surfaces[0].actions.find(a => a.id === 'voices_design')!;
    expect(tool.input.properties?.value?.enum).toBeUndefined();
    const ok = await runtime.execute({
      requestId: 'd1',
      surfaceId: 'page:VoicesPage',
      actionId: 'voices_design',
      params: { item: 'pitch', value: 'high' },
      timestamp: 0,
    });
    expect(ok.success).toBe(true);
    const bad = await runtime.execute({
      requestId: 'd2',
      surfaceId: 'page:VoicesPage',
      actionId: 'voices_design',
      params: { item: 'age', value: 'high' },
      timestamp: 0,
    });
    expect(bad.error?.code).toBe('INVALID_VALUE');
    expect(chosen).toEqual(['pitch=high']);
  });

  it('refuses a value outside the control’s schema, and a row that is not on screen', async () => {
    const { registry, runtime } = setup();
    render(
      <AgentBindingProvider registry={registry}>
        <Tabs
          agent={{ id: 'voices.library', description: 'Which library' }}
          value="user"
          onChange={() => {}}
        />
        <Row id="v1" name="Ava" onOpen={() => {}} />
      </AgentBindingProvider>,
    );
    await flush();
    const bad = await runtime.execute({
      requestId: 'r3',
      surfaceId: 'page:VoicesPage',
      actionId: 'voices_library',
      params: { value: 'nope' },
      timestamp: 0,
    });
    expect(bad.error?.code).toBe('INVALID_VALUE');
    const missing = await runtime.execute({
      requestId: 'r4',
      surfaceId: 'page:VoicesPage',
      actionId: 'voices_open',
      params: { item: 'Zed' },
      timestamp: 0,
    });
    expect(missing.error?.code).toBe('ITEM_NOT_FOUND');
    expect(missing.error?.message).toContain('"Ava" (v1)');
  });

  it('does not offer a disabled control, and takes it away when it unmounts', async () => {
    const { registry, runtime } = setup();
    const view = render(
      <AgentBindingProvider registry={registry}>
        <Row id="v1" name="Ava" onOpen={() => {}} disabled />
      </AgentBindingProvider>,
    );
    await flush();
    expect(runtime.snapshot().surfaces.find(s => s.id === 'page:VoicesPage')?.actions ?? []).toEqual([]);
    view.unmount();
    await flush();
    expect(runtime.snapshot().surfaces).toEqual([]);
  });

  it('reports a binding the build does not declare, and offers nothing for it', async () => {
    const { registry, runtime, defects } = setup();
    render(
      <AgentBindingProvider registry={registry}>
        <Tabs agent={{ id: 'voices.unknown', description: 'x' }} value="user" onChange={() => {}} />
      </AgentBindingProvider>,
    );
    await flush();
    expect(defects).toEqual([{ kind: 'unknown-binding', id: 'voices.unknown' }]);
    expect(runtime.snapshot().surfaces).toEqual([]);
  });

  it('registers nothing without a provider, or for a non-agent control', async () => {
    const { registry } = setup();
    render(<Tabs agent={{ id: 'voices.library', description: 'x' }} value="user" onChange={() => {}} />);
    render(
      <AgentBindingProvider registry={registry}>
        <Tabs agent={{ nonAgent: 'decorative' }} value="user" onChange={() => {}} />
      </AgentBindingProvider>,
    );
    await flush();
    expect(registry.controls()).toEqual([]);
  });

  it('runs a room’s actions through the room, and reports its observations and problems', async () => {
    const { registry, runtime } = setup();
    const run = vi.fn(async (id: string, input: Record<string, unknown>) =>
      id === 'add'
        ? { ok: true as const, data: { size: input.size } }
        : { ok: false as const, code: 'NOT_APPLICABLE', message: 'Select a shape first' },
    );
    const entry = (id: string) => ({
      kind: 'action' as const,
      id,
      title: id,
      description: id,
      control: 'Toolbar',
      input: { type: 'object' as const },
      effect: 'edit' as const,
    });
    const catalog: RoomCatalogData = {
      room: 'demo',
      title: 'Demo',
      description: 'A room',
      actions: [entry('add'), entry('set-properties')],
      fields: [],
      commands: [],
      observations: [{ id: 'document', description: 'The document', schema: { type: 'object' } }],
    };
    function Room() {
      useRoomRegistration(catalog, {
        run,
        observations: { document: { shapes: 1 } },
        problems: [{ kind: 'missing-font', message: 'Arial Black is not in your library', hides: ['t1'] }],
      });
      return null;
    }
    render(
      <AgentBindingProvider registry={registry}>
        <Room />
      </AgentBindingProvider>,
    );
    await flush();
    const snap = runtime.snapshot();
    expect(snap.surfaces.map(s => [s.id, s.actions.map(a => a.id)])).toEqual([
      ['room:demo', ['demo_add', 'demo_set_properties']],
    ]);
    expect(snap.observations['room:demo']).toEqual({
      document: { shapes: 1 },
      problems: [{ kind: 'missing-font', message: 'Arial Black is not in your library', hides: ['t1'] }],
    });
    const add = await runtime.execute({
      requestId: 'a',
      surfaceId: 'room:demo',
      actionId: 'demo_add',
      params: { size: 2 },
      timestamp: 0,
    });
    expect(add).toMatchObject({ success: true, data: { size: 2 } });
    const set = await runtime.execute({
      requestId: 'b',
      surfaceId: 'room:demo',
      actionId: 'demo_set_properties',
      params: { values: {} },
      timestamp: 0,
    });
    expect(set.error).toEqual({ code: 'NOT_APPLICABLE', message: 'Select a shape first' });
    expect(run).toHaveBeenCalledWith('add', { size: 2 });
  });

  it('reports a room action that starts work as started, never as done', async () => {
    const { registry, runtime } = setup();
    const catalog: RoomCatalogData = {
      room: 'demo',
      title: 'Demo',
      description: 'A room',
      actions: [
        {
          kind: 'action',
          id: 'add',
          title: 'Add',
          description: 'Add',
          control: 'Toolbar',
          input: { type: 'object' },
          effect: 'edit',
        },
      ],
      fields: [],
      commands: [],
      observations: [],
    };
    function Room() {
      useRoomRegistration(catalog, { run: async () => ({ ok: true, pending: { jobId: 'job-7' } }), observations: {}, problems: [] });
      return null;
    }
    render(
      <AgentBindingProvider registry={registry}>
        <Room />
      </AgentBindingProvider>,
    );
    await flush();
    const add = await runtime.execute({
      requestId: 'c',
      surfaceId: 'room:demo',
      actionId: 'demo_add',
      params: {},
      timestamp: 0,
    });
    expect(add).toMatchObject({ success: true, data: { status: 'started', jobId: 'job-7' } });
  });
});

describe('what a page shows', () => {
  it('reports a display’s facts, as text by label, with the page state, and drops them when it goes', async () => {
    const { registry, runtime } = setup();
    function Parameters({ seed }: { seed: number | null }) {
      useAgentFacts({ id: 'voices.parameters', description: 'The voice’s parameters' }, 'Parameters', {
        Engine: 'OmniVoice',
        Seed: seed,
        Notes: '',
      });
      return null;
    }
    function Page({ shown, seed }: { shown: boolean; seed: number | null }) {
      const [tab, setTab] = useState('user');
      return (
        <>
          <Tabs agent={{ id: 'voices.library', description: 'Which library' }} value={tab} onChange={setTab} />
          {shown && <Parameters seed={seed} />}
        </>
      );
    }
    const view = render(
      <AgentBindingProvider registry={registry}>
        <Page shown seed={42} />
      </AgentBindingProvider>,
    );
    await flush();
    const state = () => runtime.snapshot().observations['page:VoicesPage'].state as { shown?: unknown };
    expect(state().shown).toEqual([
      { id: 'voices.parameters', title: 'Parameters', facts: { Engine: 'OmniVoice', Seed: '42' } },
    ]);

    view.rerender(
      <AgentBindingProvider registry={registry}>
        <Page shown seed={7} />
      </AgentBindingProvider>,
    );
    await flush();
    expect(state().shown).toEqual([
      { id: 'voices.parameters', title: 'Parameters', facts: { Engine: 'OmniVoice', Seed: '7' } },
    ]);

    view.rerender(
      <AgentBindingProvider registry={registry}>
        <Page shown={false} seed={7} />
      </AgentBindingProvider>,
    );
    await flush();
    expect(state().shown).toBeUndefined();
  });
});

describe('page problems', () => {
  it('tells listeners only when what is wrong changes, not when nothing was and nothing is', async () => {
    const registry = createBindingRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const settled = () => new Promise<void>(resolve => queueMicrotask(resolve));
    const banner = registry.registerProblems('alert:1');
    banner.set([]);
    await settled();
    expect(listener).not.toHaveBeenCalled();
    banner.set([{ kind: 'error', message: 'Upload failed' }]);
    await settled();
    banner.set([{ kind: 'error', message: 'Upload failed' }]);
    await settled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.problems()).toEqual({ 'alert:1': [{ kind: 'error', message: 'Upload failed' }] });
    banner.set([]);
    await settled();
    expect(registry.problems()).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
