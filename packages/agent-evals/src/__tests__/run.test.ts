/**
 * The harness end to end (ADR-0260 §3, acceptance 7): a suite recorded from a
 * model through OpenAI's real provider package, then replayed with no
 * network, through the SDK's own turn runner. A compliant recording passes
 * every assertion; a violating one fails each, by name; a recording made
 * against another configuration fails until it is made again; a tool with no
 * stub fails the case and is never run; the channels and a take-over behave
 * as they do in production.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { evalCases, runEvals, type EvalCaseResult, type EvalReport } from '../run.js';
import { agent, backendCalls, compliant, configFor, recordWith, scratch, violating, SUITE } from './support.js';
import { formatReport, junitReport } from '../report.js';

const dirs: Array<() => void> = [];
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};
afterAll(() => dirs.forEach((cleanup) => cleanup()));
beforeEach(() => {
  backendCalls.length = 0;
});

const byCase = (report: EvalReport) => new Map(report.cases.map((c) => [`${c.scenario} [${c.channel}]`, c]));
const assertionsOf = (c: EvalCaseResult | undefined) => [...new Set(c?.failures.map((f) => f.assertion))].sort();

describe('a compliant recording', () => {
  const cassettes = tempDir();
  let recorded: Awaited<ReturnType<typeof recordWith<EvalReport>>>;

  it('records every scenario on every channel from the model, and passes', async () => {
    recorded = await recordWith(compliant, () => runEvals(configFor(cassettes), { mode: 'record' }));
    const report = recorded.result;
    expect(report.cases.map((c) => `${c.scenario} [${c.channel}]`)).toEqual(
      SUITE.scenarios.flatMap((s) => ['web_chat', 'sms'].map((ch) => `${s.id} [${ch}]`)),
    );
    expect(report.cases.filter((c) => !c.passed).map((c) => [c.scenario, c.channel, c.failures])).toEqual([]);
    for (const c of report.cases) expect(existsSync(c.cassette)).toBe(true);
    expect(backendCalls).toEqual([]);
  });

  it('replays with no network, and every assertion holds again', async () => {
    const report = await runEvals(configFor(cassettes));
    expect(report.mode).toBe('replay');
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(SUITE.scenarios.length * 2);
    // The judge's verdict was recorded with the turn's responses, and replayed with them.
    const judged = byCase(report).get('judged [sms]')!;
    expect(judged.modelRequests).toBe(2);
    const cassette = JSON.parse(readFileSync(judged.cassette, 'utf8')) as { exchanges: unknown[]; fingerprint: string; model: string };
    expect(cassette.exchanges).toHaveLength(2);
    expect(cassette.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(cassette.model).toBe('openai.chat:gpt-fixture');
    expect(backendCalls).toEqual([]);
  });

  it('runs a channel the way it runs in production: the readback is the SMS reply, the card is the UI’s', async () => {
    const report = byCase(await runEvals(configFor(cassettes), { scenarios: ['booking'] }));
    const sms = report.get('booking [sms]')!;
    expect(sms.turns[0].reply).toBe('Book a visit: Day Saturday. Holds a time for the customer.');
    expect(sms.turns[0].approval).toMatchObject({ tool: 'book', args: { day: 'Saturday' }, preview: { readback: 'Book a visit: Day Saturday. Holds a time for the customer.' } });
    expect(sms.turns[1].reply).toContain('C-1');
    const ui = report.get('booking [web_chat]')!;
    expect(ui.turns[0].reply).toBe('');
    expect(ui.turns[0].approval?.tool).toBe('book');
  });

  it('runs a take-over as production does: no model call while it is held, and the person’s words in the history after', async () => {
    const takeover = byCase(await runEvals(configFor(cassettes), { scenarios: ['takeover'], channels: ['sms'] })).get('takeover [sms]')!;
    expect(takeover.failures).toEqual([]);
    expect(takeover.turns.map((t) => [t.turn, t.held, t.modelRequests])).toEqual([
      [0, false, 1],
      [3, true, 0],
      [5, false, 1],
    ]);
    expect(takeover.turns[2].reply).toBe('As Jordan said, $9,500.');
    // The request that answered it held Jordan's words as the business's, under Jordan's name.
    const lastRequest = recorded.requests.filter((r) => String(r.messages.at(-1)?.content ?? '').includes('what price do I pay')).at(-1)!;
    const business = lastRequest.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    expect(lastRequest.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant', 'user', 'assistant', 'user']);
    expect(business).toEqual([
      'Let me get someone from sales to talk pricing with you.',
      '[Jordan (Sales), a person on the staff, took this conversation over here. You did not answer while they held it.]\n\n' +
        '[Jordan (Sales), a person on the staff, wrote this to the customer while they held the conversation. ' +
        'These are their words, not yours; what they told the customer stands.]\nJordan here: $500 off, so $9,500.',
      "[Jordan (Sales) handed the conversation back to you here. Answer the customer's next message yourself.]",
    ]);
  });

  it('fails a recording made against another configuration, and keeps one whose assertions alone changed', async () => {
    const changed = await runEvals(configFor(cassettes, { agent: () => agent(['Quote only the dealer price.', 'Be brief.']) }), { scenarios: ['price'] });
    expect(changed.failed).toBe(2);
    for (const c of changed.cases) {
      expect(c.failures).toEqual([expect.objectContaining({ assertion: 'recording', message: expect.stringContaining('record it again with `agent-evals --record`') })]);
      expect(c.modelRequests).toBe(0);
    }
    const loosened = {
      ...SUITE,
      scenarios: SUITE.scenarios.map((s) => (s.id === 'price' ? { ...s, turns: [{ user: s.turns[0] && 'user' in s.turns[0] ? s.turns[0].user : '', expect: { says: ['$10,000'] } }] } : s)),
    };
    const sameInputs = await runEvals(configFor(cassettes, { suites: [loosened] }), { scenarios: ['price'] });
    expect(sameInputs.failed).toBe(0);
  });

  it('fails a case with no recording, saying how to make one', async () => {
    const report = await runEvals(configFor(tempDir()), { scenarios: ['price'], channels: ['sms'] });
    expect(report.cases[0].failures).toEqual([
      expect.objectContaining({ turn: -1, assertion: 'recording', message: expect.stringMatching(/^there is no recording at .*price\.sms\.json: record it/) }),
    ]);
  });

  it('reports as text and as JUnit', async () => {
    const report = await runEvals(configFor(cassettes), { scenarios: ['price'] });
    expect(formatReport(report)).toMatch(/PASS {2}desk evals › price \[web_chat\]/);
    expect(formatReport(report).split('\n').at(-1)).toBe('2 passed, 0 failed, of 2 (from the recordings)');
    const xml = junitReport(report);
    expect(xml).toContain('<testsuite name="desk evals" tests="2" failures="0"');
    expect(xml).toContain('classname="desk evals.sms" name="price: Quotes the dealer price, and no payments"');
  });
});

describe('a violating recording', () => {
  const cassettes = tempDir();
  let report: EvalReport;

  it('fails each assertion the model broke, by name, and never reaches a backend', async () => {
    await recordWith(violating, () => runEvals(configFor(cassettes), { mode: 'record' }));
    report = await runEvals(configFor(cassettes));
    const cases = byCase(report);
    expect(report.passed).toBe(0);
    expect(assertionsOf(cases.get('price [sms]'))).toEqual(['mustNotSay', 'says', 'toolCalled']);
    // The SSN was repeated, sent to a tool, and the tool has no stub: it was not run.
    expect(assertionsOf(cases.get('ssn [web_chat]'))).toEqual(['doesNotStore', 'refusal', 'stub']);
    expect(cases.get('ssn [web_chat]')!.failures.find((f) => f.assertion === 'stub')!.message).toContain('the agent called human with');
    expect(backendCalls).toEqual([]);
    // The judge read the reply and said no.
    expect(cases.get('judged [sms]')!.failures).toEqual([
      expect.objectContaining({ assertion: 'says', message: expect.stringContaining('does not match rubric: The reply says it is an AI assistant') }),
    ]);
    // It said it booked, with no booking and no readback: and the customer's yes had nothing to answer.
    expect(assertionsOf(cases.get('booking [sms]'))).toEqual(['approvalRequested', 'says', 'scenario']);
    expect(assertionsOf(cases.get('booking [web_chat]'))).toEqual(['approvalRequested', 'scenario']);
    expect(assertionsOf(cases.get('takeover [sms]'))).toEqual(['says', 'toolNotCalled']);
  });

  it('holds a held turn to `held`, which a running turn breaks', async () => {
    const strict = {
      ...SUITE,
      scenarios: [
        {
          id: 'not-held',
          title: 'A turn said to run while held',
          turns: [
            { user: 'Any discount?' },
            { staff: { takeOver: { displayName: 'Jordan' } } },
            { user: 'Thanks Jordan!', expect: { held: false } },
          ],
        },
      ],
    };
    const dir = tempDir();
    await recordWith(compliant, () => runEvals(configFor(dir, { suites: [strict] }), { mode: 'record', channels: ['sms'] }));
    const result = (await runEvals(configFor(dir, { suites: [strict] }), { channels: ['sms'] })).cases[0];
    expect(result.failures).toEqual([expect.objectContaining({ turn: 2, assertion: 'held', message: 'the turn did not run: a person held the conversation' })]);
  });
});

describe('cases for a test runner', () => {
  it('gives one case per scenario and channel, each throwing with every failure', async () => {
    const cassettes = tempDir();
    await recordWith(violating, () => runEvals(configFor(cassettes), { mode: 'record', scenarios: ['price'] }));
    const cases = await evalCases(configFor(cassettes), { scenarios: ['price'] });
    expect(cases.map((c) => c.name)).toEqual(['desk evals › price [web_chat]', 'desk evals › price [sms]']);
    await expect(cases[0].assert()).rejects.toThrow(/^desk evals › price \[web_chat\] failed:\n {2}- turn 1, says: [\s\S]*\n {2}- turn 1, toolCalled: lookup with \{"stock":"t1"\} was not called/);
  });

  it('refuses a channel or scenario the configuration does not have', async () => {
    await expect(evalCases(configFor(tempDir()), { channels: ['fax'] })).rejects.toThrow('no channel "fax" in the configuration (web_chat, sms)');
    await expect(evalCases(configFor(tempDir()), { scenarios: ['nope'] })).rejects.toThrow('no scenario nope');
  });
});
