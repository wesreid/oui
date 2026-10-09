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
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
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

async function turn(model: unknown) {
  const config: AgentWorkerConfig = {
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
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  return runAgentTurn(config, input);
}

const marked = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('cachePoint');
const isNote = (m: PromptMessage) => JSON.stringify(m.content).includes('<step_note>');
/** What a step sends of the conversation: no system prompt, no note of its own. */
const conversation = (prompt: PromptMessage[]) => prompt.filter((m) => m.role !== 'system' && !isNote(m));

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
    // The call that failed is reported to the steps after it, as the last thing they read, unmarked.
    expect(isNote(prompts[0].at(-1)!)).toBe(false);
    for (const prompt of prompts.slice(1)) {
      const last = prompt.at(-1)!;
      expect(isNote(last)).toBe(true);
      expect(JSON.stringify(last.content)).toContain('<turn_record>');
      expect(marked(last)).toBe(false);
      expect(marked(prompt.at(-2)!)).toBe(true);
    }
    // A note is never carried into a later step's conversation, so it never changes a prefix.
    expect(prompts[2].filter(isNote)).toHaveLength(1);
  });
});
