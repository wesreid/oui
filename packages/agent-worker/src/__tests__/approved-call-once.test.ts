/**
 * An approved call is ONE call to the model, on every later turn too.
 *
 * A call that waited for the user's approval has two rows in a host's store:
 * "waiting for approval", then what the approved run returned, both under the
 * call's own id. Shown the approved run as a second call ("…-approved"), the
 * assistant warned the user of a duplicate save that had not happened (dev,
 * 2026-10-03). The message history the model is given holds the call once,
 * with the approved run's result where "waiting" stood.
 *
 * The continuation turn itself is covered end to end in
 * approval-turn.e2e.test.ts; this covers the turns after it, which read the
 * rows back from the store, and a store written before this change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { createToolRegistry } from '../tools/types.js';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage } from '../types.js';

type StreamOpts = { messages: ModelMessage[] };
let seen: StreamOpts | null = null;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seen = opts;
    return {
      textStream: (async function* () {
        yield 'Saved.';
      })(),
      steps: Promise.resolve([{ text: 'Saved.', toolCalls: [], usage: { inputTokens: 10 } }]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Saved.' }] }),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const config: AgentWorkerConfig = {
  tools: createToolRegistry([]),
  emit: { emit: vi.fn(async () => {}) },
  model: 'test-model',
  systemPrompt: 'You are the assistant.',
};

const WAITING = JSON.stringify({ success: false, awaitingApproval: true, approvalId: 'call_save_1', message: 'Waiting for the user to approve "Save a breaking version" on the approval card. It has not run.' });
const SAVED = JSON.stringify({ result: { version: 4 } });

const call = (id: string): TurnHistoryMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'ui_act', arguments: JSON.stringify({ action: 'version_save_breaking', input: { name: 'breaking' } }) } }],
});

const turn = (history: TurnHistoryMessage[]): AgentTurnInput => ({
  turnId: 'turn-after',
  conversationId: 'conv',
  userId: 'user-1',
  accountId: 'acct',
  socketRoom: 'agent:turn:turn-after',
  content: 'How many versions are there now?',
  history: [...history, { role: 'user', content: 'How many versions are there now?' }],
  context: null,
});

type Part = { type: string; toolCallId?: string; output?: { value?: string } };
const parts = (role: 'assistant' | 'tool') =>
  seen!.messages.filter((m) => m.role === role).flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]) : []));
const callIds = () => parts('assistant').filter((p) => p.type === 'tool-call').map((p) => p.toolCallId);
const results = () => parts('tool').filter((p) => p.type === 'tool-result');

describe('the history the model is given holds an approved call once', () => {
  beforeEach(() => {
    seen = null;
  });

  it('gives the approved run’s result as the result of the call, where "waiting for approval" stood', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Waiting for your approval.' },
        // The continuation turn: the user's click, then the approved run's result under the same call id.
        { role: 'user', content: '' },
        { role: 'tool', content: SAVED, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Saved version 4.' },
      ]),
    );

    expect(callIds()).toEqual(['call_save_1']);
    expect(results().map((r) => r.toolCallId)).toEqual(['call_save_1']);
    expect(results()[0].output?.value).toBe(SAVED);
    expect(JSON.stringify(seen!.messages)).not.toContain('awaitingApproval');
    // The result follows its call directly, as a provider requires.
    const at = seen!.messages.findIndex((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Part[]).some((p) => p.type === 'tool-call'));
    expect(seen!.messages[at + 1].role).toBe('tool');
  });

  it('leaves a call that is still waiting as it is', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'assistant', content: 'Waiting for your approval.' },
      ]),
    );
    expect(results().map((r) => r.output?.value)).toEqual([WAITING]);
  });

  it('reads a store written before this change as it was written: two calls, each with its own result', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config,
      turn([
        { role: 'user', content: 'Save a breaking version.' },
        call('call_save_1'),
        { role: 'tool', content: WAITING, tool_call_id: 'call_save_1', name: 'ui_act' },
        { role: 'user', content: '' },
        call('call_save_1-approved'),
        { role: 'tool', content: SAVED, tool_call_id: 'call_save_1-approved', name: 'ui_act' },
      ]),
    );
    expect(callIds()).toEqual(['call_save_1', 'call_save_1-approved']);
    expect(results().map((r) => r.output?.value)).toEqual([WAITING, SAVED]);
  });
});
