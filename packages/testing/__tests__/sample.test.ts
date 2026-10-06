/**
 * The kit's sampled values: valid against a control's schema, so running the
 * control is a change it must forward.
 */
import { describe, expect, it } from 'vitest';
import { sampleValue } from '../src/sample.js';

describe('a sampled value for a control that takes an attached file', () => {
  it('is a file of a type it accepts, as the person’s own choice gives it; or text, when it takes the file’s text', () => {
    const file = sampleValue({ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/png', 'image/jpeg'] } } as never);
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe('image/png');
    expect(sampleValue({ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/*'] } } as never)).toMatchObject({ type: 'image/png' });
    expect(typeof sampleValue({ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'text' } } as never)).toBe('string');
  });
});
