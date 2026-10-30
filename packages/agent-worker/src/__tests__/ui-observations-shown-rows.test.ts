/**
 * A long list of cards keeps an index of its rows in the page state, never a
 * bare count, and says how to read the rest, one display at a time.
 *
 * nova-ui #152 (`@nova/core` 0.1.130): the design system's displays report
 * their facts, one entry of the page state's `shown` per card, each with the
 * row it describes (`item`). Shortened, those rows were cut to
 * `"60 more"`: the assistant could name no repair order on the service lane
 * unless a row action happened to be bound. The page state now declares
 * `x-rows` on `shown` (the row's `item.key` and `item.title`, and the display
 * it belongs to), so they are indexed like any list, and what does not fit is
 * read with `ui_read` at the display's own offset.
 */
import { describe, expect, it } from 'vitest';
import { SHOWN_ROWS } from '@ouispec/bindings';

import { boundObservations, observationSchemas, observationsText } from '../ui/observations.js';

const PAGE = 'page:ServiceLanePage';

const ro = (i: number) => ({
  id: 'lane.ro-card',
  title: `RO ${7000 + i}`,
  facts: { Customer: `Customer ${i}`, Vehicle: '2022 Toyota Camry SE', Advisor: 'Avery Ng', Promised: '4:30 PM', Status: 'In progress' },
  item: { key: `ro-${7000 + i}`, title: `RO ${7000 + i} · Customer ${i}` },
});
const appt = (i: number) => ({
  id: 'lane.arrival-card',
  title: `Arrival ${i}`,
  facts: { Customer: `Arrival customer ${i}`, Time: '9:00 AM' },
  item: { key: `appt-${i}`, title: `Arrival ${i}` },
});
const header = { id: 'lane.summary', title: 'Service lane', facts: { Open: '60', Late: '7', Declined: '$12,882' } };

const state = (shown: unknown[]) => ({ [PAGE]: { state: { values: { 'lane.filter': 'all' }, shown } } });
const schemaWithRows = observationSchemas([
  {
    id: PAGE,
    observations: [{ id: 'state', schema: { type: 'object', properties: { shown: { type: 'array', 'x-rows': SHOWN_ROWS } } } }],
  },
]);

type Bounded = { note: string; values?: Record<string, { state: { shown: unknown[] } }>; preview?: string };
const shownOf = (b: unknown) => (b as Bounded).values![PAGE].state.shown;

describe('the cards of a long list, over budget', () => {
  const cards = Array.from({ length: 60 }, (_, i) => ro(i));
  const observations = state([header, ...cards]);

  it('keeps the page’s own facts whole and the rest of the cards as index rows: the display, the row’s key and title', () => {
    const shown = shownOf(boundObservations(observations, 6_000, PAGE, { schemas: schemaWithRows }));
    expect(shown[0]).toEqual(header);
    const rows = shown.slice(1);
    expect(rows).toHaveLength(60);
    expect(rows.filter((r) => (r as { facts?: unknown }).facts)).not.toHaveLength(0);
    const indexed = rows.filter((r) => !(r as { facts?: unknown }).facts);
    expect(indexed[0]).toEqual({ id: 'lane.ro-card', item: { key: expect.stringMatching(/^ro-/), title: expect.stringMatching(/^RO /) } });
    // Every repair order is still named, none is a bare count.
    expect(rows.every((r) => typeof r === 'object')).toBe(true);
  });

  it('indexes them the same way with no schema: a page generated before the declaration', () => {
    expect(shownOf(boundObservations(observations, 6_000, PAGE))).toEqual(
      shownOf(boundObservations(observations, 6_000, PAGE, { schemas: schemaWithRows })),
    );
  });

  it('keeps a row an action just changed whole, however short the list gets', () => {
    const shown = shownOf(boundObservations(observations, 1_500, PAGE, { schemas: schemaWithRows, changed: ['ro-7042'] }));
    expect(shown).toContainEqual(ro(42));
  });

  it('when even the index does not fit, says how many are left out and the ui_read call that returns exactly them', () => {
    const shown = shownOf(boundObservations(observations, 1_000, PAGE, { schemas: schemaWithRows }));
    const marker = shown.find((r): r is string => typeof r === 'string')!;
    expect(marker).toMatch(/rows of lane\.ro-card, not listed to fit the page state; read them with ui_read /);
    const call = JSON.parse(marker.slice(marker.indexOf('{'))) as { surface: string; observation: string; path: string; offset: number; limit: number };
    expect(call).toMatchObject({ surface: PAGE, observation: 'state', path: '/shown' });
    // The rows that call returns are the rows left out, and only them.
    const full = observations[PAGE].state.shown;
    const read = full.slice(call.offset, call.offset + call.limit) as Array<{ item: { key: string } }>;
    const listed = new Set(shown.filter((r) => typeof r === 'object').map((r) => (r as { item?: { key: string } }).item?.key));
    expect(read.every((r) => r && !listed.has(r.item.key))).toBe(true);
    expect(read.length + listed.size - 1).toBe(60);
  });

  it('pages each display on its own: the arrivals’ call is the arrivals’ rows', () => {
    const arrivals = Array.from({ length: 30 }, (_, i) => appt(i));
    const both = state([header, ...cards, ...arrivals]);
    const shown = shownOf(boundObservations(both, 1_200, PAGE, { schemas: schemaWithRows }));
    const markers = shown.filter((r): r is string => typeof r === 'string');
    expect(markers.map((m) => m.match(/rows of ([\w.-]+)/)![1]).sort()).toEqual(['lane.arrival-card', 'lane.ro-card']);
    const arrivalsCall = JSON.parse(markers.find((m) => m.includes('lane.arrival-card'))!.replace(/^[^{]*/, '')) as { offset: number; limit: number };
    const read = both[PAGE].state.shown.slice(arrivalsCall.offset, arrivalsCall.offset + arrivalsCall.limit) as Array<{ id: string }>;
    expect(read.every((r) => r.id === 'lane.arrival-card')).toBe(true);
  });

  it('says so when a display’s rows are not one run (a page on older bindings)', () => {
    const interleaved = state([header, ...cards.flatMap((c, i) => (i < 30 ? [c, appt(i)] : [c]))]);
    const marker = shownOf(boundObservations(interleaved, 1_200, PAGE, { schemas: schemaWithRows })).find(
      (r): r is string => typeof r === 'string' && r.includes('lane.ro-card'),
    )!;
    expect(marker).toContain('rows of other displays are among them');
  });

  it('fits the user’s message’s page state the same way', () => {
    const text = observationsText(observations, 6_000, { schemas: schemaWithRows });
    expect(text).toContain('{"item":{"key":"ro-7059","title":"RO 7059 · Customer 59"},"id":"lane.ro-card"}');
  });
});
