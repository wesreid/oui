/**
 * What the stored history keeps of the pages a conversation was on (`history`):
 * the digest of the page each customer message was sent from (`pageAtStart`)
 * and of the page each page answer showed (`shown`). A later turn is held to
 * a fact of a page the conversation has left (`quotes`): Nova's assistant took
 * back true answers once the page moved on (2026-11-25 review, §2.1), because
 * nothing of an earlier page survived in what it read.
 *
 * The record (`pagesKeptOf`), the check, the memory store, and a whole case
 * recorded from a scripted model through OpenAI's real provider package and
 * replayed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvalPage, AgentEvalSuite } from '@ouispec/contract';
import { STATE_AT_END, type TurnMessage } from '@ouispec/agent-worker';
import type { ChatRequest, ScriptedReply } from '@ouispec/agent-worker/testing';
import { conversationOf, messageText } from '@ouispec/agent-worker/testing';
import { check, pagesKeptOf, runEvals, type EvalPageKept, type EvalTurnRecord } from '../run.js';
import { createMemoryHistory } from '../memory.js';
import { checkSuite, matchersOf } from '../suite.js';
import { agent, configFor, lastRole, lastUser, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));

const MARIA = 'page:lead — Lead (Name: Maria Alvarez; Vehicle: 2021 Rogue S)';
const TOM = 'page:lead — Lead (Name: Tom Lee; Vehicle: 2023 Kicks SV)';

describe('pagesKeptOf: what a turn’s store keeps of the pages', () => {
  it('is the page its message was sent from, then the page each answer showed, in order', () => {
    const messages: TurnMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'ui_act', arguments: { action: 'app.navigate' } }] },
      { role: 'tool', content: JSON.stringify({ result: {}, shown: TOM, pageState: STATE_AT_END }), toolCallId: 'c1', name: 'ui_act' },
      { role: 'tool', content: '{"success":true,"data":{"shown":"not a digest"}}', toolCallId: 'c2', name: 'lookup' },
      { role: 'tool', content: 'not json "shown"', toolCallId: 'c3', name: 'lookup' },
      { role: 'assistant', content: 'Tom’s lead is open.' },
    ];
    expect(pagesKeptOf(1, messages, MARIA)).toEqual([
      { turn: 1, kind: 'pageAtStart', digest: MARIA },
      { turn: 1, kind: 'shown', digest: TOM },
    ]);
    expect(pagesKeptOf(0, [{ role: 'assistant', content: 'Hi.' }])).toEqual([]);
  });
});

describe('the memory store keeps the page with the customer’s message', () => {
  it('puts pageAtStart on the turn’s user message and hands it back', async () => {
    const history = createMemoryHistory();
    history.append('c', { role: 'user', content: 'Who first?' });
    await history.persistMessages({ turnId: 't', conversationId: 'c', messages: [{ role: 'assistant', content: 'Maria.' }], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, pageAtStart: MARIA });
    expect(history.messages('c')).toEqual([
      { role: 'user', content: 'Who first?', pageAtStart: MARIA },
      { role: 'assistant', content: 'Maria.' },
    ]);
  });
});

describe('the history check', () => {
  const record = (turn: number, reply: string): EvalTurnRecord =>
    ({ turn, kind: 'user', customer: 'Why the Rogue?', reply, working: '', toolCalls: [], approval: null, held: false, choices: [], page: null }) as unknown as EvalTurnRecord;
  const pages: EvalPageKept[] = [
    { turn: 0, kind: 'pageAtStart', digest: MARIA },
    { turn: 1, kind: 'shown', digest: TOM },
    { turn: 2, kind: 'pageAtStart', digest: TOM },
  ];
  const failed = async (expectation: Parameters<typeof check>[0], reply: string, turn = 2, kept: readonly EvalPageKept[] = pages) =>
    (await check(expectation, record(turn, reply), '', null, { pagesKept: kept })).map((f) => [f.assertion, f.message]);

  it('holds keeps to every page the history keeps, this turn’s included', async () => {
    expect(await failed({ history: { keeps: ['Maria Alvarez', { pattern: 'Kicks SV' }] } }, '')).toEqual([]);
    expect(await failed({ history: { keeps: ['Ana Diaz'] } }, '')).toEqual([
      ['history', `what the stored history keeps of the pages does not match "Ana Diaz": ${JSON.stringify(`${MARIA}\n${TOM}\n${TOM}`)}`],
    ]);
  });

  it('holds quotes to a fact the reply says and only an earlier turn’s page shows', async () => {
    const answer = 'Maria Alvarez’s lead was for the 2021 Rogue S, so I led with it.';
    expect(await failed({ history: { quotes: ['2021 Rogue S'] } }, answer)).toEqual([]);
    expect(await failed({ history: { quotes: ['2021 Rogue S'] } }, 'I did not mention a Rogue.')).toEqual([
      ['history', 'the reply does not quote "2021 Rogue S": "I did not mention a Rogue."'],
    ]);
    // This turn's own page is not an earlier page: a fact only it shows was not remembered.
    expect(await failed({ history: { quotes: ['Kicks SV'] } }, 'He wants the 2023 Kicks SV.', 1)).toEqual([
      ['history', `no page an earlier turn left in the stored history shows "Kicks SV": ${JSON.stringify(MARIA)}`],
    ]);
    expect(await failed({ history: { quotes: ['2021 Rogue S'] } }, answer, 2, [])).toEqual([
      ['history', 'no page an earlier turn left in the stored history shows "2021 Rogue S": it keeps none'],
    ]);
  });

  it('counts its matchers among the turn’s, so their patterns are checked and their rubrics judged', () => {
    expect(matchersOf({ history: { keeps: [{ rubric: 'names the open lead' }], quotes: [{ pattern: 'Rogue' }] } })).toEqual([{ rubric: 'names the open lead' }, { pattern: 'Rogue' }]);
    const suite = (pattern: string) => ({ version: 1, name: 's', scenarios: [{ id: 'a', title: 'a', turns: [{ user: 'x', expect: { history: { quotes: [{ pattern }] } } }] }] });
    expect(() => checkSuite(suite('Rogue('), 'suite.yaml', ['web_chat'])).toThrow(/is not a regular expression/);
    expect(() => checkSuite(suite('Rogue'), 'suite.yaml', ['web_chat'])).not.toThrow();
  });
});

// ─── A whole case ───────────────────────────────────────────────────────────────────────────────────────────

const lead = (name: string, vehicle: string) => [{ id: 'leads.detail', title: 'Lead', facts: { Name: name, Vehicle: vehicle } }];
const PAGE: AgentEvalPage = {
  at: '/leads/maria',
  surfaces: [
    { id: 'page:lead-maria', name: 'Maria’s lead', description: 'One lead.', routes: ['/leads/maria'], shown: lead('Maria Alvarez', '2021 Rogue S'), actions: [] },
    { id: 'page:lead-tom', name: 'Tom’s lead', description: 'One lead.', routes: ['/leads/tom'], shown: lead('Tom Lee', '2023 Kicks SV'), actions: [] },
  ],
};
const SUITE: AgentEvalSuite = {
  version: 1,
  name: 'lead desk',
  page: PAGE,
  scenarios: [
    {
      id: 'remembers-the-rogue',
      title: 'Says why it led with the Rogue after the page moved on',
      turns: [
        { user: 'Who should I call first?', expect: { says: ['Maria Alvarez'], history: { keeps: ['2021 Rogue S'] } } },
        { user: 'Open Tom’s lead', expect: { page: { at: '/leads/tom' }, history: { keeps: ['Name: Tom Lee'] } } },
        { user: 'Why did you lead with the Rogue?', expect: { history: { quotes: ['2021 Rogue S'], keeps: ['Maria Alvarez', 'Tom Lee'] } } },
      ],
    },
  ],
};

/** Everything the model was sent, its system prompt and the page's state left out: the conversation. */
const conversationText = (request: ChatRequest) => conversationOf(request).map((m) => messageText(m)).join('\n');

