/**
 * A row with hundreds of options stays small in the page state.
 *
 * On dev, Design Studio's Language parameter (648 languages) kept its whole
 * enum in the page state's row schema even after its description was capped,
 * leaving the page state over the preview the assistant reads. A row's schema
 * there now keeps 20 values (and the current one), and says how many it leaves
 * out; the row's tool still takes and validates every value.
 */
import { describe, expect, it } from 'vitest';

import { deriveValueSchema, MAX_DESCRIBED_OPTIONS, validateValue, type ControlRegistration } from '../src/index.js';
import { pageState, summarisedSchema } from '../src/oui.js';

const LANGUAGES = Array.from({ length: 648 }, (_, i) => ({ value: `lang_${i}`, title: `Language ${i}` }));

function languageRow(value: string, key = 'language', options = LANGUAGES): ControlRegistration {
  return {
    id: 'design.model-param.language',
    kind: 'choice',
    title: 'Language',
    item: { key, title: 'Language' },
    valueSchema: deriveValueSchema('choice', { options }),
    value,
    run: () => ({ ok: true }),
  };
}

/** Two rows of a list that take different values: each carries its own schema. */
const differentRows = (value: string) => [languageRow(value), languageRow('lang_0', 'fallback', LANGUAGES.slice(0, 3))];

describe('a long enum in the page state', () => {
  it('keeps twenty values and the current one, says how many are left out, and stays small', () => {
    const full = languageRow('lang_400');
    const state = pageState([full, languageRow('lang_0', 'fallback', LANGUAGES.slice(0, 3))]);
    const schema = state.lists['design.model-param.language'][0].schema!;

    expect(schema.enum).toEqual([...LANGUAGES.slice(0, MAX_DESCRIBED_OPTIONS).map(l => l.value), 'lang_400']);
    expect(schema['x-enum-omitted']).toBe(648 - 21);
    expect(JSON.stringify(state).length).toBeLessThan(2_400);
    // The full schema the row validates against is untouched: every value is still accepted.
    expect(full.valueSchema!.enum).toHaveLength(648);
    expect(validateValue(full.valueSchema!, 'lang_647')).toBeNull();
  });

  it('leaves a short enum, and a schema without one, as it is', () => {
    const short = deriveValueSchema('choice', { options: LANGUAGES.slice(0, MAX_DESCRIBED_OPTIONS) })!;
    expect(summarisedSchema(short, 'lang_3')).toBe(short);
    const range = deriveValueSchema('number', { min: 0, max: 1 })!;
    expect(summarisedSchema(range, 0.5)).toBe(range);
  });

  it('does not repeat the current value when it is among the first twenty', () => {
    const schema = pageState(differentRows('lang_2')).lists['design.model-param.language'][0].schema!;
    expect(schema.enum).toHaveLength(MAX_DESCRIBED_OPTIONS);
    expect(schema['x-enum-omitted']).toBe(648 - MAX_DESCRIBED_OPTIONS);
  });
});

describe('a list’s rows that take the same value', () => {
  const TRANSITIONS = Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, title: `Transition ${i}`, description: `What transition ${i} looks like` }));
  const schema = deriveValueSchema('choice', { options: TRANSITIONS });
  const row = (key: string, value: string): ControlRegistration => ({
    id: 'form.shot.transition',
    kind: 'choice',
    title: 'Transition',
    item: { key, title: `Shot ${key}` },
    valueSchema: schema,
    value,
    run: () => ({ ok: true }),
  });

  it('leave their schema to the action: each row is its key, title and value', () => {
    const state = pageState([row('a', 't1'), row('b', 't2')]);
    expect(state.lists['form.shot.transition']).toEqual([
      { key: 'a', title: 'Shot a', value: 't1' },
      { key: 'b', title: 'Shot b', value: 't2' },
    ]);
  });

  it('stop the page state growing with the square of the form', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`shot-${i}`, 't1'));
    const size = (n: number) => JSON.stringify(pageState(rows(n))).length;
    // Twice the rows, about twice the size; the schema is not paid again per row.
    expect(size(40) / size(20)).toBeLessThan(2.1);
    expect(size(20)).toBeLessThan(20 * 80);
  });

  it('keep a row’s value schema when one row differs, so a row’s own range stays readable', () => {
    const other = { ...row('c', 't1'), valueSchema: deriveValueSchema('number', { min: 0, max: 1 }) };
    const state = pageState([row('a', 't1'), other]);
    const [first, second] = state.lists['form.shot.transition'];
    expect(first.schema).toEqual(schema);
    expect(second.schema).toEqual(deriveValueSchema('number', { min: 0, max: 1 }));
  });

  it('leave a row that takes no value as it was', () => {
    const press: ControlRegistration = { id: 'form.remove', kind: 'button', title: 'Remove', item: { key: 'a', title: 'Shot a' }, valueSchema: null, run: () => ({ ok: true }) };
    expect(pageState([press]).lists['form.remove']).toEqual([{ key: 'a', title: 'Shot a' }]);
  });
});
