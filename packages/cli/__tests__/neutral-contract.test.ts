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

describe('what a build may offer the assistant, by size (ADR-0245 §2.6)', () => {
  it('fails an action whose definition one answer cannot carry, and one whose index entry is over its line, each by name', async () => {
    const symbols = Array.from({ length: 40_000 }, (_, i) => `SYM-${String(i).padStart(6, '0')}`);
    const room = {
      ...LEDGER,
      actions: LEDGER.actions.map(a =>
        a.id === 'select-position'
          ? {
              ...a,
              // A whole catalogue inlined into one action: 40,000 symbols.
              input: { type: 'object' as const, properties: { id: { type: 'string' as const }, symbol: { enum: symbols } }, required: ['id'] },
            }
          : a.id === LEDGER.actions[0].id
            ? { ...a, title: 'T'.repeat(600) }
            : a,
      ),
    };
    const r = await generate(contractConfig({}, [room as never]));
    const messages = r.errors.map(e => e.message);
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^ledger\/action\/select-position: its definition is \d+\.\d KB, over the 256\.0 KB one answer carries\. Split the action, or move what it lists into a reader the assistant queries\.$/,
      ),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(new RegExp(`^ledger/action/${LEDGER.actions[0].id}: its index entry is \\d+ bytes, over 512\\. Shorten its id or its title\\.$`)),
    );
  });

  it('passes the room as it is', async () => {
    const r = await generate(contractConfig());
    expect(r.errors.filter(e => /over the|is over|over 512/.test(e.message))).toEqual([]);
  });
});

describe('what a room’s numbers are measured in (ADR-0244 §2.3)', () => {
  it('fails a field and an action input that take a number without saying its unit, and not an integer or a unit given on the array', async () => {
    const room = {
      ...LEDGER,
      fields: [
        ...LEDGER.fields,
        { ...LEDGER.fields[0], id: 'take-profit', title: 'Take profit', value: { type: 'number' as const, minimum: 0 } },
        { ...LEDGER.fields[0], id: 'lots', title: 'Lots', value: { type: 'integer' as const, minimum: 1 } },
      ],
      actions: LEDGER.actions.map(a =>
        a.id === 'select-position'
          ? {
              ...a,
              input: {
                type: 'object' as const,
                properties: {
                  id: { type: 'string' as const },
                  at: { type: 'array' as const, items: { type: 'number' as const }, 'x-unit': 'px' },
                  band: { type: 'object' as const, properties: { low: { type: 'number' as const }, high: { type: 'number' as const, 'x-unit': 'USD' } } },
                },
                required: ['id'],
              },
            }
          : a,
      ),
    };
    const r = await generate(contractConfig({}, [room as never]));
    expect(r.errors.map(e => e.message)).toEqual([
      'ledger action select-position: band.low is a number with no unit (x-unit)',
      'ledger field take-profit is a number with no unit (x-unit)',
    ]);
  });
});

describe('a room’s lists (ADR-0244 §2.2)', () => {
  const POSITIONS = {
    id: 'positions',
    description: 'Every open position.',
    schema: {
      type: 'array' as const,
      items: { type: 'object' as const, properties: { id: { type: 'string' as const }, symbol: { type: 'string' as const } } },
    },
  };
  const READERS = ['inspect', 'query'].map(id => ({
    kind: 'action' as const,
    id,
    title: id,
    description: `Reads positions (${id}).`,
    control: 'The positions table',
    input: { type: 'object' as const, properties: {} },
    effect: 'view' as const,
  }));
  const withList = (rows?: object, actions = LEDGER.actions) => ({
    ...LEDGER,
    actions,
    observations: [{ ...POSITIONS, schema: { ...POSITIONS.schema, ...(rows ? { 'x-rows': rows } : {}) } }],
  });

  it('fails a list of things with ids that does not say how its rows are addressed', async () => {
    const r = await generate(contractConfig({}, [withList() as never]));
    expect(r.errors.map(e => e.message)).toEqual([
      'ledger’s list positions holds things with an id, but does not declare how its rows are addressed and called (x-rows): ' +
        'a list too long for the page state would be cut to a count',
    ]);
  });

  it('fails a room that declares a list and no readers for it', async () => {
    const r = await generate(contractConfig({}, [withList({ ref: 'id', title: 'symbol' }) as never]));
    expect(r.errors.map(e => e.message)).toEqual([
      'ledger declares lists (positions) but no "inspect" action to read them: build its readers with roomReaders',
      'ledger declares lists (positions) but no "query" action to read them: build its readers with roomReaders',
    ]);
  });

  it('fails an index property a row does not have, and an input that addresses a list the room does not have', async () => {
    const actions = [
      ...LEDGER.actions.map(a =>
        a.id === 'select-position'
          ? { ...a, input: { ...a.input, properties: { id: { type: 'string' as const, 'x-ref': ['orders'] } } } }
          : a,
      ),
      ...READERS,
    ];
    const r = await generate(contractConfig({}, [withList({ ref: 'id', title: 'name' }, actions as never) as never]));
    expect(r.errors.map(e => e.message)).toEqual([
      'ledger action select-position: id addresses orders, which is not a list the room declares',
      'ledger’s list positions indexes rows by name, which a row does not have',
    ]);
  });

  it('passes a declared list with its readers, and the manifest carries the declaration to the tab', async () => {
    const actions = [
      ...LEDGER.actions.map(a =>
        a.id === 'select-position'
          ? { ...a, input: { ...a.input, properties: { id: { type: 'string' as const, 'x-ref': ['positions'] } } } }
          : a,
      ),
      ...READERS,
    ];
    const r = await generate(contractConfig({}, [withList({ ref: 'id', title: 'symbol' }, actions as never) as never]));
    expect(r.errors).toEqual([]);
    const room = r.manifest.surfaces.find(s => s.id === 'room:ledger')!;
    expect(room.observations.find(o => o.id === 'positions')!.schema['x-rows']).toEqual({ ref: 'id', title: 'symbol' });
    expect(room.actions.find(a => a.id === 'ledger/action/select-position')!.input.properties!.id['x-ref']).toEqual(['positions']);
    expect(room.actions.map(a => a.id)).toEqual(expect.arrayContaining(['ledger/action/inspect', 'ledger/action/query']));
  });
});

describe('the neutral CLI', () => {
  it('is installed as oui, beside closure-oui', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin.oui).toBe(pkg.bin['closure-oui']);
  });
});
