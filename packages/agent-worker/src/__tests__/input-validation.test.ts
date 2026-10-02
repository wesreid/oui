import { describe, expect, it } from 'vitest';
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

  it('fails closed when the schema itself cannot be compiled', () => {
    const broken = createToolInputValidator({ type: 'object', properties: { a: { type: 'not-a-type' } } });
    const result = broken({ a: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors[0]).toMatch(/^this tool's input schema is invalid/);
  });
});
