/**
 * Where a turn's context goes, step by step, through the real `ai` loop.
 *
 * What is true for the whole turn (the clock, how the message was entered and
 * how the reply is delivered, the vision line, the host's `stepContext`) goes
 * straight after the turn's own message, on every step, in the same words.
 * Sent after a tool result instead, it read as the person's newest message:
 * Claude Haiku 5.5 with thinking off answered a live call's `look` "your
 * message came through blank", or went back to an earlier question
 * (evals/turn-context.live-eval.ts). After a tool result there is only what
 * is true for that step (the page's newest state, the step's notes).
 *
 * - the request's shape on the first step and on every later one;
 * - the cache: each step's prompt begins with the whole of the step before
 *   it, the turn's context included, within the provider's four breakpoints;
 * - the default, for a host that sets nothing; the 0.30 placement, for a host
 *   that asks for it; a placement the worker does not know, refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';
import { readTurnVision, type TurnVision } from '../prompt/vision.js';
import { TURN_CONTEXT_PLACEMENTS, type TurnContextPlacement } from '../step-messages.js';

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
            { type: 'text-delta', id: '0', delta: 'Two openings: seven and seven thirty.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

const lookup = (name: string): RegisteredTool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, data: { openings: ['19:00', '19:30'] } })),
});

/** A host's step context in a dealer's words: it speaks of the newest message and of a task still open. */
const STEP_CONTEXT = 'If their newest message is about the appointment, check the service times first.\nStill open: 7:00 or 7:30 tomorrow.';
const QUESTION = 'Is 7:00 or 7:30 open tomorrow?';

async function turn(model: unknown, options: { placement?: TurnContextPlacement; note?: string } = {}) {
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([lookup('service_times'), lookup('service_bays')]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
    systemPrompt: 'You are the dealership’s assistant on a live call.',
    ...(options.placement ? { turnContextPlacement: options.placement } : {}),
    ...(options.note ? { turnPolicy: { classifyTurn: () => 'normal', prepareStep: async () => ({ note: options.note }) } } : {}),
  };
  const input: AgentTurnInput = {
    turnId: 'turn-context-1',
    conversationId: 'conv-1',
    userId: 'visitor-1',
    accountId: 'rooftop-1',
    socketRoom: 'conversation:conv-1',
    content: QUESTION,
    history: [
      { role: 'user', content: 'I need an oil change.' },
      { role: 'assistant', content: 'Happy to help. When suits you?' },
      { role: 'user', content: QUESTION },
    ],
    context: { timeZone: 'America/New_York', input: { mode: 'voice', language: 'en' }, output: { mode: 'voice' } },
    vision: readTurnVision({ seeing: false, remarks: false, canLook: false, absent: 'camera_off', look: null }) as TurnVision,
    stepContext: STEP_CONTEXT,
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  return runAgentTurn(config, input);
}

const optionsOf = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {});
const isTurnContext = (m: PromptMessage) => optionsOf(m).includes('"turnContext":true');
const isTail = (m: PromptMessage) => optionsOf(m).includes('"stepTail":true');
const marked = (m: PromptMessage) => optionsOf(m).includes('cachePoint');
const textOf = (m: PromptMessage) => (typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('\n'));
/** The lines of the turn's context, each of which must never follow a tool result. */
const CONTEXT_LINES = ['<now>', '<input>', '<output>', '<vision>', STEP_CONTEXT];
/** What a step sends of the conversation: no system prompt, no tail of its own. */
const conversation = (prompt: PromptMessage[]) => prompt.filter((m) => m.role !== 'system' && !isTail(m));

