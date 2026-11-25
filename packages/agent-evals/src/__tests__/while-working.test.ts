/**
 * What an agent writes while it works (`whileWorking`): the text of each step
 * it went on from, before that step's calls, never its last step. A host that
 * lets the person choose how much the agent explains holds each level to it:
 * one that explains names what it uses before acting, one that gives results
 * only writes nothing until its answer.
 *
 * The record (`workingOf`), the check, and a whole case recorded from a
 * scripted model through OpenAI's real provider package and replayed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvalSuite } from '@ouispec/contract';
import type { TurnMessage } from '@ouispec/agent-worker';
import type { ChatRequest, ScriptedReply } from '@ouispec/agent-worker/testing';
import { check, runEvals, workingOf, type EvalTurnRecord } from '../run.js';
import { matchersOf } from '../suite.js';
import { configFor, lastRole, lastUser, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));

const call = (id: string, name = 'lookup') => ({ id, name, arguments: { stock: 'T1' } });

describe('workingOf: what a turn wrote while it worked', () => {
  it('is the text of each step it went on from, before that step’s calls, in order', () => {
    const messages: TurnMessage[] = [
      { role: 'assistant', content: 'For a price we use the stock lookup. Let me check T1.', toolCalls: [call('c1')] },
      { role: 'tool', content: '{"success":true}', toolCallId: 'c1', name: 'lookup' },
      { role: 'assistant', content: null, toolCalls: [call('c2')] },
      { role: 'tool', content: '{"success":true}', toolCallId: 'c2', name: 'lookup' },
      { role: 'assistant', content: '  Now the second unit.  ', toolCalls: [call('c3')] },
      { role: 'tool', content: '{"success":true}', toolCallId: 'c3', name: 'lookup' },
      { role: 'assistant', content: 'T1 is $10,000.' },
    ];
    expect(workingOf(messages)).toBe('For a price we use the stock lookup. Let me check T1.\n\nNow the second unit.');
  });

  it('never holds the last step: the answer, or the text before the card it ends on', () => {
    expect(workingOf([{ role: 'assistant', content: 'T1 is $10,000.' }])).toBe('');
    const endsOnCard: TurnMessage[] = [
      { role: 'assistant', content: null, toolCalls: [call('c1')] },
      { role: 'tool', content: '{"success":true}', toolCallId: 'c1', name: 'lookup' },
      { role: 'assistant', content: 'Which colour?', toolCalls: [call('c2', 'present_options')] },
    ];
    expect(workingOf(endsOnCard)).toBe('');
    expect(workingOf([])).toBe('');
  });
});

describe('the whileWorking check', () => {
  const record = (working: string): EvalTurnRecord =>
    ({ turn: 0, kind: 'user', customer: 'price of T1?', reply: `${working}\n\nT1 is $10,000.`.trim(), working, toolCalls: [], approval: null, held: false, choices: [], page: null }) as unknown as EvalTurnRecord;
  const failed = async (expectation: Parameters<typeof check>[0], working: string) =>
    (await check(expectation, record(working), '', null)).map((f) => [f.assertion, f.message]);

  it('holds silent: true only when nothing was written while working, and silent: false only when something was', async () => {
    expect(await failed({ whileWorking: { silent: true } }, '')).toEqual([]);
    expect(await failed({ whileWorking: { silent: true } }, 'Let me check.')).toEqual([['whileWorking', 'it wrote while it worked: "Let me check."']]);
    expect(await failed({ whileWorking: { silent: false } }, 'Let me check.')).toEqual([]);
    expect(await failed({ whileWorking: { silent: false } }, '   ')).toEqual([['whileWorking', 'it wrote nothing while it worked']]);
  });

  it('matches says and mustNotSay against what was written while working, not the answer', async () => {
    const working = 'For a price we use the stock lookup.';
    expect(await failed({ whileWorking: { says: ['stock lookup'], mustNotSay: ['$10,000'] } }, working)).toEqual([]);
    expect(await failed({ whileWorking: { says: ['10,000'] } }, working)).toEqual([
      ['whileWorking', `what it wrote while it worked does not match "10,000": "${working}"`],
    ]);
    expect(await failed({ whileWorking: { mustNotSay: [{ pattern: 'stock', flags: 'i' }] } }, working)).toEqual([
      ['whileWorking', `what it wrote while it worked matches /stock/i: "${working}"`],
    ]);
  });

  it('counts its rubrics among the turn’s matchers, so a judge is asked and the recording is fingerprinted by them', () => {
    expect(matchersOf({ whileWorking: { says: [{ rubric: 'Names the feature before acting.' }], mustNotSay: ['oops'] } })).toEqual([
      { rubric: 'Names the feature before acting.' },
      'oops',
    ]);
  });
});

describe('a case held to what it writes while it works, recorded and replayed (acceptance)', () => {
  const SUITE: AgentEvalSuite = {
    version: 1,
    name: 'narration evals',
    stubs: { lookup: [{ when: { stock: 'T1' }, result: { success: true, data: { stock: 'T1', price: '$10,000' } } }] },
    scenarios: [
      {
        id: 'explains',
        title: 'Says what it uses before it looks the unit up',
        context: { level: 'explain' },
        turns: [{ user: 'What is the price of T1?', expect: { whileWorking: { silent: false, says: ['stock lookup'] }, says: ['10,000'] } }],
      },
      {
        id: 'results-only',
        title: 'Writes nothing until its answer',
        context: { level: 'results' },
        turns: [{ user: 'And the price of T1, quietly?', expect: { whileWorking: { silent: true }, says: ['10,000'] } }],
      },
    ],
  };
  /** Explains before its call when asked plainly; says nothing before it when asked quietly. */
  const narrating = (request: ChatRequest): ScriptedReply | undefined => {
    const said = lastUser(request);
    if (lastRole(request) === 'tool') return { text: 'T1 is $10,000.' };
    if (said.includes('quietly')) return { toolCalls: [{ id: 'call_q', name: 'lookup', args: { stock: 'T1' } }] };
    if (said.includes('price of T1')) return { text: 'For a price we use the stock lookup. Let me check T1.', toolCalls: [{ id: 'call_e', name: 'lookup', args: { stock: 'T1' } }] };
    return undefined;
  };
  /** The opposite of each: silent where it should explain, chatty where it should be quiet. */
  const contrary = (request: ChatRequest): ScriptedReply | undefined => {
    const said = lastUser(request);
    if (lastRole(request) === 'tool') return { text: 'T1 is $10,000.' };
    if (said.includes('quietly')) return { text: 'Checking the stock lookup now.', toolCalls: [{ id: 'call_q', name: 'lookup', args: { stock: 'T1' } }] };
    if (said.includes('price of T1')) return { toolCalls: [{ id: 'call_e', name: 'lookup', args: { stock: 'T1' } }] };
    return undefined;
  };

  it('passes an agent that does what each level asks, recorded and then replayed with no network', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, { suites: [SUITE], channels: { web_chat: { approvals: 'ui' } } });
    const recorded = (await recordWith(narrating, () => runEvals(config, { mode: 'record' }))).result;
    expect(recorded.cases.map((c) => [c.scenario, c.passed, c.failures])).toEqual([
      ['explains', true, []],
      ['results-only', true, []],
    ]);
    const explains = recorded.cases.find((c) => c.scenario === 'explains')!;
    expect(explains.turns[0]).toMatchObject({ working: 'For a price we use the stock lookup. Let me check T1.', reply: expect.stringContaining('T1 is $10,000.') });
    expect(recorded.cases.find((c) => c.scenario === 'results-only')!.turns[0].working).toBe('');

    const replayed = await runEvals(config);
    expect(replayed.mode).toBe('replay');
    expect(replayed.failed).toBe(0);
  });

  it('fails an agent that does the opposite, by name, in each case', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, { suites: [SUITE], channels: { web_chat: { approvals: 'ui' } } });
    const report = (await recordWith(contrary, () => runEvals(config, { mode: 'record' }))).result;
    const failures = new Map(report.cases.map((c) => [c.scenario, c.failures.map((f) => f.message)]));
    expect(failures.get('explains')).toEqual(['it wrote nothing while it worked', 'what it wrote while it worked does not match "stock lookup": ""']);
    expect(failures.get('results-only')).toEqual(['it wrote while it worked: "Checking the stock lookup now."']);
  });
});
