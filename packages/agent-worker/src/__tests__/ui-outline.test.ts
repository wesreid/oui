/**
 * A definition the model can read (ADR-0245 §2.3): a schema past a size is
 * given in outline and opened by path, so an action that takes a whole
 * catalogue (an effect union of 94 KB) costs a few hundred tokens to describe.
 */
import { describe, expect, it } from 'vitest';
import { describeSchema, discriminatorOf, schemaAt, WHOLE_SCHEMA_CHARS } from '../ui/outline.js';

/** An effect catalogue as a room declares it: one member per effect, told apart by `effect`. */
function effectUnion(effects: number, paramsEach: number) {
  return {
    oneOf: Array.from({ length: effects }, (_, e) => ({
      type: 'object',
      title: `Effect ${e}`,
      required: ['effect', 'layerId'],
      properties: {
        effect: { const: `effect-${e}` },
        layerId: { type: 'string', 'x-ref': 'layers', description: 'The layer the effect is added to.' },
        ...Object.fromEntries(
          Array.from({ length: paramsEach }, (_, p) => [
            `param_${p}`,
            {
              type: 'number',
              minimum: 0,
              maximum: 100,
              'x-unit': 'px',
              'x-space': 'artboard',
              description: `Parameter ${p} of effect ${e}: how far it reaches at the playhead.`,
            },
          ]),
        ),
      },
    })),
  };
}

describe('describeSchema', () => {
  it('returns a small schema whole', () => {
    const schema = { type: 'object', required: ['value'], properties: { value: { type: 'number', minimum: 0, maximum: 100 } } };
    expect(describeSchema(schema)).toEqual({ text: JSON.stringify(schema), whole: true });
    expect(describeSchema(undefined)).toEqual({ text: '{"type":"object","properties":{}}', whole: true });
  });

  it('outlines a union of sixty effects by what tells them apart, within the size', () => {
    const schema = effectUnion(60, 12);
    expect(JSON.stringify(schema).length).toBeGreaterThan(90_000);
    const view = describeSchema(schema);
    if ('error' in view) throw new Error(view.error);
    expect(view.whole).toBe(false);
    expect(view.text.length).toBeLessThanOrEqual(WHOLE_SCHEMA_CHARS);
    const lines = view.text.split('\n');
    expect(lines[0]).toBe('one of 60 by effect');
    expect(lines[1]).toBe('Members, by effect (open one with path "effect=<value>"):');
    expect(lines[2]).toBe('- effect-0 — Effect 0 (13 more fields)');
    expect(view.text).toContain('- effect-59 — Effect 59 (13 more fields)');
  });

  it('opens one member by its discriminator value, with every unit, space and reference kept', () => {
    const view = describeSchema(effectUnion(60, 12), { path: 'effect=effect-7' });
    if ('error' in view) throw new Error(view.error);
    // One member is small enough to be given whole: the exact schema the page validates against.
    expect(view.whole).toBe(true);
    const member = JSON.parse(view.text);
    expect(member.properties.effect).toEqual({ const: 'effect-7' });
    expect(member.properties.param_3).toMatchObject({ 'x-unit': 'px', 'x-space': 'artboard', minimum: 0, maximum: 100 });
    expect(member.properties.layerId['x-ref']).toBe('layers');
  });

  it('outlines an object of many properties a line each, required first, and says how to open the nested ones', () => {
    const schema = {
      type: 'object',
      description: 'Sets properties of the selected layers.',
      required: ['ids'],
      properties: {
        ...Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [
            `prop_${i}`,
            { type: 'number', minimum: 0, maximum: 10, 'x-unit': '%', description: `Property ${i} of the layer, as a share of its size. `.repeat(3) },
          ]),
        ),
        ids: { type: 'array', items: { type: 'string', 'x-ref': 'layers' }, description: 'The layers to change.' },
        fill: {
          type: 'object',
          description: 'The fill paint.',
          properties: { kind: { enum: ['solid', 'linear', 'radial'] }, colour: { type: 'string' }, stops: { type: 'array', items: { type: 'object', properties: { at: { type: 'number' } } } } },
        },
      },
    };
    const view = describeSchema(schema);
    if ('error' in view) throw new Error(view.error);
    expect(view.whole).toBe(false);
    const lines = view.text.split('\n');
    expect(lines[0]).toBe('object (62 properties) — Sets properties of the selected layers.');
    expect(lines[1]).toBe('Properties (62):');
    expect(lines[2]).toBe('- ids (required): list of string — The layers to change.');
    expect(view.text).toContain('- prop_0: number 0–10 [unit: %] — Property 0 of the layer, as a share of its size.');
    expect(view.text.length).toBeLessThanOrEqual(WHOLE_SCHEMA_CHARS);
    // Rows that did not fit are counted, never silently dropped.
    expect(lines.at(-1)).toMatch(/^- … and \d+ more, not listed: open a part by its path to read it$/);

    const fill = describeSchema(schema, { path: 'fill' });
    if ('error' in fill) throw new Error(fill.error);
    expect(JSON.parse(fill.text).properties.kind).toEqual({ enum: ['solid', 'linear', 'radial'] });
    const stop = describeSchema(schema, { path: 'fill.stops.[]' });
    if ('error' in stop) throw new Error(stop.error);
    expect(JSON.parse(stop.text)).toEqual({ type: 'object', properties: { at: { type: 'number' } } });
  });

  it('says what a path does not name, and what is there instead', () => {
    const schema = effectUnion(3, 1);
    expect(describeSchema(schema, { path: 'effect=nope' })).toEqual({
      error: 'the input has no member with effect = "nope". Its members are told apart by effect: effect-0, effect-1, effect-2',
    });
    expect(describeSchema(schema, { path: 'layerId' })).toEqual({
      error: 'the input is a union: open one of its members first (effect=…), then "layerId"',
    });
    expect(describeSchema(schema, { path: 'effect=effect-1.missing' })).toEqual({
      error: '"effect=effect-1" has no property "missing". It has: effect, layerId, param_0',
    });
    expect(describeSchema({ type: 'object', properties: { a: { type: 'string' } } }, { path: 'a.[]' })).toEqual({
      error: '"a" is not a list, so it has no "[]"',
    });
  });

  it('opens a union with no discriminator by position', () => {
    const schema = { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] };
    expect(discriminatorOf(schema.anyOf)).toBeNull();
    expect(schemaAt(schema, '#2')).toEqual({ schema: schema.anyOf[1] });
    expect(schemaAt(schema, '#3')).toEqual({ error: 'the input has no member #3: it has 2' });
  });
});
