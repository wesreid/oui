/**
 * What a recording's fingerprint holds of the agent's UI settings
 * (`fingerprintedUiActions`): settings with no function exactly as they are,
 * so recordings made before 0.41.1 stay current; a host's digest function by
 * the name it is given (`stateDigestId`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import { fingerprint, fingerprintedUiActions, type FingerprintInputs } from '../cassettes.js';

const scenario: AgentEvalScenario = { id: 'one', title: 'One turn', turns: [{ user: 'Hello' }] };
const suite: AgentEvalSuite = { version: 1, name: 'pinned', scenarios: [scenario] };
const inputs = (uiActions?: unknown): FingerprintInputs => ({
  systemPrompt: 'You help.',
  tools: [],
  channel: { name: 'web_chat', settings: { approvals: 'ui' } },
  suite,
  scenario,
  ...(uiActions !== undefined ? { uiActions } : {}),
});

describe('a recording’s fingerprint of the agent’s UI settings', () => {
  it('is what it was for settings with no function: pinned', () => {
    expect(fingerprint(inputs())).toBe(PINNED.none);
    expect(fingerprint(inputs({ maxIndexChars: 100, stateDigest: false }))).toBe(PINNED.plain);
    expect(fingerprintedUiActions({ maxIndexChars: 100, stateDigest: false })).toEqual({ maxIndexChars: 100, stateDigest: false });
  });

  it('holds a digest function by its stateDigestId: the same name, the same fingerprint; another, another', () => {
    const one = () => 'a';
    const other = () => 'b';
    expect(fingerprintedUiActions({ maxIndexChars: 100, stateDigest: one, stateDigestId: 'facts-v1' })).toEqual({
      maxIndexChars: 100,
      stateDigest: { id: 'facts-v1' },
    });
    const v1 = fingerprint(inputs({ stateDigest: one, stateDigestId: 'facts-v1' }));
    expect(fingerprint(inputs({ stateDigest: other, stateDigestId: 'facts-v1' }))).toBe(v1);
    expect(fingerprint(inputs({ stateDigest: one, stateDigestId: 'facts-v2' }))).not.toBe(v1);
    // Neither the default digest nor none.
    expect(v1).not.toBe(fingerprint(inputs()));
    expect(v1).not.toBe(fingerprint(inputs({ stateDigest: false })));
  });

  it('refuses a digest function with no name, or an empty one, naming the field', () => {
    for (const uiActions of [{ stateDigest: () => 'a' }, { stateDigest: () => 'a', stateDigestId: ' ' }]) {
      expect(() => fingerprint(inputs(uiActions))).toThrow(
        '[agent-evals] uiActions.stateDigest is a function, which a recording cannot be fingerprinted by: give uiActions.stateDigestId, a name for what it writes (change it whenever what it writes changes)',
      );
    }
  });
});

/** Taken from 0.41.0's fingerprint of the same inputs, before function digests were held by name. */
const PINNED = {
  none: '03bc2fd2406fae3c7dd6151e521544d420cec9c339f75016ea69c3eca8b3f4a2',
  plain: 'dc2bd8dcb5b855ba5aa32a3a0aa12579f04f0c5d9ed9e0d33d4230c9e7a263ac',
};
