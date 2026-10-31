/**
 * A choice is the question that follows a reply, through the real `ai` loop
 * (only the model is a stand-in):
 *
 * - a call to a tool that asks the person (`present_options`) ends the turn
 *   only when it ran: one refused, invalid or sent back asked nothing, and the
 *   step goes back to the model;
 * - a tool policy is told what the turn has written so far (`replyText`), and
 *   a turn policy what each step wrote (`steps[].text`);
 * - `requireReplyBeforeChoice` sends back a choice offered before any reply,
 *   once: the model writes its reply and offers it again. A second empty one
 *   goes through, so a turn never ends with neither and never loops.
 *
 * Measured live (DEOS, 2026-10-30): a third of turns ended on a choice card
 * with no reply, whatever the prompt said.
 */
import { describe, expect, it, vi } from 'vitest';
import { REPLY_BEFORE_CHOICE_ERROR, runAgentTurn } from '../orchestrator.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import type { ToolPolicyContext } from '../authz/tool-policy.js';
import type { TurnPolicy } from '../turn-policy.js';
import type { AgentWorkerConfig } from '../types.js';
import { respondingOpenAI, type ScriptedReply } from './support/replay.js';

const lookup: RegisteredTool = {
  name: 'inventory_search',
  description: 'Searches the inventory.',
  effect: 'view',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  execute: vi.fn(async () => ({ success: true, data: { matches: 2 } })),
};

const choice = (id: string): ScriptedReply['toolCalls'] => [
  {
    id,
    name: 'present_options',
    args: { context: 'Two RAV4s are blue.', prompt: 'Open one?', options: [{ label: 'The XLE', value: 'xle' }] },
  },
];

/** Runs a turn the model answers with `replies`: what was sent, what the turn stored, and what each model request carried. */
async function turn(replies: ScriptedReply[], extra: Partial<AgentWorkerConfig> = {}) {
  const m = respondingOpenAI((_request, i) => replies[i]);
  const stored: Array<{ role: string; content?: string | null; toolCallId?: string; toolCalls?: unknown }> = [];
  const tokens: string[] = [];
  const result = await runAgentTurn(
    {
      tools: createToolRegistry([lookup, ...loadBuiltinTools().filter((t) => t.name === 'present_options')]),
      emit: { emit: async (_room, event, data) => void (event === 'agent:token' && tokens.push(String((data as { text?: unknown }).text ?? ''))) },
      systemPrompt: 'You help on a dealer’s site.',
      model: m.model,
      beforeTurnComplete: async ({ newMessages }) => void stored.push(...(newMessages as typeof stored)),
      ...extra,
    },
    { turnId: 'turn-choice', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:turn-choice', content: 'Any blue RAV4s?' },
  );
  return { result, stored, requests: m.requests, said: () => tokens.join('') };
}

const toolResults = (stored: Array<{ role: string; content?: string | null }>) =>
  stored.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content ?? '{}') as Record<string, unknown>);

describe('a choice ends the turn only when it ran', () => {
  it('hands a refused choice back to the model, which goes on', async () => {
    const { result, requests } = await turn(
      [{ toolCalls: choice('call_1') }, { text: 'Two blue RAV4s are in stock.' }],
      { toolPolicy: { evaluate: async (ctx) => (ctx.toolName === 'present_options' ? { action: 'deny', reason: 'Not now.' } : { action: 'allow' }) } },
    );
    expect(requests).toHaveLength(2);
    expect(result.stopReason).not.toBe('present_options');
  });

  it('ends the turn on a choice that ran', async () => {
    const { result, requests } = await turn([{ text: 'Two are blue.', toolCalls: choice('call_1') }]);
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe('present_options');
  });
});

