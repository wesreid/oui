/**
 * A step cut off at the output limit before it said or called anything, through
 * the real `ai` loop. Only the model is a stand-in.
 *
 * On dev (2026-10-08) a request for a five-part animation ended twice with
 * nothing: the model spent the whole 4,096-token output limit thinking, the
 * stream ended as if the turn were done, and nothing was said, called or stored.
 * Such a step's output is discarded and the step runs once more, told to plan
 * less; if that is cut off too, the person is told.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';

type PromptPart = { type: string; text?: string };
type PromptMessage = { role: string; content: string | PromptPart[] };

const usage = (output: number) => ({
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: 0, reasoning: output },
});

/** One step of the stand-in model. */
type Step = { call: string } | { say: string } | 'cut-off';

const CUT_OFF_THINKING = 'Planning the spin, the slide, the reveal and the zoom';

function chunksOf(step: Step, n: number) {
  if (step === 'cut-off') {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: CUT_OFF_THINKING },
      { type: 'reasoning-end', id: 'r' },
      { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage: usage(4_096) },
    ];
  }
  if ('call' in step) {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `call-${n}`, toolName: step.call, input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(40) },
    ];
  }
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: step.say },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: usage(20) },
  ];
}

/** A model that takes these steps, one per call. Each call's prompt and output limit are kept. */
function scripted(steps: Step[]) {
  const prompts: PromptMessage[][] = [];
  const limits: Array<number | undefined> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown; maxOutputTokens?: number }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      limits.push(options.maxOutputTokens);
      const step = steps[prompts.length - 1];
      if (!step) throw new Error(`The model was called ${prompts.length} times; the script has ${steps.length} steps`);
      return { stream: simulateReadableStream({ chunks: chunksOf(step, prompts.length) as never[] }) };
    },
  } as never);
  return { model, prompts, limits };
}

const inspect: RegisteredTool = {
  name: 'layer_inspect',
  description: 'Read a layer',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, data: { box: [0, 0, 268, 268] } })),
};

async function turn(model: unknown) {
  const tokens: string[] = [];
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([inspect]),
    emit: {
      emit: vi.fn(async (_room: string, event: string, data: unknown) => {
        if (event === 'agent:token') tokens.push((data as { text: string }).text);
      }),
    },
    model: model as AgentWorkerConfig['model'],
    systemPrompt: 'You are the assistant.',
  };
  const input: AgentTurnInput = {
    turnId: 'turn-output-limit',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-output-limit',
    content: 'Spin the wheel, slide it off to reveal the letters, then zoom it back in',
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  const result = await runAgentTurn(config, input);
  return { result, reply: tokens.join('') };
}

const text = (prompt: PromptMessage[]) =>
  prompt.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''))).join('\n');
const systemText = (prompt: PromptMessage[]) => text(prompt.filter((m) => m.role === 'system'));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a step cut off at the output limit before it said or called anything', () => {
  it('gives the model room to think: 32,000 tokens a response unless the host says otherwise', async () => {
    const { model, limits } = scripted([{ say: 'Done.' }]);
    await turn(model);
    expect(limits).toEqual([32_000]);
  });

  it('runs again without the discarded output, told to plan less, and the turn goes on', async () => {
    const { model, prompts } = scripted([{ call: 'layer_inspect' }, 'cut-off', { say: 'Starting with the spin.' }]);
    const { result, reply } = await turn(model);

    expect(prompts).toHaveLength(3);
    // The cut-off step had no note; the step that replaced it is told why it runs again, after its conversation.
    expect(text(prompts[1])).not.toContain('reached the output limit');
    expect(text(prompts[2].slice(-1))).toContain('reached the output limit');
    expect(systemText(prompts[2])).toBe(systemText(prompts[1]));
    // It keeps what the turn did before the cut-off, and none of the cut-off step's output.
    expect(prompts[2].some((m) => m.role === 'tool')).toBe(true);
    expect(text(prompts[2])).not.toContain(CUT_OFF_THINKING);

    expect(reply).toBe('Starting with the spin.');
    expect(result.stopReason).toBe('complete');
    expect(result.newMessages.map((m) => [m.role, m.content])).toEqual([
      ['assistant', null],
      ['tool', expect.any(String)],
      ['assistant', 'Starting with the spin.'],
    ]);
    // Every call counts: the cut-off one cost its tokens.
    expect(result.rounds).toBe(3);
    expect(result.usage.completionTokens).toBe(40 + 4_096 + 20);
  });

  it('tells the person, and stores it, when the step that replaced it is cut off too', async () => {
    const { model, prompts } = scripted(['cut-off', 'cut-off']);
    const { result, reply } = await turn(model);

    expect(prompts).toHaveLength(2);
    expect(reply).toMatch(/^I ran out of room while working out how to do this, before I could start, so nothing was changed\./);
    expect(result.stopReason).toBe('output_limit');
    expect(result.newMessages).toEqual([{ role: 'assistant', content: reply }]);
  });

  it('leaves a step cut off after it said something as it is', async () => {
    // A step that wrote text and then reached the limit is not run again: what it said was streamed.
    const prompts: PromptMessage[][] = [];
    const cut = new MockLanguageModelV4({
      doStream: async (options: { prompt: unknown }) => {
        prompts.push(structuredClone(options.prompt) as PromptMessage[]);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Here is the plan' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage: usage(32_000) },
            ] as never[],
          }),
        };
      },
    } as never);
    const { result, reply } = await turn(cut);

    expect(prompts).toHaveLength(1);
    expect(reply).toBe('Here is the plan');
    expect(result.stopReason).toBe('complete');
  });
});
