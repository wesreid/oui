/**
 * A turn's description carries the context its client sent, so a host's
 * policy can read its own keys (a preference for how a turn hands back), and
 * whether the client started the turn itself to carry on (`autoContinue`).
 */
import { describe, expect, it } from 'vitest';
import { autoContinueOf, turnInfoOf } from '../runtime/turn-info.js';

describe('a turn’s description', () => {
  it('carries the client’s context as it came, and null when it sent none', () => {
    const context = { paAutonomy: 'done', autoContinue: 3, input: { mode: 'voice', language: 'fr' } };
    expect(turnInfoOf({ turnId: 't1', context }, 'container')).toEqual({
      id: 't1',
      channel: 'container',
      inputMode: 'voice',
      language: 'fr',
      approvalChannel: 'ui',
      context,
      autoContinue: 3,
    });
    expect(turnInfoOf({ turnId: 't2' }, undefined)).toMatchObject({ context: null, autoContinue: 0 });
    expect(turnInfoOf({ turnId: 't3', context: null }, undefined)).toMatchObject({ context: null, autoContinue: 0 });
  });

  it('reads autoContinue only as a positive integer: anything else is a turn the person started', () => {
    expect(autoContinueOf({ autoContinue: 1 })).toBe(1);
    expect(autoContinueOf({ autoContinue: 10 })).toBe(10);
    for (const n of [0, -1, 1.5, '2', true, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(autoContinueOf({ autoContinue: n })).toBe(0);
    }
    expect(autoContinueOf({})).toBe(0);
    expect(autoContinueOf(null)).toBe(0);
    expect(autoContinueOf(undefined)).toBe(0);
  });
});
