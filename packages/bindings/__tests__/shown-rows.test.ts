/**
 * The page state's `shown` as a list of addressable rows: facts that describe
 * one row of a list carry it as `item`, `x-rows` names it by a dotted path
 * (`item.key`), and the page reports each display's rows together, so the rows
 * a shortened page state leaves out are one `offset` and `limit`.
 */
import { describe, expect, it } from 'vitest';

import { factsByDisplay, indexRow, observationLookup, rowValue, SHOWN_ROWS, type ShownFacts } from '../src/index.js';

const card = (key: string, id = 'lane.ro-card'): ShownFacts => ({
  id,
  title: key.toUpperCase(),
  facts: { Customer: `Customer of ${key}` },
  item: { key, title: `${key} title` },
});

describe('rows addressed by a dotted path', () => {
  it('reads a property, a dotted path, and a property whose own name holds the dot', () => {
    expect(rowValue({ id: 'a' }, 'id')).toBe('a');
    expect(rowValue({ item: { key: 'k' } }, 'item.key')).toBe('k');
    expect(rowValue({ 'item.key': 'own', item: { key: 'nested' } }, 'item.key')).toBe('own');
    expect(rowValue({ item: null }, 'item.key')).toBeUndefined();
    expect(rowValue('text', 'id')).toBeUndefined();
  });

  it('indexes a fact row by its row and its display, each where the row holds it', () => {
    expect(indexRow({ ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] }, card('ro-1') as never)).toEqual({
      item: { key: 'ro-1', title: 'ro-1 title' },
      id: 'lane.ro-card',
    });
  });

  it('finds a row by its key or title in a list declared by dotted paths', () => {
    const lookup = observationLookup(
      [{ id: 'state', schema: { type: 'object', properties: { shown: { type: 'array', 'x-rows': { ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] } } } } }],
      { state: { shown: [card('ro-1'), card('ro-2')] } },
    );
    expect(lookup.lists).toEqual(['state/shown']);
    expect(lookup.rows('state/shown')).toEqual([
      { ref: 'ro-1', title: 'ro-1 title' },
      { ref: 'ro-2', title: 'ro-2 title' },
    ]);
  });
});

describe('the page state reports each display’s rows together', () => {
  it('keeps displays in the order they first appeared, and rows in theirs', () => {
    const header: ShownFacts = { id: 'lane.summary', title: 'Lane', facts: { Open: '3' } };
    const facts = [card('ro-1'), card('a-1', 'lane.arrival-card'), header, card('ro-2'), card('a-2', 'lane.arrival-card'), card('ro-3')];
    expect(factsByDisplay(facts).map(f => f.item?.key ?? f.id)).toEqual(['ro-1', 'ro-2', 'ro-3', 'a-1', 'a-2', 'lane.summary']);
  });
});
