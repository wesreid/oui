/**
 * `checkRoom` (ADR-0244 §2.8): a room that declares its lists and builds its
 * readers from them passes; a room that reports a list it does not declare,
 * and a room whose readers do not return what it holds, each fail the
 * `lists-readable` rule, saying what is wrong.
 */
import { describe, expect, it } from 'vitest';

import { catalogData, roomReaders, type RoomAction, type RoomCatalog, type RoomList, type RoomResult } from '@ouispec/bindings';

import { assertConformant, checkRoom, formatReport } from '../src/index';

interface Position {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  stopLoss: number | null;
}
type Ctx = { positions: Position[] };

const book = (): Ctx => ({
  positions: [
    { id: 'pos-1', symbol: 'AAPL', side: 'long', quantity: 100, stopLoss: 180 },
    { id: 'pos-2', symbol: 'TSLA', side: 'short', quantity: 20, stopLoss: null },
    { id: 'pos-3', symbol: 'NVDA', side: 'long', quantity: 55, stopLoss: 96.5 },
  ],
});

const row = ({ id, symbol, side }: Position) => ({ id, symbol, side });

const POSITIONS: RoomList<Ctx> = {
  id: 'ledger/positions',
  title: 'Positions',
  rows: { ref: 'id', title: 'symbol', index: ['side'] },
  list: ctx => ctx.positions.map(row),
  detail: (ctx, ref) => {
    const position = ctx.positions.find(p => p.id === ref);
    return position && { ...position };
  },
};

const ROW_SCHEMA = {
  type: 'object' as const,
  properties: { id: { type: 'string' as const }, symbol: { type: 'string' as const }, side: { type: 'string' as const } },
};

function catalog(options: { declared: boolean; readers?: RoomAction<Ctx, never>[] }): RoomCatalog<Ctx> {
  return {
    room: 'ledger',
    title: 'Ledger',
    description: 'Open positions.',
    actions: options.readers ?? roomReaders({ title: 'Ledger' }, [POSITIONS]),
    fields: [],
    commands: [],
    observations: [
      {
        id: 'ledger',
        description: 'Every open position.',
        schema: {
          type: 'object',
          properties: { positions: { type: 'array', ...(options.declared ? { 'x-rows': POSITIONS.rows } : {}), items: ROW_SCHEMA } },
        },
      },
    ],
  };
}

function spec(room: RoomCatalog<Ctx>, ctx = book()) {
  return {
    name: '@kit/ledger',
    catalog: catalogData(room),
    run: (id: string, input: Record<string, unknown>) =>
      (room.actions.find(a => a.id === id) as RoomAction<Ctx, Record<string, unknown>>).run(ctx, input) as RoomResult,
    observations: { ledger: { positions: ctx.positions.map(row) } },
  };
}

describe('checkRoom', () => {
  it('passes a room whose lists are declared and whose readers return what it holds', async () => {
    const report = await checkRoom(spec(catalog({ declared: true })));
    expect(report.violations).toEqual([]);
    // The catalog against the schema; the declarations; and for the list: reported, not empty, query, inspect.
    expect(report.checked).toEqual({ 'matches-contract': 1, 'lists-readable': 5 });
    expect(() => assertConformant(report)).not.toThrow();
  });

  it('fails a room that reports a list of things with ids and does not declare it', async () => {
    const report = await checkRoom(spec(catalog({ declared: false, readers: [] })));
    expect(report.violations).toEqual([
      {
        rule: 'lists-readable',
        subject: 'declarations',
        message:
          'ledger’s list ledger/positions holds things with an id, but does not declare how its rows are addressed and called (x-rows): ' +
          'a list too long for the page state would be cut to a count',
      },
    ]);
    expect(() => assertConformant(report)).toThrow(/lists-readable/);
  });

  it('fails readers that leave rows out, and an inspect that returns nothing about a row', async () => {
    const partial: RoomList<Ctx> = { ...POSITIONS, list: ctx => ctx.positions.slice(1).map(row), detail: () => undefined };
    const [inspect, query] = roomReaders({ title: 'Ledger' }, [partial]);
    const report = await checkRoom(spec(catalog({ declared: true, readers: [inspect, query] })));
    expect(report.violations.map(v => [v.subject, v.message])).toEqual([
      ['ledger/positions › query', 'lists 2 row(s), and the room reports 3'],
      ['ledger/positions › inspect', expect.stringMatching(/^failed for pos-1: /)],
    ]);
    expect(formatReport(report)).toContain('lists-readable');
  });

  it('fails a catalog that is not one', async () => {
    const report = await checkRoom({ ...spec(catalog({ declared: true })), catalog: { room: 'ledger' } });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].rule).toBe('matches-contract');
  });

  it('asks for a room with something in it', async () => {
    const report = await checkRoom(spec(catalog({ declared: true }), { positions: [] }));
    expect(report.violations.map(v => v.message)).toEqual(['is empty: check the room with something in it to read']);
  });
});
