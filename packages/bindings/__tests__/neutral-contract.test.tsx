/**
 * The neutral contract (ADR-0226 §2.6, W2): one effect vocabulary for
 * controls, room entries and API tools; a closed control-kind list that a
 * design system extends only by registering a kind; and animation as an
 * optional capability of a room rather than a requirement of every field.
 */
import { act, render } from '@testing-library/react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { argsHash } from 'oui-spec/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTION_EFFECT_KINDS,
  catalogData,
  controlKindRegistrationProblem,
  controlVerb,
  createBindingRegistry,
  deriveInputSchema,
  deriveValueSchema,
  effectAccess,
  effectProblem,
  isKeyframeable,
  problemsSchema,
  PROBLEMS_SCHEMA,
  readControlTable,
  registerControlKind,
  stableStringify,
  requiresApproval,
  validateValue,
  type ActionEffect,
  type ControlKindRegistration,
  type OuiManifest,
  type RoomCatalog,
} from '../src/index.js';
import { connectBindings, type JobOutcome, type JobTracker } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding } from '../src/react.js';

describe('one effect vocabulary', () => {
  it('maps each effect to ADR-0210’s read or write, as ADR-0226 §2.6 tables it', () => {
    const access = Object.fromEntries(
      (
        [
          'view',
          'selection',
          { kind: 'navigate', to: '/x' },
          { kind: 'open', container: 'a.b' },
          'edit',
          'file',
          { kind: 'mutate', operation: 'updateThing' },
          { kind: 'job' },
          { kind: 'transaction' },
        ] as ActionEffect[]
      ).map(e => [typeof e === 'string' ? e : e.kind, effectAccess(e)]),
    );
    expect(access).toEqual({
      view: 'read',
      selection: 'read',
      navigate: 'read',
      open: 'read',
      edit: 'write',
      file: 'write',
      mutate: 'write',
      job: 'write',
      transaction: 'write',
    });
    expect(ACTION_EFFECT_KINDS).toHaveLength(9);
  });

  it('requires approval for a transaction always, and for a destructive write', () => {
    expect(requiresApproval({ kind: 'transaction' })).toBe(true);
    expect(requiresApproval({ kind: 'transaction' }, false)).toBe(true);
    expect(requiresApproval({ kind: 'mutate', operation: 'deleteVoice' }, true)).toBe(true);
    expect(requiresApproval('edit', true)).toBe(true);
    expect(requiresApproval('edit')).toBe(false);
    // Changing only what is shown removes nothing, whatever it says.
    expect(requiresApproval('view', true)).toBe(false);
  });

  it('refuses an effect it does not know, and a transaction whose approval would outlast 30 minutes', () => {
    expect(effectProblem({ kind: 'teleport' })).toMatch(/"teleport" is not an effect/);
    expect(effectProblem('delete')).toMatch(/"delete" is not an effect/);
    expect(effectProblem({ kind: 'mutate' })).toMatch(/names its API `operation`/);
    expect(effectProblem({ kind: 'transaction', approvalMinutes: 45 })).toMatch(/from 1 to 30/);
    expect(effectProblem({ kind: 'transaction', operation: 'placeOrder', approvalMinutes: 10 })).toBeNull();
  });
});

