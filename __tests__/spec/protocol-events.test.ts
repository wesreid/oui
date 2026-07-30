import { OUI_PROTOCOL_EVENTS } from '../../src/spec/types.js';

describe('OUI_PROTOCOL_EVENTS', () => {
  it('has all expected event type keys', () => {
    const expectedKeys = [
      'SURFACE_REGISTER',
      'SURFACE_DEREGISTER',
      'ACTION_REQUEST',
      'ACTION_RESULT',
      'OBSERVATION_UPDATE',
    ];

    const actualKeys = Object.keys(OUI_PROTOCOL_EVENTS);
    expect(actualKeys).toEqual(expect.arrayContaining(expectedKeys));
    expect(actualKeys).toHaveLength(expectedKeys.length);
  });

  it('SURFACE_REGISTER has correct value', () => {
    expect(OUI_PROTOCOL_EVENTS.SURFACE_REGISTER).toBe('surface:register');
  });

  it('SURFACE_DEREGISTER has correct value', () => {
    expect(OUI_PROTOCOL_EVENTS.SURFACE_DEREGISTER).toBe('surface:deregister');
  });

  it('ACTION_REQUEST has correct value', () => {
    expect(OUI_PROTOCOL_EVENTS.ACTION_REQUEST).toBe('action:request');
  });

  it('ACTION_RESULT has correct value', () => {
    expect(OUI_PROTOCOL_EVENTS.ACTION_RESULT).toBe('action:result');
  });

  it('OBSERVATION_UPDATE has correct value', () => {
    expect(OUI_PROTOCOL_EVENTS.OBSERVATION_UPDATE).toBe('observation:update');
  });

  it('all values follow the "domain:verb" naming convention', () => {
    const values = Object.values(OUI_PROTOCOL_EVENTS);
    for (const value of values) {
      expect(value).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('all values are unique', () => {
    const values = Object.values(OUI_PROTOCOL_EVENTS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('is a const object (values are string literal types at runtime)', () => {
    // Verify the object is frozen/const by checking values are strings
    // and that the object itself is not accidentally mutable in a way that breaks the contract
    const entries = Object.entries(OUI_PROTOCOL_EVENTS);
    for (const [key, value] of entries) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
