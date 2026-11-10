import { describe, expect, it } from 'vitest';
import { deriveInputSchema } from '@ouispec/bindings';
import { createToolInputValidator } from '../tools/input-validation.js';

const speakSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    voice_id: { type: 'string' },
    seed: { type: 'integer' },
  },
  required: ['text'],
  additionalProperties: false,
};

describe('createToolInputValidator', () => {
  const validate = createToolInputValidator(speakSchema);

  it('accepts input that matches the schema', () => {
    expect(validate({ text: 'hello', seed: 7 })).toEqual({
      ok: true,
      value: { text: 'hello', seed: 7 },
    });
  });

  it('rejects a missing required property', () => {
    expect(validate({ voice_id: 'v1' })).toEqual({
      ok: false,
      errors: ['(input) is missing required property "text"'],
    });
  });

  it('rejects a wrong type', () => {
    expect(validate({ text: 42 })).toEqual({ ok: false, errors: ['/text must be string'] });
  });

  it('rejects a property the schema does not declare', () => {
    expect(validate({ text: 'hello', accountId: 'someone-else' })).toEqual({
      ok: false,
      errors: ['(input) has a property this tool does not accept: "accountId"'],
    });
  });

  it('reports every error, not just the first', () => {
    const result = validate({ seed: 'seven', accountId: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toHaveLength(3);
  });

  it('allows undeclared properties when the schema does not forbid them', () => {
    const open = createToolInputValidator({ type: 'object', properties: { a: { type: 'string' } } });
    expect(open({ a: 'x', b: 'y' })).toEqual({ ok: true, value: { a: 'x', b: 'y' } });
  });

  it('drops null on an optional property, as if it were omitted', () => {
    expect(validate({ text: 'hello', voice_id: null })).toEqual({
      ok: true,
      value: { text: 'hello' },
    });
  });

  it('does not accept null for a required property', () => {
    expect(validate({ text: null }).ok).toBe(false);
  });

  it('ignores the SDK sideEffects flag, a foreign $schema draft and $id', () => {
    const withExtras = { ...speakSchema, sideEffects: false, $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'speak' };
    expect(createToolInputValidator(withExtras)({ text: 'hi' }).ok).toBe(true);
    // A second schema with the same $id must not collide.
    expect(createToolInputValidator(withExtras)({ text: 'hi' }).ok).toBe(true);
  });

  it('validates string formats', () => {
    const uri = createToolInputValidator({
      type: 'object',
      properties: { redirectUri: { type: 'string', format: 'uri' } },
    });
    expect(uri({ redirectUri: 'https://app.example.com/callback' }).ok).toBe(true);
    expect(uri({ redirectUri: 'not a uri' })).toEqual({
      ok: false,
      errors: ['/redirectUri must match format "uri"'],
    });
  });

  it('rejects input that is not an object', () => {
    expect(validate('text')).toEqual({ ok: false, errors: ['(input) must be an object'] });
    expect(validate(null)).toEqual({ ok: false, errors: ['(input) must be an object'] });
  });

  // Three calls of one session sent a list or an object as JSON text, and were refused.
  describe('a list or an object sent as JSON text', () => {
    const setProperties = createToolInputValidator({
      type: 'object',
      required: ['ids', 'values'],
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        values: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false },
        fill: { oneOf: [{ type: 'object', properties: { kind: { const: 'solid' } } }, { type: 'array', items: { type: 'object' } }] },
        note: { type: 'string' },
        label: { type: ['string', 'array'] },
      },
    });

    it('is read as what it spells, and the validator says which properties were', () => {
      expect(setProperties({ ids: '["layer-1","layer-2"]', values: ' {"x": 120} ', fill: '{"kind":"solid"}' })).toEqual({
        ok: true,
        value: { ids: ['layer-1', 'layer-2'], values: { x: 120 }, fill: { kind: 'solid' } },
        coerced: ['ids', 'values', 'fill'],
      });
    });

    it('is still refused when what it spells is not valid either, with the error of the input as it was sent', () => {
      expect(setProperties({ ids: '[]', values: '{"x":1}' })).toEqual({
        ok: false,
        errors: ['/ids must be array', '/values must be object'],
      });
      expect(setProperties({ ids: '["a"', values: {} })).toEqual({ ok: false, errors: ['/ids must be array'] });
    });

    it('leaves a string alone where the schema takes a string, even one that spells a list', () => {
      expect(setProperties({ ids: ['a'], values: {}, note: '["not","a","list"]', label: '["x"]' })).toEqual({
        ok: true,
        value: { ids: ['a'], values: {}, note: '["not","a","list"]', label: '["x"]' },
      });
    });

    it('reports nothing coerced for input that was valid as sent', () => {
      const result = setProperties({ ids: ['a'], values: { x: 1 } });
      expect(result).toEqual({ ok: true, value: { ids: ['a'], values: { x: 1 } } });
    });
  });

  describe('a number on a step (multipleOf)', () => {
    // The schema a slider stepping by 0.05 from 0 to 1 gets from its binding.
    const trait = createToolInputValidator(deriveInputSchema('number', { min: 0, max: 1, step: 0.05 }) as Record<string, unknown>);

    it('takes every value on the step, which exact division refused for 0.7 (0.7 / 0.05 = 13.999999999999998)', () => {
      expect(0.7 / 0.05).not.toBe(14);
      expect(trait({ value: 0.7 })).toEqual({ ok: true, value: { value: 0.7 } });
      for (let i = 0; i <= 20; i++) {
        const value = Number((i * 0.05).toFixed(2));
        expect([value, trait({ value }).ok]).toEqual([value, true]);
      }
    });

    it('still refuses a value off the step, and one out of range', () => {
      expect(trait({ value: 0.71 })).toEqual({ ok: false, errors: ['/value must be multiple of 0.05'] });
      expect(trait({ value: 1.05 })).toEqual({ ok: false, errors: ['/value must be <= 1'] });
    });

    it('holds for other steps a control declares', () => {
      const tenth = createToolInputValidator(deriveInputSchema('number', { min: 0, max: 10, step: 0.1 }) as Record<string, unknown>);
      expect(tenth({ value: 0.3 }).ok).toBe(true);
      expect(tenth({ value: 2.3 }).ok).toBe(true);
      expect(tenth({ value: 0.35 }).ok).toBe(false);
      const whole = createToolInputValidator(deriveInputSchema('number', { min: 0, max: 100, step: 5 }) as Record<string, unknown>);
      expect(whole({ value: 35 }).ok).toBe(true);
      expect(whole({ value: 36 }).ok).toBe(false);
    });
  });

  it('fails closed when the schema itself cannot be compiled', () => {
    const broken = createToolInputValidator({ type: 'object', properties: { a: { type: 'not-a-type' } } });
    const result = broken({ a: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors[0]).toMatch(/^this tool's input schema is invalid/);
  });
});
