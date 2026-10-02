import { describe, expect, it } from 'vitest';

import {
  bindingIdProblem,
  catalogData,
  CONTROL_KINDS,
  deriveInputSchema,
  isNarrowing,
  MAX_DESCRIBED_OPTIONS,
  stableStringify,
  toolInputProblems,
  toolName,
  validateValue,
  type RoomCatalog,
} from '../src/index.js';

describe('deriveInputSchema', () => {
  it('gives a button no input', () => {
    expect(deriveInputSchema('button')).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('takes a number field’s range, step and unit from its props', () => {
    const schema = deriveInputSchema('number', { min: 0, max: 100, step: 0.5, unit: '%' });
    expect(schema.properties?.value).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 100,
      multipleOf: 0.5,
      'x-unit': '%',
    });
    expect(schema.properties?.value?.description).toContain('in %, from 0 to 100');
    expect(schema.required).toEqual(['value']);
  });

  it('names at most twenty of a long choice’s options, and keeps every value in the enum', () => {
    const options = Array.from({ length: 300 }, (_, i) => ({ value: `lang_${i}`, title: `Language ${i}` }));
    const value = deriveInputSchema('choice', { options, clearable: true }).properties!.value!;
    expect(MAX_DESCRIBED_OPTIONS).toBe(20);
    expect(value.enum).toEqual([...options.map(o => o.value), null]);
    expect(value.description).toContain('lang_0 = Language 0; ');
    expect(value.description).toContain('lang_19 = Language 19; and 280 more, any of which may be chosen');
    expect(value.description).not.toContain('lang_20 ');
    // The description stays short whatever the option count: about twenty names, not three hundred.
    expect(value.description!.length).toBeLessThan(600);
    // Every value is still a valid choice.
    expect(validateValue(value, 'lang_299')).toBeNull();
  });

  it('names every option of a choice of twenty or fewer, with no "more"', () => {
    const options = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, title: `Option ${i}` }));
    const value = deriveInputSchema('choice', { options }).properties!.value!;
    expect(value.description).toContain('v19 = Option 19');
    expect(value.description).not.toContain('more');
  });

  it('offers a choice’s enabled options and names each one', () => {
    const schema = deriveInputSchema('choice', {
      options: [
        { value: 'user', title: 'My Voices' },
        { value: 'account', title: 'Account Voices' },
        { value: 'gone', title: 'Gone', disabled: true },
      ],
    });
    expect(schema.properties?.value?.enum).toEqual(['user', 'account']);
    expect(schema.properties?.value?.description).toContain('user = My Voices');
  });

  it('lets a clearable choice be cleared with null', () => {
    const value = deriveInputSchema('choice', { options: [{ value: 'arc', title: 'Arc' }], clearable: true })
      .properties?.value;
    expect(value?.enum).toEqual(['arc', null]);
    expect(value?.type).toEqual(['string', 'null']);
  });

  it('accepts a gradient only where the colour control offers one', () => {
    const solid = deriveInputSchema('color').properties?.value;
    expect(solid).toMatchObject({ type: 'string' });
    const gradient = deriveInputSchema('color', { paintKinds: ['solid', 'linear'], allowNone: true })
      .properties?.value;
    expect(gradient?.anyOf).toHaveLength(3);
  });

  it('adds the row a list control is one of', () => {
    const schema = deriveInputSchema('button', {}, { itemized: true, items: [{ key: 'v1', title: 'Ava' }] });
    expect(schema.properties?.item).toMatchObject({ type: 'string', enum: ['v1'] });
    expect(schema.required).toEqual(['item']);
  });
});

describe('isNarrowing', () => {
  const declared = { type: 'number' as const, minimum: 0, maximum: 100 };

  it('accepts a tighter range', () => {
    expect(isNarrowing({ type: 'number', minimum: 10, maximum: 50 }, declared)).toBe(true);
  });

  it('refuses a wider range or another type', () => {
    expect(isNarrowing({ type: 'number', minimum: -1, maximum: 50 }, declared)).toBe(false);
    expect(isNarrowing({ type: 'string' }, declared)).toBe(false);
  });

  it('accepts options drawn from the declared ones and refuses new ones', () => {
    const options = { type: 'string' as const, enum: ['a', 'b', 'c'] };
    expect(isNarrowing({ type: 'string', enum: ['a'] }, options)).toBe(true);
    expect(isNarrowing({ type: 'string', enum: ['a', 'z'] }, options)).toBe(false);
  });
});

