/**
 * The neutral contract (ADR-0226 §2.6, W2), from a product that is not a
 * creative tool: a trading screen on its own design system, with a ledger
 * room that has no timeline. Nothing in what it generates may assume
 * animation, layers or fonts, and its irreversible order is a `transaction`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  resolveKnowledge,
  type ControlKindRegistration,
  type ControlTableFile,
  type ManifestSurface,
  type RoomCatalogData,
} from '@ouispec/bindings';

import { generate, resolveConfig, type GenerateResult } from '../src/index.js';
import { FIXTURES, TABLE, tempDir } from './fixture-config.js';

const ROOT = join(FIXTURES, 'contract');

const PRICE_RANGE: ControlKindRegistration = {
  kind: 'x-price-range',
  verb: 'Set the price band of',
  deriveSchema: {
    schema: {
      type: 'object',
      description: 'A price band: its lowest and highest price',
      properties: { low: { type: 'number' }, high: { type: 'number' } },
      required: ['low', 'high'],
    },
    props: { '/properties/low/minimum': 'min', '/properties/high/maximum': 'max', '/x-unit': 'unit' },
  },
};

const DS: ControlTableFile = {
  Button: TABLE.Button,
  Tags: {
    kind: 'multi-choice',
    callbacks: ['onChange'],
    options: { prop: 'options', value: 'value', title: 'label' },
    titleProps: ['label'],
  },
  Period: { kind: 'date-range', callbacks: ['onChange'], titleProps: ['label'] },
  PriceRange: {
    kind: 'x-price-range',
    callbacks: ['onChange'],
    schemaProps: { min: 'min', max: 'max', unit: 'unit' },
    titleProps: ['label'],
  },
  $kinds: [PRICE_RANGE],
};

const LEDGER: RoomCatalogData = {
  room: 'ledger',
  title: 'Ledger',
  description: 'The account’s positions and orders.',
  actions: [
    {
      kind: 'action',
      id: 'set-properties',
      title: 'Set properties',
      description: 'Sets fields on the selected position.',
      control: 'The position panel',
      input: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
      effect: 'edit',
    },
    {
      kind: 'action',
      id: 'select-position',
      title: 'Select a position',
      description: 'Selects a position by id.',
      control: 'Clicking a row',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      effect: 'selection',
    },
    {
      kind: 'action',
      id: 'close-position',
      title: 'Close position',
      description: 'Sells the whole position at market.',
      control: 'The row’s Close button',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      effect: { kind: 'transaction', operation: 'placeOrder' },
    },
  ],
  fields: [
    {
      kind: 'field',
      id: 'stop-loss',
      title: 'Stop loss',
      description: 'The price that closes the position.',
      control: 'Stop loss field',
      section: { id: 'risk', title: 'Risk' },
      appliesTo: ['position'],
      value: { type: 'number', minimum: 0, 'x-unit': 'USD' },
    },
  ],
  commands: [],
  observations: [{ id: 'positions', description: 'Every open position.', schema: { type: 'array' } }],
  problems: [{ kind: 'order-rejected', description: 'The exchange refused an order' }],
  recipes: [
    {
      name: 'Protect a position in the {room}',
      trigger: 'Limiting how much a position in the {room} can lose',
      steps: ['Select it with {action:select-position}.', 'Set its stop with {field:stop-loss}.'],
    },
  ],
};

function contractConfig(settings: Record<string, unknown> = {}, catalogs = [LEDGER]) {
  return resolveConfig(
    ROOT,
    {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      designSystem: ['@fixture/ds'],
      apiSpec: 'openapi.json',
      out: tempDir('oui-gen-'),
      ...settings,
    },
    {
      controlTables: { '@fixture/ds': DS },
      catalogs: catalogs.map(catalog => ({ package: '@fixture/ledger', hosts: [], catalog })),
    },
  );
}

const surface = (surfaces: readonly ManifestSurface[], id: string) => {
  const s = surfaces.find(x => x.id === id);
  if (!s) throw new Error(`no surface ${id}: ${surfaces.map(x => x.id).join(', ')}`);
  return s;
};

describe('a product that is not a creative tool', () => {
  let r: GenerateResult;
  beforeAll(async () => {
    r = await generate(contractConfig());
  });

  it('generates with no problems', () => {
    expect(r.errors).toEqual([]);
  });

  it('offers a multi-choice control as any of its options', () => {
    const markets = surface(r.manifest.surfaces, 'page:TradePage').actions.find(a => a.name === 'trade_markets')!;
    expect(markets.control).toBe('multi-choice');
    expect(markets.input.properties?.value).toMatchObject({
      type: 'array',
      uniqueItems: true,
      items: { enum: ['us', 'eu', 'fx'] },
    });
    expect(markets.description).toMatch(/^Choose any of "Markets": /);
  });

  it('offers a date-range control as a start and an end', () => {
    const period = surface(r.manifest.surfaces, 'page:TradePage').actions.find(a => a.name === 'trade_period')!;
    expect(period.input.properties?.value).toMatchObject({ type: 'object', required: ['start', 'end'] });
    expect(period.description).toMatch(/^Set the dates of "Period": /);
  });

  it('derives a registered kind’s schema from the control’s props, with the verb it registers', () => {
    const price = surface(r.manifest.surfaces, 'page:TradePage').actions.find(a => a.name === 'trade_price')!;
    expect(price.control).toBe('x-price-range');
    expect(price.input.properties?.value).toMatchObject({
      'x-unit': 'USD',
      properties: { low: { minimum: 0 }, high: { maximum: 500 } },
    });
    expect(price.description).toMatch(/^Set the price band of "Price": /);
  });

  it('declares an irreversible order as a transaction, through its operation, that needs approval', () => {
    const order = surface(r.manifest.surfaces, 'page:TradePage').actions.find(a => a.name === 'trade_place_order')!;
    expect(order.effect).toEqual({ kind: 'transaction', operation: 'placeOrder', approvalMinutes: 10 });
    expect(order.description).toContain(
      'It is irreversible: it runs only on the person’s approval of this exact call, through placeOrder (POST /api/orders: Place an order).',
    );
    const detail = resolveKnowledge(r.knowledge, '/trade').entries.map(e => e.content).join('\n');
    expect(detail).toContain('[trade_place_order] (irreversible: needs the person’s approval; through placeOrder (POST /api/orders))');
  });

  it('gives a room with no timeline its actions, fields and own problems, and no animation anywhere', () => {
    const ledger = surface(r.manifest.surfaces, 'room:ledger');
    const close = ledger.actions.find(a => a.name === 'ledger_close_position')!;
    expect(close.effect).toEqual({ kind: 'transaction', operation: 'placeOrder' });
    expect(close.description).toContain('It is irreversible: it runs only on the person’s approval of this exact call');
    const problems = ledger.observations.find(o => o.id === 'problems')!;
    expect(problems.description).toContain('Its kinds: order-rejected = The exchange refused an order.');

    const knowledge = resolveKnowledge(r.knowledge, '/trade');
    const text = knowledge.entries.map(e => `${e.title}\n${e.content}`).join('\n');
    expect(text).not.toMatch(/keyframe|playhead|animat/i);
    expect(knowledge.workflows.map(w => w.name)).not.toContainEqual(expect.stringMatching(/^Animate/));
  });

  it('turns a recipe the room declares into knowledge, naming each step’s tool', () => {
    const protect = resolveKnowledge(r.knowledge, '/trade').workflows.find(w => w.name === 'Protect a position in the Ledger')!;
    expect(protect.trigger).toBe('Limiting how much a position in the Ledger can lose');
    expect(protect.steps).toEqual([
      'Select it with ledger_select_position.',
      'Set its stop with ledger_set_properties stop-loss.',
      expect.stringContaining('Read positions and problems'),
    ]);
  });
});

describe('what the contract refuses', () => {
  it('an effect it does not know, a transaction through an unknown operation, an approval over 30 minutes', async () => {
    const r = await generate(contractConfig({ routes: 'src/broken-routes.tsx' }));
    const messages = r.errors.map(e => e.message);
    expect(messages).toContainEqual(expect.stringMatching(/^"broken\.teleport": "teleport" is not an effect/));
    expect(messages).toContain('"broken.refund" names API operation refundOrder, which openapi.json does not have');
    expect(messages).toContainEqual(expect.stringMatching(/^"broken\.long": a transaction’s `approvalMinutes` is a whole number from 1 to 30/));
  });

  it('a control of a kind its table does not register', async () => {
    const r = await generate(
      resolveConfig(
        ROOT,
        {
          tsconfig: 'tsconfig.json',
          routes: 'src/broken-routes.tsx',
          designSystem: ['@fixture/ds'],
          apiSpec: 'openapi.json',
          out: tempDir('oui-gen-'),
          unbound: ['BrokenPage'],
        },
        {
          controlTables: {
            '@fixture/ds': { ...DS, Mystery: { kind: 'x-mystery', callbacks: ['onChange'], titleProps: [] } },
          },
          catalogs: [],
        },
      ),
    );
    expect(r.errors.map(e => e.message)).toContain(
      '"@fixture/ds" gives Mystery the kind x-mystery, which its $kinds do not register',
    );
  });

  it('a kind registration that is not valid', async () => {
    const r = await generate(
      resolveConfig(
        ROOT,
        {
          tsconfig: 'tsconfig.json',
          routes: 'src/routes.tsx',
          designSystem: ['@fixture/ds'],
          apiSpec: 'openapi.json',
          out: tempDir('oui-gen-'),
        },
        {
          controlTables: { '@fixture/ds': { ...DS, $kinds: [{ ...PRICE_RANGE, kind: 'price-range' as never }] } },
          catalogs: [{ package: '@fixture/ledger', hosts: [], catalog: LEDGER }],
        },
      ),
    );
    expect(r.errors.map(e => e.message)).toContainEqual(
      expect.stringMatching(/^"@fixture\/ds" registers a control kind that is not valid: a registered control kind is named x-<lower-kebab>/),
    );
  });

  it('a room recipe that names an entry the room does not have', async () => {
    const bad = { ...LEDGER, recipes: [{ name: 'Hedge in the {room}', trigger: 'Hedging', steps: ['Hedge with {action:hedge}.'] }] };
    const r = await generate(contractConfig({}, [bad]));
    expect(r.errors.map(e => e.message)).toEqual([
      'ledger’s recipe "Hedge in the {room}" names action hedge, which the room does not have',
    ]);
  });
});

describe('the neutral CLI', () => {
  it('is installed as oui, beside closure-oui', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin.oui).toBe(pkg.bin['closure-oui']);
  });
});
