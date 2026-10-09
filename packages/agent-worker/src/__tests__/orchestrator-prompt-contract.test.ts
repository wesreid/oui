/**
 * The request we build must be one the `ai` package will actually accept.
 *
 * Every other orchestrator test mocks the `ai` module, which means none of them
 * exercise its prompt validation — and that is exactly where a change broke.
 * Moving the system prompt into `messages` to give it a cache breakpoint looked
 * right at the provider layer (`SystemModelMessage` carries `providerOptions`,
 * and the Bedrock converter handles a system role), passed every mocked test,
 * and then failed on the first real turn:
 *
 *   AI_InvalidPromptError: System messages are not allowed in the prompt or
 *   messages fields. Use the instructions option instead.
 *
 * `allowSystemInMessages` defaults to false. The system prompt belongs in
 * `instructions`, which accepts a SystemModelMessage and so still carries the
 * breakpoint.
 *
 * So this file mocks only the PROVIDER and lets the real `streamText` validate.
 * A regression here fails at the same place the real turn would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';
import { createToolRegistry } from '../tools/types.js';

let lastCall: Record<string, unknown> | undefined;

const mockModel = new MockLanguageModelV4({
  doStream: async (options: Record<string, unknown>) => {
    lastCall = options;
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'ok' },
          { type: 'text-end', id: '0' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          },
        ],
      }),
    };
  },
});

// Only the model is a stand-in. `ai` is real, so its prompt validation runs.

function makeConfig(): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: mockModel,
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
    systemPrompt: 'You are the persona agent.',
  };
}

function makeInput(): AgentTurnInput {
  return {
    turnId: 'turn-contract-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'room-1',
    content: 'complete this persona',
  };
}

describe('the request survives the real ai prompt validation', () => {
  beforeEach(() => {
    lastCall = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a turn without AI_InvalidPromptError', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(makeConfig(), makeInput());
    // The failure mode was a thrown InvalidPromptError before any output.
    expect(result.stopReason).toBe('complete');
  });

  it('delivers the system prompt to the model', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(), makeInput());
    const prompt = lastCall!.prompt as Array<{ role: string; content: unknown }>;
    const system = prompt.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(JSON.stringify(system!.content)).toContain('You are the persona agent.');
  });

  it('keeps the cache breakpoint on the system prompt', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(), makeInput());
    const prompt = lastCall!.prompt as Array<{ role: string; providerOptions?: unknown }>;
    const system = prompt.find((m) => m.role === 'system');
    expect(system!.providerOptions).toEqual({
      amazonBedrock: { cachePoint: { type: 'default' } },
    });
  });

  it('keeps the cache breakpoint on the last message', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(), makeInput());
    const prompt = lastCall!.prompt as Array<{ role: string; providerOptions?: unknown }>;
    const nonSystem = prompt.filter((m) => m.role !== 'system');
    expect(nonSystem.at(-1)!.providerOptions).toEqual({
      amazonBedrock: { cachePoint: { type: 'default' } },
    });
  });

  it('delivers a turn policy’s note after the conversation, leaving the cached system prompt as it is', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const note = 'You have used this turn’s steps. Say what is done and what is left.';
    const result = await runAgentTurn(
      { ...makeConfig(), turnPolicy: { classifyTurn: () => 'normal', prepareStep: async () => ({ note }) } },
      makeInput(),
    );
    expect(result.stopReason).toBe('complete');
    const prompt = lastCall!.prompt as Array<{ role: string; content: unknown; providerOptions?: unknown }>;
    // One system message, the same one every step, so no note changes the prefix the cache holds.
    const system = prompt.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(JSON.stringify(system[0].content)).toContain('You are the persona agent.');
    expect(system[0].providerOptions).toEqual({ amazonBedrock: { cachePoint: { type: 'default' } } });
    // The note is the last thing read, after the conversation's cache breakpoint.
    const last = prompt.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain(`<step_note>\\n${note}\\n</step_note>`);
    expect(JSON.stringify(last.providerOptions ?? {})).not.toContain('cachePoint');
    expect(prompt.at(-2)!.providerOptions).toEqual({ amazonBedrock: { cachePoint: { type: 'default' } } });
  });
});