describe('validateValue', () => {
  it('names what is wrong', () => {
    expect(validateValue({ type: 'number', minimum: 0, maximum: 10 }, 11)).toBe('value must be at most 10');
    expect(validateValue({ type: 'string', enum: ['a'] }, 'b')).toBe('value must be one of "a"');
    expect(validateValue({ type: 'boolean' }, 'yes')).toBe('value must be boolean');
    expect(validateValue({ type: 'number' }, 4)).toBeNull();
  });

  it('accepts any of several forms', () => {
    const schema = { anyOf: [{ type: 'string' as const }, { type: 'null' as const }] };
    expect(validateValue(schema, null)).toBeNull();
    expect(validateValue(schema, 3)).toContain('matches none');
  });

  it('checks required and unknown properties', () => {
    const schema = {
      type: 'object' as const,
      properties: { family: { type: 'string' as const } },
      required: ['family'],
      additionalProperties: false,
    };
    expect(validateValue(schema, {})).toBe('value.family is required');
    expect(validateValue(schema, { family: 'Inter', size: 3 })).toBe('value has no property "size"');
  });
});

describe('binding ids and tool names', () => {
  it('turns an id into a tool name', () => {
    expect(toolName('voices.detail.use-engine')).toBe('voices_detail_use_engine');
  });

  it('refuses ids that are not dotted lower-kebab', () => {
    expect(bindingIdProblem('voices.library')).toBeNull();
    expect(bindingIdProblem('Voices')).toContain('dotted lower-kebab');
    expect(bindingIdProblem('voices')).toContain('at least two segments');
    expect(bindingIdProblem(`a.${'x'.repeat(70)}`)).toContain('longer than 64');
  });
});

describe('catalogData', () => {
  it('keeps every declaration and drops the functions', () => {
    const catalog: RoomCatalog<{ n: number }> = {
      room: 'demo',
      title: 'Demo',
      description: 'A demo room',
      actions: [
        {
          kind: 'action',
          id: 'add',
          title: 'Add',
          description: 'Adds one',
          control: 'The + button',
          input: { type: 'object', properties: {} },
          effect: 'edit',
          run: () => ({ ok: true }),
        },
      ],
      fields: [
        {
          kind: 'field',
          id: 'size',
          title: 'Size',
          description: 'How big',
          control: 'Design › Size',
          section: { id: 'design', title: 'Design' },
          appliesTo: ['shape'],
          value: { type: 'number', minimum: 1 },
          keyframeable: true,
          read: ctx => ctx.n,
          write: () => ({ ok: true }),
        },
      ],
      commands: [],
      observations: [],
    };
    const data = catalogData(catalog);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.actions[0]).not.toHaveProperty('run');
    expect(data.fields[0]).not.toHaveProperty('read');
    expect(data.fields[0].animation).toEqual({ keyframeable: true });
    // Written before `animation`: its own name is kept for the transition's readers.
    expect(data.fields[0].keyframeable).toBe(true);
  });
});

describe('stableStringify', () => {
  it('writes the same bytes for the same value whatever the key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('toolInputProblems', () => {
  it('takes one object schema, with alternatives inside its properties', () => {
    expect(
      toolInputProblems({
        type: 'object',
        properties: { fill: { oneOf: [{ type: 'string' }, { type: 'object' }] } },
        required: ['fill'],
      }),
    ).toEqual([]);
  });

  it('refuses a union or an intersection at the top level, naming the keyword', () => {
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
      const problems = toolInputProblems({ type: 'object', properties: {}, [keyword]: [{ type: 'object' }] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`has ${keyword} at the top level`));
    }
  });

  it('refuses any top-level type but "object", and a schema with no type', () => {
    expect(toolInputProblems({ type: 'array', items: { type: 'string' } })[0]).toMatch(/type is "array"/);
    expect(toolInputProblems({ type: ['object', 'null'] })[0]).toMatch(/type is \["object","null"\]/);
    expect(toolInputProblems({ properties: {} })[0]).toMatch(/has no type/);
    expect(toolInputProblems(null)).toEqual(['its input is not a JSON schema object']);
  });

  it('passes the input of every kind of control a binding derives', () => {
    for (const kind of CONTROL_KINDS) {
      expect({ kind, problems: toolInputProblems(deriveInputSchema(kind)) }).toEqual({ kind, problems: [] });
      expect({ kind, problems: toolInputProblems(deriveInputSchema(kind, {}, { itemized: true })) }).toEqual({
        kind,
        problems: [],
      });
    }
  });
});