/** Answers from what it was sent: the Rogue only if the conversation still holds the page that showed it. */
const remembering = (request: ChatRequest): ScriptedReply | undefined => {
  const said = lastUser(request);
  if (said.includes('call first')) return { text: 'Call Maria Alvarez first.' };
  if (said.includes('Open Tom')) {
    return lastRole(request) === 'tool'
      ? { text: 'Tom’s lead is open.' }
      : { toolCalls: [{ id: 'call_nav', name: 'ui_act', args: { action: 'app_navigate', input: { path: '/leads/tom' } } }] };
  }
  if (said.includes('Why did you lead')) {
    const earlier = conversationText(request).split('Why did you lead')[0];
    const rogue = /Vehicle: (2021 Rogue S)/.exec(earlier)?.[1];
    return { text: rogue ? `Maria Alvarez’s lead was for the ${rogue}, so I led with her.` : 'I did not mention a Rogue.' };
  }
  return undefined;
};

describe('a case held to a fact of an earlier page, recorded and replayed (acceptance)', () => {
  it('passes when the history keeps the page and the reply quotes it, recorded and then replayed with no network', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, { suites: [SUITE], channels: { web_chat: { approvals: 'ui' } } });
    const { result, requests } = await recordWith(remembering, () => runEvals(config, { mode: 'record' }));
    expect(result.cases.map((c) => [c.scenario, c.passed, c.failures])).toEqual([['remembers-the-rogue', true, []]]);
    expect(result.cases[0].turns[2].reply).toBe('Maria Alvarez’s lead was for the 2021 Rogue S, so I led with her.');
    // The fact came from the history: turn three's page was Tom's, and turn one's message carried Maria's.
    const last = requests.at(-1)!;
    expect(conversationText(last)).toContain('<page_at_start>When this message was sent, the page showed: page:lead-maria — Lead (Name: Maria Alvarez; Vehicle: 2021 Rogue S)');

    const replayed = await runEvals(config);
    expect(replayed.mode).toBe('replay');
    expect(replayed.failed).toBe(0);
  });

  it('fails, by name, an agent whose history keeps no page', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, {
      suites: [SUITE],
      channels: { web_chat: { approvals: 'ui' } },
      agent: () => ({ ...agent(), uiActions: { stateDigest: false } }),
    });
    const report = (await recordWith(remembering, () => runEvals(config, { mode: 'record' }))).result;
    expect(report.cases[0].failures.map((f) => [f.turn, f.message])).toEqual([
      [0, 'what the stored history keeps of the pages does not match "2021 Rogue S": ""'],
      [1, 'what the stored history keeps of the pages does not match "Name: Tom Lee": ""'],
      [2, 'what the stored history keeps of the pages does not match "Maria Alvarez": ""'],
      [2, 'what the stored history keeps of the pages does not match "Tom Lee": ""'],
      [2, 'the reply does not quote "2021 Rogue S": "I did not mention a Rogue."'],
      [2, 'no page an earlier turn left in the stored history shows "2021 Rogue S": it keeps none'],
    ]);
  });
});
