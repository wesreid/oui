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

import { choicesLine, deriveValueSchema, liveOptions, MAX_DESCRIBED_OPTIONS, validateValue, type ControlRegistration } from '../src/index.js';
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

describe('a room’s choices known only at run time', () => {
  // A room's action takes its catalog's declaration ("The option to choose", no options), not the control's live
  // schema: a Storyboard line's languages, a shot's points. Before, they reached the assistant nowhere.
  const LANGUAGES_NOW = [
    { value: 'en', title: 'English' },
    { value: 'fr', title: 'French' },
  ];
  const DECLARED = { type: 'string', description: 'The option to choose' } as const;
  const line = (key: string, value: string, options = LANGUAGES_NOW): ControlRegistration => ({
    id: 'editor.storyboard.line.language',
    kind: 'choice',
    title: 'Language',
    item: { key, title: `Line ${key}` },
    valueSchema: deriveValueSchema('choice', { options }),
    options: liveOptions('choice', { options }),
    value,
    run: () => ({ ok: true }),
  });
  const aspects = [
    { value: '16:9', title: 'Wide', description: 'For a landscape screen' },
    { value: '1:1', title: '1:1' },
  ];
  const format: ControlRegistration = {
    id: 'editor.storyboard.format.aspect',
    kind: 'choice',
    title: 'Shape',
    valueSchema: deriveValueSchema('choice', { options: aspects }),
    options: liveOptions('choice', { options: aspects }),
    value: '16:9',
    run: () => ({ ok: true }),
  };
  const declared = (id: string) => (id.startsWith('editor.storyboard.') ? DECLARED : undefined);

  it('are named once per control, in a line, for a list’s rows and a field alike, where the declaration lists none', () => {
    const state = pageState([line('l1', 'en'), line('l2', 'fr'), format], () => false, { declaredValue: declared });
    expect(state.choices).toEqual({
      'editor.storyboard.line.language': 'en = English; fr = French',
      // A title that is its value is said once; what an option means is its action's to say.
      'editor.storyboard.format.aspect': '16:9 = Wide; 1:1',
    });
    // The rows themselves stay their key, title and value.
    expect(state.lists['editor.storyboard.line.language']).toEqual([
      { key: 'l1', title: 'Line l1', value: 'en' },
      { key: 'l2', title: 'Line l2', value: 'fr' },
    ]);
  });

  it('name the first twenty and the current one, and say how many more', () => {
    const state = pageState([line('l1', 'lang_400', LANGUAGES)], () => false, { declaredValue: declared });
    const named = state.choices!['editor.storyboard.line.language'];
    expect(named.startsWith('lang_0 = Language 0; lang_1 = Language 1;')).toBe(true);
    expect(named.endsWith('lang_19 = Language 19; lang_400 = Language 400; and 627 more')).toBe(true);
    expect(choicesLine(LANGUAGES.slice(0, 2), 'lang_1')).toBe('lang_0 = Language 0; lang_1 = Language 1');
  });

  it('are left to the declaration that lists them, to a row that carries its own, and to a page’s own controls', () => {
    const listed = { ...DECLARED, enum: ['en', 'fr'] };
    expect(pageState([line('l1', 'en')], () => false, { declaredValue: () => listed }).choices).toBeUndefined();
    const differing = [line('l1', 'en'), line('l2', 'en', [{ value: 'de', title: 'German' }])];
    expect(pageState(differing, () => false, { declaredValue: declared }).choices).toBeUndefined();
    // A page's control offers its live schema in its definition: nothing to add.
    expect(pageState([line('l1', 'en'), format]).choices).toBeUndefined();
  });

  it('come from the live schema’s values for a control that registered no options', () => {
    const { options: _options, ...bare } = format;
    expect(pageState([bare], () => false, { declaredValue: declared }).choices).toEqual({
      'editor.storyboard.format.aspect': '16:9; 1:1',
    });
  });
});
