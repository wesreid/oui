/**
 * What an action returned is fitted to what a model should read of it.
 *
 * On dev (2026-10-08) deleting an artboard of 779 layers answered with 88 KB of
 * removed rows, and inspecting it with 107 KB. The step that carried both was
 * 168,155 tokens, and every later step of the turn read them again.
 */
import { describe, expect, it } from 'vitest';
import { answerCutNotes, DEFAULT_ANSWER_DATA_CHARS, fitAnswerData } from '../ui/answer-fit.js';

const row = (i: number) => ({ list: 'document/layers', ref: `vector-${String(i).padStart(4, '0')}-8db1-4272-b364-3bea48eb0b0b`, removed: true });
const size = (value: unknown) => JSON.stringify(value).length;

describe('fitAnswerData', () => {
  it('leaves a result that fits exactly as it is', () => {
    const data = { deleted: ['a'], changed: Array.from({ length: 20 }, (_, i) => row(i)) };
    const fitted = fitAnswerData(data);
    expect(fitted.data).toBe(data);
    expect(fitted.cuts).toEqual([]);
  });

  it('cuts the longest list to its first rows, says how many it had, and keeps the rest of the result whole', () => {
    const data = { deleted: ['artboard-1'], changed: Array.from({ length: 779 }, (_, i) => row(i)) };
    expect(size(data)).toBeGreaterThan(60_000);
    const fitted = fitAnswerData(data);
    const out = fitted.data as typeof data;

    expect(size(out)).toBeLessThanOrEqual(DEFAULT_ANSWER_DATA_CHARS);
    expect(out.deleted).toEqual(['artboard-1']);
    // The first rows, in order, as they were.
    expect(out.changed.length).toBeGreaterThan(50);
    expect(out.changed).toEqual(data.changed.slice(0, out.changed.length));
    expect(fitted.cuts).toEqual([{ path: 'changed', kind: 'list', total: 779, kept: out.changed.length }]);
    expect(answerCutNotes(fitted.cuts)[0]).toBe(
      `result.changed had 779 rows; the first ${out.changed.length} are here. The action did all of them. To read the rest, ask for less at a time: fewer ids, a filter, or a page of the list.`,
    );
    // The result it was given is not changed.
    expect(data.changed).toHaveLength(779);
  });

  it('cuts a list inside a row, and names where it is', () => {
    const data = { items: [{ ref: 'artboard-1', detail: { name: 'Artboard 1', layers: Array.from({ length: 779 }, (_, i) => ({ id: `layer-${i}`, name: 'Path', kind: 'shape', box: [i, i, 100, 100] })) } }] };
    const fitted = fitAnswerData(data);
    const out = fitted.data as typeof data;
    expect(size(out)).toBeLessThanOrEqual(DEFAULT_ANSWER_DATA_CHARS);
    expect(out.items[0].detail.name).toBe('Artboard 1');
    expect(fitted.cuts).toEqual([{ path: 'items[0].detail.layers', kind: 'list', total: 779, kept: out.items[0].detail.layers.length }]);
  });

  it('cuts a result that is itself a list, and a long text when no list is left to cut', () => {
    const list = Array.from({ length: 2_000 }, (_, i) => row(i));
    const fittedList = fitAnswerData(list, 10_000);
    expect(size(fittedList.data)).toBeLessThanOrEqual(10_000);
    expect(fittedList.cuts[0]).toMatchObject({ path: 'result', kind: 'list', total: 2_000 });
    expect(answerCutNotes(fittedList.cuts)[0]).toMatch(/^The result had 2000 rows; the first \d+ are here\./);

    const text = { svg: 'M0 0 L1 1 '.repeat(5_000) };
    const fittedText = fitAnswerData(text, 10_000);
    expect(size(fittedText.data)).toBeLessThanOrEqual(10_000);
    expect(fittedText.cuts[0]).toMatchObject({ path: 'svg', kind: 'text', total: 50_000 });
    expect(answerCutNotes(fittedText.cuts)[0]).toMatch(/^result\.svg is 50000 characters; the first \d+ are here\.$/);
  });

  it('reports only what is still in the result when a later cut removed the row an earlier cut was in', () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => row(i));
    const data = { groups: Array.from({ length: 40 }, () => ({ rows: big(40) })) };
    const fitted = fitAnswerData(data, 8_000);
    expect(size(fitted.data)).toBeLessThanOrEqual(8_000);
    const out = fitted.data as typeof data;
    for (const cut of fitted.cuts) {
      const index = /^groups\[(\d+)\]/.exec(cut.path);
      if (index) expect(Number(index[1])).toBeLessThan(out.groups.length);
    }
  });
});
