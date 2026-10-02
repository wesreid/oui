/**
 * A composite's slots carry its row (ADR-0220). The generator reads `item`
 * beside a composite's slots (`{ item, choose }`) and makes each slot a
 * row-keyed action. A composite that registered `agent?.choose` dropped the
 * row, so the page reported rows with no key or title and every request
 * naming one failed (studio-ui, 2026-10-01: FontMatchList, rendered once per
 * missing font). `slotBinding` is how a composite registers a slot.
 */
import { describe, expect, it } from 'vitest';

import { slotBinding } from '../src/index.js';

const item = { key: 'Gotham-Bold', title: 'Gotham' };

describe('slotBinding', () => {
  it('carries the composite’s row into the slot', () => {
    expect(slotBinding({ item, choose: { id: 'a.choose', description: 'd' } }, 'choose')).toEqual({
      id: 'a.choose',
      description: 'd',
      item,
    });
  });

  it('keeps a row the slot names itself', () => {
    const own = { key: 'x', title: 'X' };
    expect(slotBinding({ item, choose: { id: 'a.choose', description: 'd', item: own } }, 'choose')).toMatchObject({
      item: own,
    });
  });

  it('leaves a non-agent slot, a missing slot and a composite with no row as they are', () => {
    const nonAgent = { nonAgent: 'duplicates the menu' };
    expect(slotBinding({ item, choose: nonAgent }, 'choose')).toBe(nonAgent);
    expect(slotBinding({ item }, 'choose')).toBeUndefined();
    expect(slotBinding(undefined, 'choose')).toBeUndefined();
    const plain = { id: 'a.choose', description: 'd' };
    expect(slotBinding({ choose: plain }, 'choose')).toBe(plain);
  });
});