describe('control kinds', () => {
  it('derives a multi-choice value: any of its enabled options, each once', () => {
    const schema = deriveValueSchema('multi-choice', {
      options: [
        { value: 'news', title: 'News' },
        { value: 'sport', title: 'Sport' },
        { value: 'old', title: 'Old', disabled: true },
      ],
    })!;
    expect(schema).toMatchObject({ type: 'array', uniqueItems: true, items: { type: 'string', enum: ['news', 'sport'] } });
    expect(validateValue(schema, ['news', 'sport'])).toBeNull();
    expect(validateValue(schema, [])).toBeNull();
    expect(validateValue(schema, ['news', 'news'])).toBe('value lists an item twice');
    expect(validateValue(schema, ['old'])).toMatch(/must be one of/);
    expect(controlVerb('multi-choice')).toBe('Choose any of');
  });

  it('derives a date range: a start and an end, each a real date', () => {
    const schema = deriveValueSchema('date-range')!;
    expect(schema.required).toEqual(['start', 'end']);
    expect(validateValue(schema, { start: '2026-09-01', end: '2026-09-30' })).toBeNull();
    expect(validateValue(schema, { start: '2026-02-30', end: '2026-03-01' })).toBe(
      'value.start must be a date, YYYY-MM-DD',
    );
    expect(validateValue(schema, { start: '2026-09-01' })).toBe('value.end is required');
    expect(deriveInputSchema('date-range').required).toEqual(['value']);
  });

  const PRICE_RANGE: ControlKindRegistration = {
    kind: 'x-price-range',
    verb: 'Set the price range of',
    deriveSchema: {
      schema: {
        type: 'object',
        description: 'A price range',
        properties: { low: { type: 'number' }, high: { type: 'number' } },
        required: ['low', 'high'],
      },
      props: { '/properties/low/minimum': 'min', '/properties/high/maximum': 'max', '/x-unit': 'unit' },
    },
  };

  it('takes a kind a design system registers, deriving its schema from the control’s props', () => {
    registerControlKind(PRICE_RANGE);
    const schema = deriveValueSchema('x-price-range', { min: 0, max: 500, unit: 'USD' })!;
    expect(schema).toMatchObject({
      type: 'object',
      'x-unit': 'USD',
      properties: { low: { type: 'number', minimum: 0 }, high: { type: 'number', maximum: 500 } },
    });
    // The registration is not changed by a derivation.
    expect(PRICE_RANGE.deriveSchema.schema.properties?.low).toEqual({ type: 'number' });
    expect(controlVerb('x-price-range')).toBe('Set the price range of');
    // Registering the same definition again is harmless; another definition is refused.
    expect(() => registerControlKind(PRICE_RANGE)).not.toThrow();
    // As a shipped table holds it (keys sorted), it is the same definition.
    expect(() => registerControlKind(JSON.parse(stableStringify(PRICE_RANGE)))).not.toThrow();
    expect(() => registerControlKind({ ...PRICE_RANGE, verb: 'Pick' })).toThrow(
      'x-price-range is already registered with another definition',
    );
  });

  it('never opens the list: an unregistered or badly named kind is refused', () => {
    expect(() => deriveValueSchema('x-never-registered')).toThrow('Control kind x-never-registered is not registered');
    expect(controlKindRegistrationProblem({ ...PRICE_RANGE, kind: 'price-range' })).toMatch(/named x-<lower-kebab>/);
    expect(controlKindRegistrationProblem({ ...PRICE_RANGE, verb: ' ' })).toMatch(/needs the verb/);
  });

  it('reads the kinds a control table ships under $kinds, apart from its controls', () => {
    const { controls, kinds } = readControlTable({
      PriceRange: { kind: 'x-price-range', callbacks: ['onChange'], titleProps: ['label'] },
      $kinds: [PRICE_RANGE],
    });
    expect(Object.keys(controls)).toEqual(['PriceRange']);
    expect(kinds).toEqual([PRICE_RANGE]);
  });
});

describe('animation is optional', () => {
  const base = { kind: 'field' as const, section: { id: 's', title: 'S' }, appliesTo: ['row'], value: { type: 'number' as const } };
  const catalog: RoomCatalog<null> = {
    room: 'ledger',
    title: 'Ledger',
    description: 'A table of entries.',
    actions: [],
    fields: [
      { ...base, id: 'amount', title: 'Amount', description: 'The entry’s amount.', control: 'Amount', read: () => 0, write: () => ({ ok: true }) },
      { ...base, id: 'x', title: 'X', description: 'Position.', control: 'X', animation: { keyframeable: true }, read: () => 0, write: () => ({ ok: true }) },
      { ...base, id: 'y', title: 'Y', description: 'Position.', control: 'Y', keyframeable: true, read: () => 0, write: () => ({ ok: true }) },
    ],
    commands: [],
    observations: [],
  };

  it('lets a field leave animation out, and reads the keyframeable of a catalog written before', () => {
    expect(catalog.fields.map(f => [f.id, isKeyframeable(f)])).toEqual([
      ['amount', false],
      ['x', true],
      ['y', true],
    ]);
  });

  it('writes an animation block wherever a field animates, and keeps an older catalog’s keyframeable beside it', () => {
    const data = catalogData(catalog);
    expect(data.fields.map(f => [f.id, f.animation, f.keyframeable])).toEqual([
      ['amount', undefined, undefined],
      ['x', { keyframeable: true }, undefined],
      ['y', { keyframeable: true }, true],
    ]);
  });

  it('describes problems generically, and in the room’s own words when it declares its kinds', () => {
    expect(PROBLEMS_SCHEMA.description).not.toMatch(/font|layer|face/i);
    const own = problemsSchema([{ kind: 'order-rejected', description: 'The exchange refused the order' }]);
    expect(own.description).toContain('Its kinds: order-rejected = The exchange refused the order.');
    expect(own.items?.properties?.kind?.enum).toEqual(['order-rejected']);
  });
});

// ─── The runtime ──────────────────────────────────────────────────────────────

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:TradePage',
      kind: 'page',
      title: 'Trade',
      description: 'Places orders',
      routes: ['/trade'],
      actions: [
        {
          name: 'trade_place_order',
          id: 'trade.place-order',
          source: 'control',
          control: 'button',
          title: 'Place order',
          description: 'Place the order',
          input: deriveInputSchema('button', {}),
          effect: { kind: 'transaction', operation: 'placeOrder' },
          reach: [],
        },
      ],
      observations: [{ id: 'state', description: 'What the page shows', schema: { type: 'object' } }],
    },
    {
      id: 'room:render-room',
      kind: 'room',
      title: 'Render room',
      description: 'Renders',
      routes: ['/trade'],
      actions: [
        {
          name: 'render_room_render',
          id: 'render-room/action/render',
          source: 'room-action',
          title: 'Render',
          description: 'Render the video',
          input: { type: 'object', properties: {} },
          effect: { kind: 'job', estimatedDuration: '1 min', timeoutMs: 5_000 },
          reach: [],
        },
        {
          name: 'render_room_publish',
          id: 'render-room/action/publish',
          source: 'room-action',
          title: 'Publish',
          description: 'Publish the video',
          input: { type: 'object', properties: {} },
          effect: { kind: 'transaction' },
          reach: [],
        },
      ],
      observations: [],
    },
  ],
};

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.useRealTimers();
});