describe('what the turn has written, for policies', () => {
  it('tells a tool policy the reply so far, and a turn policy each step’s text', async () => {
    const seen: Array<Pick<ToolPolicyContext, 'toolName' | 'replyText'>> = [];
    const stepTexts: string[][] = [];
    const turnPolicy: TurnPolicy = {
      classifyTurn: () => 'task',
      prepareStep: async ({ steps }) => {
        stepTexts.push(steps.map((s) => s.text ?? ''));
        return {};
      },
    };
    await turn(
      [
        { toolCalls: [{ id: 'call_s', name: 'inventory_search', args: { query: 'blue rav4' } }] },
        { text: 'Two blue RAV4s are in stock.', toolCalls: choice('call_c') },
      ],
      {
        turnPolicy,
        toolPolicy: { evaluate: async (ctx) => (seen.push({ toolName: ctx.toolName, replyText: ctx.replyText }), { action: 'allow' }) },
      },
    );
    // The choice's policy sees the words written before it in the same step.
    expect(seen).toEqual([
      { toolName: 'inventory_search', replyText: '' },
      { toolName: 'present_options', replyText: 'Two blue RAV4s are in stock.' },
    ]);
    expect(stepTexts.at(-1)).toEqual(['']);
  });
});

describe('requireReplyBeforeChoice', () => {
  it('sends a choice offered before any reply back once; the model writes its reply and offers it again', async () => {
    const { result, stored, requests } = await turn(
      [{ toolCalls: choice('call_1') }, { text: 'Two blue RAV4s are in stock.', toolCalls: choice('call_2') }],
      { requireReplyBeforeChoice: true },
    );
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('present_options');
    const [sentBack, shown] = toolResults(stored);
    expect(sentBack).toMatchObject({ success: false, error: REPLY_BEFORE_CHOICE_ERROR, replyFirst: true });
    expect(shown).toMatchObject({ __present_options: true });
    expect(stored.find((m) => m.role === 'assistant' && m.content)?.content).toContain('Two blue RAV4s are in stock.');
  });

  it('lets the choice through when it comes after a reply', async () => {
    const { result, requests } = await turn([{ text: 'Two are blue.', toolCalls: choice('call_1') }], { requireReplyBeforeChoice: true });
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe('present_options');
  });

  it('counts a reply written in an earlier step of the turn', async () => {
    const { requests } = await turn(
      [
        { text: 'Let me look.', toolCalls: [{ id: 'call_s', name: 'inventory_search', args: {} }] },
        { toolCalls: choice('call_c') },
      ],
      { requireReplyBeforeChoice: true },
    );
    expect(requests).toHaveLength(2);
  });

  it('says a second empty choice’s context as the reply, and shows the card with its question alone; it never loops', async () => {
    const { result, stored, requests, said } = await turn([{ toolCalls: choice('call_1') }, { toolCalls: choice('call_2') }], {
      requireReplyBeforeChoice: true,
    });
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('present_options');
    const [sentBack, shown] = toolResults(stored);
    expect(sentBack).toMatchObject({ success: false, replyFirst: true });
    // The card asks; what it said first is the turn's reply, sent and stored.
    expect(shown).toMatchObject({ __present_options: true, prompt: 'Open one?' });
    expect(said()).toBe('Two RAV4s are blue.');
    expect(stored.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)).toEqual(['Two RAV4s are blue.']);
  });

  it('lets a second empty choice with no context through as it is', async () => {
    const bare = [{ id: 'call_2', name: 'present_options', args: { context: '', prompt: 'Open one?', options: [{ label: 'The XLE', value: 'xle' }] } }];
    const { result, stored, said } = await turn([{ toolCalls: choice('call_1') }, { toolCalls: bare }], { requireReplyBeforeChoice: true });
    expect(result.stopReason).toBe('present_options');
    expect(toolResults(stored).map((r) => r.success ?? true)).toEqual([false, true]);
    expect(said()).toBe('');
  });

  it('is off by default: a choice with no reply goes through', async () => {
    const { result, requests } = await turn([{ toolCalls: choice('call_1') }]);
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe('present_options');
  });
});
