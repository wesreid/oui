/**
 * A note written as a trailer (agent-worker's `RegisteredTool.trailer`): a
 * turn's record says a call arrived that way (`toolCalls[i].via`), and a
 * case can require it (`toolCalled: [{ name, via: 'trailer' }]`), so a host
 * can hold a model to writing its note with its reply, in one model call.
 *
 * Whole cases, recorded from a scripted model through OpenAI's real provider
 * package and replayed with no network.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvalSuite } from '@ouispec/contract';
import type { ChatRequest, ScriptedReply } from '@ouispec/agent-worker/testing';
import type { RegisteredTool } from '@ouispec/agent-worker';
import { check, runEvals, type EvalTurnRecord } from '../run.js';
import { configFor, lastRole, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));

const note = (trailer: boolean): RegisteredTool => ({
  name: 'note',
  effect: 'edit',
  answerless: true,
  ...(trailer ? { trailer: true } : {}),
  description: 'Write one line in this chat’s notes.',
  inputSchema: { type: 'object', sideEffects: false, additionalProperties: false, properties: { kind: { type: 'string', enum: ['decision', 'task'] }, text: { type: 'string' } } },
  execute: async () => ({ success: false, error: 'stubbed' }),
});

const SUITE: AgentEvalSuite = {
  version: 1,
  name: 'trailer evals',
  stubs: { note: [{ result: { success: true, data: { id: 'n1', kind: 'decision', text: 'Chorus brighter.' } } }] },
  scenarios: [
    {
      id: 'decide',
      title: 'Decides, replies, and notes the decision with its reply',
      turns: [
        {
          user: 'Make the chorus brighter.',
          expect: {
            says: ['brighter'],
            mustNotSay: ['<oui:'],
            toolCalled: [{ name: 'note', args: { kind: 'decision' }, via: 'trailer' }],
            usage: { modelCalls: { max: 1 } },
          },
        },
      ],
    },
  ],
};

const REPLY = 'The chorus is brighter now.';
/** Writes the note as a trailer, after its reply. */
const trailing = (): ScriptedReply => ({ text: `${REPLY}\n\n<oui:note>{"kind":"decision","text":"Chorus brighter."}</oui:note>` });
/** Calls the note as a tool, alone, then replies in a second call. */
const calling = (request: ChatRequest): ScriptedReply =>
  lastRole(request) === 'tool' ? { text: REPLY } : { toolCalls: [{ id: 'call_note', name: 'note', args: { kind: 'decision', text: 'Chorus brighter.' } }] };

describe('a note written as a trailer, in a case', () => {
  it('is recorded as arriving as a trailer, and a case that requires it passes, recorded and replayed', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, { suites: [SUITE], channels: { web_chat: { approvals: 'ui' } }, agent: () => ({ systemPrompt: () => 'You help with music.', tools: [note(true)] }) });
    const recorded = (await recordWith(trailing, () => runEvals(config, { mode: 'record' }))).result;
    expect(recorded.cases.map((c) => [c.scenario, c.passed, c.failures])).toEqual([['decide', true, []]]);
    const turn = recorded.cases[0].turns[0];
    expect(turn.toolCalls).toEqual([{ name: 'note', args: { kind: 'decision', text: 'Chorus brighter.' }, via: 'trailer' }]);
    expect(turn.reply).toBe(REPLY);
    expect(turn.modelRequests).toBe(1);
    expect(turn.invalidToolCalls).toBe(0);

    const replayed = await runEvals(config);
    expect(replayed.mode).toBe('replay');
    expect(replayed.failed).toBe(0);
  });

  it('fails a model that calls the note as a tool instead, by name', async () => {
    const { dir, cleanup } = scratch();
    dirs.push(cleanup);
    const config = configFor(dir, { suites: [SUITE], channels: { web_chat: { approvals: 'ui' } }, agent: () => ({ systemPrompt: () => 'You help with music.', tools: [note(false)] }) });
    const report = (await recordWith(calling, () => runEvals(config, { mode: 'record' }))).result;
    expect(report.cases[0].failures.map((f) => [f.assertion, f.message])).toEqual([
      ['toolCalled', 'note with {"kind":"decision"} as a trailer was not called; the agent called note {"kind":"decision","text":"Chorus brighter."}'],
      ['usage.modelCalls', expect.stringContaining('model calls')],
    ]);
    expect(report.cases[0].turns[0].toolCalls).toEqual([{ name: 'note', args: { kind: 'decision', text: 'Chorus brighter.' } }]);
  });

  it('holds via: call only for a call, and no via for either', async () => {
    const record = (via?: 'trailer') =>
      ({ turn: 0, kind: 'user', customer: '', reply: '', working: '', toolCalls: [{ name: 'note', args: {}, ...(via ? { via } : {}) }], approval: null, held: false, choices: [], page: null }) as unknown as EvalTurnRecord;
    const failed = async (via: 'trailer' | 'call' | undefined, arrived?: 'trailer') =>
      (await check({ toolCalled: [{ name: 'note', ...(via ? { via } : {}) }] }, record(arrived), '', null)).map((f) => f.message);
    expect(await failed('call')).toEqual([]);
    expect(await failed('call', 'trailer')).toEqual(['note as a call was not called; the agent called note {} (as a trailer)']);
    expect(await failed('trailer', 'trailer')).toEqual([]);
    expect(await failed(undefined, 'trailer')).toEqual([]);
    expect(await failed(undefined)).toEqual([]);
  });
});
