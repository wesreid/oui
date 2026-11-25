/**
 * What a recording's fingerprint holds of the agent's UI settings
 * (`fingerprintedUiActions`): settings with no function exactly as they are,
 * so recordings made before 0.41.1 stay current; a host's digest function by
 * the name it is given (`stateDigestId`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import type { RegisteredTool } from '@ouispec/agent-worker';
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

describe('a recording’s fingerprint of a trailer tool', () => {
  const note: RegisteredTool = {
    name: 'note',
    effect: 'edit',
    answerless: true,
    description: 'Write one line in this chat’s work notes.',
    inputSchema: {
      type: 'object',
      sideEffects: false,
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['decision', 'task', 'made'] }, text: { type: 'string' } },
    },
    execute: async () => ({ success: true }),
  };

  it('is what it was for an answerless tool that is not a trailer: pinned', () => {
    expect(fingerprint({ ...inputs(), tools: [note] })).toBe(PINNED.answerlessNote);
    expect(fingerprint({ ...inputs(), tools: [{ ...note, trailer: false }] })).toBe(PINNED.answerlessNote);
  });

  it('changes when the tool is written as a trailer, which changes what the model is sent', () => {
    expect(fingerprint({ ...inputs(), tools: [{ ...note, trailer: true }] })).not.toBe(PINNED.answerlessNote);
  });
});

/** Taken from 0.41.0's fingerprint of the same inputs, before function digests were held by name. */
const PINNED = {
  none: '03bc2fd2406fae3c7dd6151e521544d420cec9c339f75016ea69c3eca8b3f4a2',
  plain: 'dc2bd8dcb5b855ba5aa32a3a0aa12579f04f0c5d9ed9e0d33d4230c9e7a263ac',
  /** Taken from 0.41.1, before trailer tools: an answerless `note`. */
  answerlessNote: '41634dba379e669962922625fe3505485dd3a6398986dcd279b75c7bdbec99aa',
};
