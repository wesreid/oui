/**
 * Reading a suite and what it is held to (ADR-0260 §3.2): the contract's
 * schema, the rules a schema cannot state, every problem at once with where
 * it is; and the matchers a reply is held to.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvalSuite } from '@ouispec/contract';
import { checkSuite, readSuiteFile, rubricsOf, EvalSuiteError } from '../suite.js';
import { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from '../matchers.js';
import { mergeExpectations } from '../run.js';
import { scratch } from './support.js';

const dir = scratch();
afterAll(() => dir.cleanup());
const CHANNELS = ['web_chat', 'sms', 'voice'];

const problemsOf = (value: unknown) => {
  try {
    checkSuite(value, 'suite.yaml', CHANNELS);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(EvalSuiteError);
    return [...(err as EvalSuiteError).problems];
  }
};

describe('a suite', () => {
  it('reads from YAML and JSON alike', () => {
    const yaml = join(dir.dir, 'dealer.evals.yaml');
    writeFileSync(
      yaml,
      ['version: 1', 'name: dealer', 'scenarios:', '  - id: hi', '    title: Says hello', '    turns:', '      - user: Hello', '        expect: { says: [hello] }'].join('\n'),
    );
    const json = join(dir.dir, 'dealer.evals.json');
    writeFileSync(json, JSON.stringify(readSuiteFile(yaml)));
    expect(checkSuite(readSuiteFile(json), json, CHANNELS).scenarios[0].turns).toEqual([{ user: 'Hello', expect: { says: ['hello'] } }]);
    const text = join(dir.dir, 'dealer.txt');
    writeFileSync(text, '');
    expect(() => readSuiteFile(text)).toThrow(/a suite is a \.json, \.yaml or \.yml file, not \.txt/);
  });

  it('is held to the contract first, with every problem and where it is', () => {
    const problems = problemsOf({ version: 1, name: 'x', scenarios: [{ id: 'Bad Id', title: 't', turns: [{ user: 'hi', expect: { sayz: [] } }] }] });
    expect(problems.join('\n')).toMatch(/\/scenarios\/0\/id/);
    expect(problems.join('\n')).toMatch(/sayz/);
  });

  it('then to what a schema cannot say', () => {
    const suite: AgentEvalSuite = {
      version: 1,
      name: 'broken',
      channels: ['web_chat', 'fax'],
      scenarios: [
        {
          id: 'a',
          title: 'An approval answered first, and a bad pattern',
          channels: ['sms'],
          turns: [{ approval: 'approve' }, { user: 'hi', expect: { says: [{ pattern: '(' }] }, expectOn: { pager: { says: ['x'] } } }],
        },
        { id: 'a', title: 'The same id', turns: [{ staff: { say: 'Jordan here' } }, { staff: { handBack: true } }] },
        { id: 'c', title: 'Taken twice', turns: [{ staff: { takeOver: { displayName: 'J' } } }, { staff: { takeOver: { displayName: 'K' } } }, { user: 'hi' }] },
      ],
    };
    expect(problemsOf(suite)).toEqual([
      '/channels: channel "fax" is not one the configuration serves (web_chat, sms, voice)',
      '/scenarios/0 (a)/channels: "sms" is not one of the suite\'s channels',
      '/scenarios/0 (a)/turns/0: an approval is answered before any turn could have asked for one',
      expect.stringMatching(/^\/scenarios\/0 \(a\)\/turns\/1\/expect: \/\(\/ is not a regular expression/),
      '/scenarios/0 (a)/turns/1/expectOn/pager: channel "pager" is not one the configuration serves (web_chat, sms, voice)',
      '/scenarios/1 (a): the id "a" is used twice',
      '/scenarios/1 (a)/turns/0: a person writes before anyone has taken the conversation over',
      '/scenarios/1 (a)/turns/1: the conversation is handed back while nobody holds it',
      "/scenarios/1 (a): it has no turn of the agent's to check",
      '/scenarios/2 (c)/turns/1: the conversation is already held',
    ]);
  });

  it('names the rubrics a scenario’s judge reads, which its recording was made answering', () => {
    expect(
      rubricsOf({
        id: 'r',
        title: 'r',
        turns: [{ user: 'hi', expect: { says: [{ rubric: 'greets' }], refusal: { rubric: 'declines' } }, expectOn: { sms: { mustNotSay: [{ rubric: 'uses markdown' }] } } }],
      }),
    ).toEqual(['greets', 'declines', 'uses markdown']);
  });
});

describe('the matchers', () => {
  it('match a string ignoring case, and a pattern with its flags', () => {
    expect(matchesText('Dealer Price', 'the dealer price is $31,995')).toBe(true);
    expect(matchesText({ pattern: '^Hi', flags: 'm' }, 'well\nHi there')).toBe(true);
    expect(matchesText({ pattern: '^Hi' }, 'well\nHi there')).toBe(false);
    expect(describeMatcher({ pattern: 'APR', flags: 'i' })).toBe('/APR/i');
    expect(describeMatcher({ rubric: 'quotes a payment' })).toBe('rubric: quotes a payment');
  });

  it('read the usual phrasing of a refusal, and not a reply that complies', () => {
    const refusal = DEFAULT_REFUSAL as { pattern: string; flags: string };
    for (const reply of ["I can't take that here.", 'I cannot do that.', 'I’m not able to share it.', "I won't apply a discount.", "We don't collect Social Security numbers.", 'That is not allowed.']) {
      expect(matchesText(refusal, reply), reply).toBe(true);
    }
    for (const reply of ['Sure, your SSN is noted.', 'The price is $31,995.', 'Canton is our nearest store.']) {
      expect(matchesText(refusal, reply), reply).toBe(false);
    }
  });

  it('hold arguments as a subset, strings ignoring case and space', () => {
    expect(holdsSubset({ stock: 'T2417', year: 2025 }, { stock: 't2417' })).toBe(true);
    expect(holdsSubset({ when: { day: 'Saturday', time: '9:00' } }, { when: { day: ' saturday ' } })).toBe(true);
    expect(holdsSubset({ stock: 'T2418' }, { stock: 'T2417' })).toBe(false);
    expect(holdsSubset({ tags: ['a', 'b'] }, { tags: ['a'] })).toBe(false);
    expect(holdsSubset({}, { stock: 'T2417' })).toBe(false);
  });

  it('join a turn’s expectations with its channel’s', () => {
    expect(mergeExpectations({ says: ['a'], held: false }, { says: ['b'], mustNotSay: ['c'], held: true })).toEqual({ says: ['a', 'b'], mustNotSay: ['c'], held: true });
    expect(mergeExpectations(undefined, { says: ['b'] })).toEqual({ says: ['b'] });
  });
});