function PlaceOrder({ onPlace }: { onPlace: () => void }) {
  useAgentBinding({
    agent: {
      id: 'trade.place-order',
      description: 'Place the order',
      effect: { kind: 'transaction', operation: 'placeOrder' },
    },
    kind: 'button',
    title: 'Place order',
    run: () => {
      onPlace();
      return { ok: true };
    },
  });
  return null;
}

describe('the runtime and approvals (ADR-0228)', () => {
  it('refuses a transaction and never runs its handler', async () => {
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    disconnect = connectBindings({ registry, runtime, manifest });
    const onPlace = vi.fn();
    render(
      <AgentBindingProvider registry={registry}>
        <PlaceOrder onPlace={onPlace} />
      </AgentBindingProvider>,
    );
    await act(async () => {});
    expect(runtime.snapshot().surfaces.flatMap(s => s.actions).map(a => a.id)).toContain('trade_place_order');
    const result = await act(() =>
      runtime.execute({ requestId: 'o1', surfaceId: 'page:TradePage', actionId: 'trade_place_order', params: {}, timestamp: 0 }),
    );
    expect(result).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('offers a transaction with its effect and title, and runs it once on the person’s grant for exactly these params', async () => {
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    disconnect = connectBindings({ registry, runtime, manifest });
    const onPlace = vi.fn();
    render(
      <AgentBindingProvider registry={registry}>
        <PlaceOrder onPlace={onPlace} />
      </AgentBindingProvider>,
    );
    await act(async () => {});
    const offered = runtime.snapshot().surfaces.flatMap(s => s.actions).find(a => a.id === 'trade_place_order');
    expect(offered).toMatchObject({ effect: 'transaction', title: 'Place order' });

    const hash = await argsHash({});
    runtime.grantApproval({ approvalId: 'call_place', argsHash: hash, expiresAt: Date.now() + 60_000 });
    const approval = { approvalId: 'call_place', argsHash: hash };
    const ran = await act(() =>
      runtime.execute({ requestId: 'o2', surfaceId: 'page:TradePage', actionId: 'trade_place_order', params: {}, timestamp: 0, approval }),
    );
    expect(ran).toMatchObject({ success: true });
    expect(onPlace).toHaveBeenCalledTimes(1);
    const replay = await act(() =>
      runtime.execute({ requestId: 'o3', surfaceId: 'page:TradePage', actionId: 'trade_place_order', params: {}, timestamp: 0, approval }),
    );
    expect(replay).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it('settles a room action that starts a job on the job’s outcome, and refuses a room transaction', async () => {
    vi.useFakeTimers();
    const outcomes = new Map<string, JobOutcome>();
    const jobs: JobTracker = {
      track: () => {},
      outcome: id => outcomes.get(id) ?? null,
      forget: id => void outcomes.delete(id),
    };
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    disconnect = connectBindings({ registry, runtime, manifest, jobs });
    const run = vi.fn((id: string) =>
      id === 'render' ? { ok: true as const, pending: { jobId: 'job-9' } } : { ok: true as const },
    );
    registry.registerRoom({
      catalog: {
        room: 'render-room',
        title: 'Render room',
        description: 'Renders',
        actions: [
          { kind: 'action', id: 'render', title: 'Render', description: 'Render', control: 'Render', input: { type: 'object' }, effect: { kind: 'job' } },
          { kind: 'action', id: 'publish', title: 'Publish', description: 'Publish', control: 'Publish', input: { type: 'object' }, effect: { kind: 'transaction' } },
        ],
        fields: [],
        commands: [],
        observations: [],
      },
      run,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const render = runtime.snapshot().surfaces.find(s => s.id === 'room:render-room')!.actions.find(a => a.id === 'render_room_render')!;
    expect(render.async).toBe(true);
    const started = await act(async () => {
      const pending = runtime.execute({ requestId: 'r1', surfaceId: 'room:render-room', actionId: 'render_room_render', params: {}, timestamp: 0 });
      await vi.advanceTimersByTimeAsync(100);
      return pending;
    });
    expect(started).toMatchObject({ success: true, data: { status: 'started', jobId: 'job-9' } });
    outcomes.set('job-9', { status: 'complete', jobId: 'job-9' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(runtime.snapshot().observations['room:render-room']?.['room:render-room:render_room_render:status']).toMatchObject({
      status: 'complete',
      interim: false,
    });

    const published = await act(async () => {
      const pending = runtime.execute({ requestId: 'p1', surfaceId: 'room:render-room', actionId: 'render_room_publish', params: {}, timestamp: 0 });
      await vi.advanceTimersByTimeAsync(100);
      return pending;
    });
    expect(published).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(run).not.toHaveBeenCalledWith('publish', expect.anything());
  });
});
