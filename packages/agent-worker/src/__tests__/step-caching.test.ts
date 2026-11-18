/**
 * Every step of a turn reads the steps before it from the prompt cache, through
 * the real `ai` loop with a stand-in model.
 *
 * On dev (2026-10-08) a quarter of all PA input tokens went uncached and another
 * quarter was written to the cache again: only the system prompt and the end of
 * the incoming history were breakpoints, so a turn's own calls and answers were
 * paid in full at every later step, and a step note placed in the system prompt
 * changed the prefix of the whole conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';

type PromptMessage = { role: string; content: unknown; providerOptions?: Record<string, unknown> };

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A model that calls these tools, one step each, then answers. Each step's prompt is kept. */
function scripted(calls: string[]) {
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      const call = calls[prompts.length - 1];
      const chunks = call
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${prompts.length}`, toolName: call, input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Done.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

const tool = (name: string, ok: boolean): RegisteredTool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => (ok ? { success: true, data: { rows: 'x'.repeat(2_000) } } : { success: false, error: 'The layer is locked' })),
});

async function turn(model: unknown, overrides: Partial<AgentTurnInput> = {}, configOverrides: Partial<AgentWorkerConfig> = {}) {
  const config: AgentWorkerConfig = {
    ...configOverrides,
    tools: createToolRegistry([tool('layers_read', true), tool('layer_edit', false)]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
    systemPrompt: 'You are the assistant.',
  };
  const input: AgentTurnInput = {
    turnId: 'turn-cache',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-cache',
    content: 'Read the layers, then edit one',
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Read the layers, then edit one' },
    ],
    ...overrides,
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  return runAgentTurn(config, input);
}

const marked = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('cachePoint');
const isNote = (m: PromptMessage) => JSON.stringify(m.content).includes('<step_note>');
/** What a step sends after the conversation, for itself alone. */
const isTail = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('"stepTail":true');
/** The turn's context: with the turn's message, the same on every step. */
const isTurnContext = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('"turnContext":true');
/** What a step sends of the conversation: no system prompt, no tail of its own. */
const conversation = (prompt: PromptMessage[]) => prompt.filter((m) => m.role !== 'system' && !isTail(m));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a turn’s steps and the prompt cache', () => {
  it('marks the end of each step’s conversation, so the next step reads it, within the provider’s four breakpoints', async () => {
    const { model, prompts } = scripted(['layers_read', 'layers_read', 'layers_read']);
    await turn(model);

    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      const messages = conversation(prompt);
      expect(marked(messages.at(-1)!)).toBe(true);
      expect(prompt.filter(marked).length).toBeLessThanOrEqual(4);
    }
    // Each step's prompt begins with the whole of the step before it: a prefix the cache holds.
    for (let i = 1; i < prompts.length; i++) {
      const before = conversation(prompts[i - 1]).map((m) => JSON.stringify(m.content));
      const now = conversation(prompts[i]).map((m) => JSON.stringify(m.content));
      expect(now.slice(0, before.length)).toEqual(before);
    }
  });

  it('keeps the system prompt identical on every step and puts a step’s note after its breakpoint', async () => {
    const { model, prompts } = scripted(['layer_edit', 'layers_read']);
    await turn(model);

    expect(prompts).toHaveLength(3);
    const systems = prompts.map((p) => JSON.stringify(p.filter((m) => m.role === 'system')));
    expect(new Set(systems).size).toBe(1);
    // The first step ends with the turn's context, marked: it has no note, and no page, so no tail.
    expect(isTail(prompts[0].at(-1)!)).toBe(false);
    expect(isTurnContext(prompts[0].at(-1)!)).toBe(true);
    expect(marked(prompts[0].at(-1)!)).toBe(true);
    // The call that failed is reported to the steps after it, as the last thing they read, unmarked.
    for (const prompt of prompts.slice(1)) {
      const last = prompt.at(-1)!;
      expect(isNote(last)).toBe(true);
      expect(JSON.stringify(last.content)).toContain('<turn_record>');
      expect(marked(last)).toBe(false);
      expect(marked(prompt.at(-2)!)).toBe(true);
    }
    // A note is never carried into a later step's conversation, so it never changes a prefix.
    expect(prompts[2].filter(isTail)).toHaveLength(1);
  });
});

describe('a turn and the next one', () => {
  /** Turn one, two calls, spoken, with the host's notes; then turn two's first step, on the history the host stored. */
  async function twoTurns(placement?: 'with-message' | 'after-conversation') {
    const first = scripted(['layers_read', 'layers_read']);
    const spoken = {
      context: { timeZone: 'Europe/Paris', input: { mode: 'voice', language: 'en' } },
      stepContext: '<work_notes>\n- the slide\n</work_notes>',
    };
    const config = placement ? { turnContextPlacement: placement } : {};
    const one = await turn(first.model, spoken, config);

    // The next turn's history: what the host stored of this one, then the person's next message.
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Read the layers, then edit one' },
      ...one.newMessages.map((m): TurnHistoryMessage =>
        m.role === 'tool'
          ? { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId!, name: m.name }
          : {
              role: 'assistant',
              content: m.content,
              ...(m.toolCalls?.length
                ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
                : {}),
            },
      ),
      { role: 'user', content: 'Now the other one' },
    ];
    const second = scripted([]);
    await turn(
      second.model,
      { content: 'Now the other one', history, context: { timeZone: 'Europe/Paris' }, stepContext: '<work_notes>\n- the slide\n- the video\n</work_notes>' },
      config,
    );
    return { first, second };
  }

  it('sends the next turn the conversation up to this turn’s message as this turn sent it, and none of this turn’s context', async () => {
    const { first, second } = await twoTurns();
    const sentBefore = conversation(first.prompts.at(-1)!);
    const sentNow = conversation(second.prompts[0]);
    // Up to and including turn one's message, byte for byte: the cache reads it.
    const turnOneMessageAt = sentBefore.findIndex((m) => JSON.stringify(m.content).includes('Read the layers, then edit one'));
    expect(turnOneMessageAt).toBe(2);
    expect(sentNow.slice(0, turnOneMessageAt + 1).map((m) => JSON.stringify(m.content))).toEqual(
      sentBefore.slice(0, turnOneMessageAt + 1).map((m) => JSON.stringify(m.content)),
    );
    // Turn one's context went with its message, and the next turn never sends it: what was true only
    // for turn one (the spoken line, the clock, the notes) is in no message the host stored.
    expect(JSON.stringify(sentBefore[turnOneMessageAt + 1].content)).toMatch(/<now>[\s\S]*<input>[\s\S]*<work_notes>[\s\S]*- the slide/);
    expect(isTurnContext(sentBefore[turnOneMessageAt + 1])).toBe(true);
    const turnTwo = JSON.stringify(sentNow.filter((m) => !isTurnContext(m)).map((m) => m.content));
    expect(turnTwo).not.toMatch(/<input>|<now>|<work_notes>/);
    // Then turn one's calls and results, as it sent them: written to the cache once more.
    expect(sentNow.slice(turnOneMessageAt + 1, turnOneMessageAt + 5).map((m) => JSON.stringify(m.content))).toEqual(
      sentBefore.slice(turnOneMessageAt + 2).map((m) => JSON.stringify(m.content)),
    );
    // Turn two's own context is with its message, at the end of its first step.
    expect(isTurnContext(sentNow.at(-1)!)).toBe(true);
    expect(JSON.stringify(sentNow.at(-1)!.content)).toContain('- the video');
    // And the system prompt is the same for both turns.
    expect(JSON.stringify(second.prompts[0].filter((m) => m.role === 'system'))).toBe(JSON.stringify(first.prompts[0].filter((m) => m.role === 'system')));
  });

  it('after the conversation (turnContextPlacement), sends the next turn everything the last step of this one sent, byte for byte', async () => {
    const { first, second } = await twoTurns('after-conversation');
    // The last step of turn one, without its tail: a prefix of turn two's first step.
    const sentBefore = conversation(first.prompts.at(-1)!).map((m) => JSON.stringify(m.content));
    const sentNow = conversation(second.prompts[0]).map((m) => JSON.stringify(m.content));
    expect(sentNow.slice(0, sentBefore.length)).toEqual(sentBefore);
    // What was true only for turn one was never part of it: it was the tail, after the last tool result.
    expect(JSON.stringify(sentBefore)).not.toMatch(/<input>|<now>|<work_notes>/);
    expect(first.prompts.at(-1)!.filter(isTurnContext)).toHaveLength(0);
    expect(JSON.stringify(first.prompts.at(-1)!.at(-1)!.content)).toMatch(/<input>[\s\S]*<work_notes>/);
    expect(first.prompts.at(-1)!.at(-2)!.role).toBe('tool');
  });
});

describe('the history entry a host loads to fit stored answers', () => {
  it('gives an answer its state up exactly as the worker sends and stores it, and needs nothing of the turn runtime', async () => {
    const { answerWithoutState, STATE_AT_END } = await import('../history.js');
    const stored = JSON.stringify({ result: { changed: [{ ref: 'layer-1' }] }, page: { surfaces: ['Canvas'] }, state: { document: { layers: 12 } } });
    expect(answerWithoutState(stored)).toBe(JSON.stringify({ result: { changed: [{ ref: 'layer-1' }] }, page: { surfaces: ['Canvas'] }, pageState: STATE_AT_END }));
    // Already without one, or not an answer: as it is.
    expect(answerWithoutState(answerWithoutState(stored))).toBe(answerWithoutState(stored));
    expect(answerWithoutState('not json "state"')).toBe('not json "state"');
    // Its module, and what that imports, import nothing at run time.
    const { readFileSync } = await import('node:fs');
    for (const file of ['../history.ts', '../ui/page-state-at-end.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const runtimeImports = [...source.matchAll(/^(?:import|export) (?!type )[^;]*from '([^']+)'/gm)].map((m) => m[1]);
      expect(runtimeImports.filter((from) => !from.startsWith('./'))).toEqual([]);
    }
  });
});
