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

function languageRow(value: string): ControlRegistration {
  return {
    id: 'design.model-param.language',
    kind: 'choice',
    title: 'Language',
    item: { key: 'language', title: 'Language' },
    valueSchema: deriveValueSchema('choice', { options: LANGUAGES }),
    value,
    run: () => ({ ok: true }),
  };
}

describe('a long enum in the page state', () => {
  it('keeps twenty values and the current one, says how many are left out, and stays small', () => {
    const full = languageRow('lang_400');
    const state = pageState([full]);
    const schema = state.lists['design.model-param.language'][0].schema!;

    expect(schema.enum).toEqual([...LANGUAGES.slice(0, MAX_DESCRIBED_OPTIONS).map(l => l.value), 'lang_400']);
    expect(schema['x-enum-omitted']).toBe(648 - 21);
    expect(JSON.stringify(state).length).toBeLessThan(2_000);
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
    const schema = pageState([languageRow('lang_2')]).lists['design.model-param.language'][0].schema!;
    expect(schema.enum).toHaveLength(MAX_DESCRIBED_OPTIONS);
    expect(schema['x-enum-omitted']).toBe(648 - MAX_DESCRIBED_OPTIONS);
  });
});
