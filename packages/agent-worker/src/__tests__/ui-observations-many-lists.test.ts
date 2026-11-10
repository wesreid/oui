/**
 * A page state of many lists, at the last steps of fitting: once every list is already a count, the page keeps
 * its first lists and those holding a chosen row, and says how many more there are with the `ui_read` call that
 * returns their ids and rows — 40, then 20, then 10, then none — instead of one "N rows" entry per list.
 *
 * Closure Studio's Storyboard, at three times an ordinary production, is 62 lists (a list per control of each
 * line, shot and graphic): even as counts they took 4–5k characters, and beside the video editor and the
 * docked vector studio the Storyboard was left out of the 12,000-character page state whole.
 */
import { describe, expect, it } from 'vitest';
import { observationsText, pageStateFit } from '../ui/observations.js';

const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}-${i}`, title: `${prefix} row ${i}` }));

/** A form of `count` lists, each of three rows (a line's or a shot's controls): its lists are all it has. */
function form(count: number, chosen?: string) {
  const lists: Record<string, unknown[]> = {};
  for (let i = 0; i < count; i += 1) {
    const id = `doc.part-${String(i).padStart(2, '0')}.field`;
    lists[id] = id === chosen ? [{ key: 'x', title: 'Chosen', value: true }, ...rows(id, 2)] : rows(id, 3);
  }
  return { state: { values: { 'doc.brief': 'A brief' }, lists } };
}

const page = (n: number) => ({ state: { values: { 'editor.mode': 'edit', note: 'x'.repeat(n) } } });

describe('many lists over budget', () => {
  it('keeps the first lists as counts and says how many more there are, with how to read their ids', () => {
    const observations = { 'page:Editor': page(400), 'shared:Document': form(60) };
    const text = observationsText(observations, 1_800);
    expect(pageStateFit(observations, 1_800).omitted).toEqual([]);
    // The first lists by name, each a count; the rest as how many there are, and where their ids are read.
    expect(text).toContain('"doc.part-00.field":["3 rows"]');
    expect(text).not.toContain('doc.part-59.field');
    expect(text).toMatch(
      /"…":"\d+ more lists, not listed to fit the page state; their ids and rows: ui_read with surface \\"shared:Document\\", observation \\"state\\", at \\"\/lists\\""/,
    );
    expect(text).toMatch(/lists are given as a count, a page's first \d+ and any holding a chosen row by name/i);
  });

  it('keeps a list holding a chosen row whole, wherever it is', () => {
    const observations = { 'page:Editor': page(400), 'shared:Document': form(60, 'doc.part-55.field') };
    const text = observationsText(observations, 2_000);
    expect(text).toContain('doc.part-55.field');
    expect(text).toContain('"title":"Chosen"');
  });

  it('collapses every list to how many there are when even ten do not fit, and leaves nothing out', () => {
    const observations = { 'page:Editor': page(400), 'shared:Document': form(60) };
    const fit = pageStateFit(observations, 900);
    expect(fit.outcome).toBe('fitted');
    expect(fit.omitted).toEqual([]);
    const text = observationsText(observations, 900);
    expect(text).not.toContain('doc.part-00.field');
    expect(text).toContain('60 lists, not listed to fit the page state');
  });

  it('leaves a page of a few lists as it was', () => {
    const observations = { 'page:Editor': page(1_500), 'shared:Document': form(1) };
    expect(observationsText(observations, 1_200)).not.toContain('lists, not listed');
  });
});