describe('a turn’s context, by default', () => {
  it('is sent with the turn’s message on the first step, and there again on every later one, never after a tool result', async () => {
    const { model, prompts } = scripted(['service_times', 'service_bays']);
    const result = await turn(model);
    expect(result.stopReason).toBe('complete');
    expect(prompts).toHaveLength(3);

    // Step one: the turn's message, then its context, and nothing after it.
    const first = prompts[0];
    expect(first.at(-2)).toMatchObject({ role: 'user', content: [{ type: 'text', text: QUESTION }] });
    expect(isTurnContext(first.at(-1)!)).toBe(true);
    for (const line of CONTEXT_LINES) expect(textOf(first.at(-1)!)).toContain(line);

    for (const prompt of prompts) {
      // Exactly once, straight after the turn's message, in the same words as the first step's.
      const at = prompt.findIndex(isTurnContext);
      expect(prompt.filter(isTurnContext)).toHaveLength(1);
      expect(prompt[at - 1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: QUESTION }] });
      expect(textOf(prompt[at])).toBe(textOf(first.at(-1)!));
      // Nothing in the user's role follows a tool result: here no page and no note, so a step ends with its newest result.
      const firstResult = prompt.findIndex((m) => m.role === 'tool');
      if (firstResult === -1) continue;
      expect(prompt.slice(firstResult).filter((m) => m.role === 'user')).toEqual([]);
      expect(prompt.at(-1)!.role).toBe('tool');
    }
    // Steps two and three: the turn's message, its context, then the calls and their results.
    expect(prompts[2].slice(-6).map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant', 'tool']);
  });

  it('leaves after a tool result only what is true for that step, in its own tags', async () => {
    const note = 'You have one step left. Say what is done.';
    const { model, prompts } = scripted(['service_times']);
    await turn(model, { note });
    for (const prompt of prompts) {
      const tail = prompt.at(-1)!;
      expect(isTail(tail)).toBe(true);
      expect(textOf(tail)).toBe(`<step_note>\n${note}\n</step_note>`);
      for (const line of CONTEXT_LINES) expect(textOf(tail)).not.toContain(line);
    }
    // After the tool's result: the step's note alone.
    expect(prompts[1].slice(-3).map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
  });

  it('is read from the cache on every later step: each step begins with the whole of the step before it, within four breakpoints', async () => {
    const { model, prompts } = scripted(['service_times', 'service_bays', 'service_times']);
    await turn(model, { note: 'A note for this step only.' });
    expect(prompts).toHaveLength(4);
    for (let i = 1; i < prompts.length; i++) {
      const before = conversation(prompts[i - 1]).map((m) => JSON.stringify(m.content));
      const now = conversation(prompts[i]).map((m) => JSON.stringify(m.content));
      expect(now.slice(0, before.length)).toEqual(before);
    }
    for (const prompt of prompts) {
      // The conversation's end carries the moving breakpoint: the turn's context on the first step, then the newest result.
      expect(marked(conversation(prompt).at(-1)!)).toBe(true);
      expect(marked(prompt.at(-1)!)).toBe(false);
      expect(prompt.filter(marked).length).toBeLessThanOrEqual(4);
    }
    expect(isTurnContext(conversation(prompts[0]).at(-1)!)).toBe(true);
    for (const prompt of prompts.slice(1)) {
      expect(conversation(prompt).at(-1)!.role).toBe('tool');
      // The breakpoint the first step put on the context is not carried: one moving breakpoint at a time.
      expect(marked(prompt.find(isTurnContext)!)).toBe(false);
    }
    // The system prompt never changes.
    expect(new Set(prompts.map((p) => JSON.stringify(p.filter((m) => m.role === 'system')))).size).toBe(1);
  });
});

describe('a turn’s context after the conversation (turnContextPlacement: after-conversation)', () => {
  it('is sent after the conversation on every step, as 0.30 sent it: after the tool result, with the notes after it', async () => {
    const note = 'A note for this step only.';
    const { model, prompts } = scripted(['service_times']);
    await turn(model, { placement: 'after-conversation', note });
    for (const prompt of prompts) {
      expect(prompt.filter(isTurnContext)).toEqual([]);
      const tail = textOf(prompt.at(-1)!);
      expect(isTail(prompt.at(-1)!)).toBe(true);
      for (const line of CONTEXT_LINES) expect(tail).toContain(line);
      expect(tail.indexOf(STEP_CONTEXT)).toBeLessThan(tail.indexOf('<step_note>'));
    }
    expect(prompts[1].slice(-3).map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
  });

  it('is one of the placements there are, and anything else is refused', async () => {
    expect(TURN_CONTEXT_PLACEMENTS).toEqual(['with-message', 'after-conversation']);
    const { model } = scripted([]);
    await expect(turn(model, { placement: 'end' as TurnContextPlacement })).rejects.toThrow(/turnContextPlacement must be one of with-message, after-conversation/);
  });
});
