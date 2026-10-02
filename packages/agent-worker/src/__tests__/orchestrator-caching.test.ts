/**
 * Prompt caching and honest token accounting.
 *
 * Two defects, one measurement:
 *
 * Every round re-sent the same ~25k-token prefix — the system prompt plus ~87
 * tool schemas — at full price. Nothing was cached, so a five-round turn paid
 * for that prefix five times.
 *
 * And the only figure reported was `promptTokens`, the SUM over rounds. Read as
 * a context measurement it is wrong by a factor of the round count: a turn
 * showed 128,808 tokens when no single call exceeded ~26,000. The context
 * ceiling fired on turns nowhere near the window, and stayed quiet about the
 * ones that were.
 *
 * These tests pin the request shape that makes caching possible (a prefix that
 * is marked and append-only) and the separation of peak from sum.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';
import { createToolRegistry } from '../tools/types.js';

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;
let lastOpts: Record<string, unknown> | null = null;

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => {
    lastOpts = opts;
    return mockStreamTextImpl(opts);
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

type StepUsage = { inputTokens: number; outputTokens: number };

function mockResult(
  stepUsages: StepUsage[],
  totals?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): Record<string, unknown> {
  async function* textGen() {
    yield 'ok';
  }
  const summed = stepUsages.reduce(
    (a, s) => ({ inputTokens: a.inputTokens + s.inputTokens, outputTokens: a.outputTokens + s.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const t = totals ?? summed;
  return {
    textStream: textGen(),
    steps: Promise.resolve(stepUsages.map((u) => ({ text: 'ok', toolCalls: [], toolResults: [], usage: u }))),
    usage: Promise.resolve({
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      inputTokenDetails: {
        cacheReadTokens: t.cacheReadTokens ?? 0,
        cacheWriteTokens: t.cacheWriteTokens ?? 0,
      },
    }),
    response: Promise.resolve({ messages: [] }),
  };
}

function makeInput(overrides?: Partial<AgentTurnInput>): AgentTurnInput {
  return {
    turnId: 'turn-cache-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'room-1',
    content: 'Write the persona',
    ...overrides,
  };
}

const CACHE_POINT = PROMPT_CACHE_BREAKPOINTS.bedrock;

function makeConfig(overrides: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    promptCacheBreakpoint: CACHE_POINT,
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

async function run(stepUsages: StepUsage[], totals?: Parameters<typeof mockResult>[1], overrides: Partial<AgentWorkerConfig> = {}) {
  mockStreamTextImpl = () => mockResult(stepUsages, totals);
  const { runAgentTurn } = await import('../orchestrator.js');
  return runAgentTurn(makeConfig(overrides), makeInput());
}

describe('prompt cache breakpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    lastOpts = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the system prompt through instructions, which can carry a cache point', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    const instructions = lastOpts!.instructions as Record<string, unknown>;
    expect(instructions.role).toBe('system');
    expect(instructions.content).toBe('You are a test agent.');
  });

  it('never puts a system role in messages — ai rejects the whole request', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    const messages = lastOpts!.messages as Array<Record<string, unknown>>;
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('does not use the deprecated top-level system field', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    expect(lastOpts!.system).toBeUndefined();
  });

  it('marks the system block, which caches the tool schemas ahead of it', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    const instructions = lastOpts!.instructions as Record<string, unknown>;
    expect(instructions.providerOptions).toEqual(CACHE_POINT);
  });

  it('marks the end of the incoming history', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    const messages = lastOpts!.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)!.providerOptions).toEqual(CACHE_POINT);
  });

  it('marks exactly two breakpoints — the cap is four, and each one costs a write', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }]);
    const instructions = lastOpts!.instructions as Record<string, unknown>;
    const messages = lastOpts!.messages as Array<Record<string, unknown>>;
    const marked =
      (instructions.providerOptions ? 1 : 0) +
      messages.filter((m) => m.providerOptions != null).length;
    expect(marked).toBe(2);
  });

  it('marks nothing when the host names no breakpoint — a provider that caches on its own', async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }], undefined, { promptCacheBreakpoint: undefined });
    const instructions = lastOpts!.instructions as Record<string, unknown>;
    const messages = lastOpts!.messages as Array<Record<string, unknown>>;
    expect(instructions.providerOptions).toBeUndefined();
    expect(messages.every((m) => m.providerOptions == null)).toBe(true);
  });

  it("uses whichever provider's breakpoint the host names", async () => {
    await run([{ inputTokens: 100, outputTokens: 10 }], undefined, { promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.anthropic });
    const instructions = lastOpts!.instructions as Record<string, unknown>;
    expect(instructions.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  it('keeps every history message, marking rather than dropping', async () => {
    mockStreamTextImpl = () => mockResult([{ inputTokens: 100, outputTokens: 10 }]);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      makeConfig(),
      makeInput({
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ] as AgentTurnInput['history'],
      }),
    );
    const messages = lastOpts!.messages as Array<Record<string, unknown>>;
    // two history turns + the new user content; the system prompt is separate
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('token accounting separates peak from sum', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    lastOpts = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports the largest single call as peak, not the sum', async () => {
    // The shape of the real five-round turn: ~25k per call, 128k summed.
    const result = await run(
      [
        { inputTokens: 25_000, outputTokens: 100 },
        { inputTokens: 25_500, outputTokens: 100 },
        { inputTokens: 26_000, outputTokens: 100 },
        { inputTokens: 26_100, outputTokens: 100 },
        { inputTokens: 26_208, outputTokens: 100 },
      ],
      { inputTokens: 128_808, outputTokens: 500 },
    );
    expect(result.usage.peakPromptTokens).toBe(26_208);
    expect(result.usage.promptTokens).toBe(128_808);
  });

  it('peak equals the sum on a single-round turn', async () => {
    const result = await run([{ inputTokens: 24_600, outputTokens: 80 }], {
      inputTokens: 24_600,
      outputTokens: 80,
    });
    expect(result.usage.peakPromptTokens).toBe(24_600);
    expect(result.usage.promptTokens).toBe(24_600);
  });

  it('surfaces cache reads and writes so a silent miss is visible', async () => {
    const result = await run([{ inputTokens: 25_000, outputTokens: 100 }], {
      inputTokens: 50_000,
      outputTokens: 200,
      cacheReadTokens: 24_000,
      cacheWriteTokens: 25_000,
    });
    expect(result.usage.cacheReadTokens).toBe(24_000);
    expect(result.usage.cacheWriteTokens).toBe(25_000);
  });

  it('reports zeroes rather than undefined when the provider omits cache details', async () => {
    mockStreamTextImpl = () => ({
      textStream: (async function* () { yield 'ok'; })(),
      steps: Promise.resolve([{ text: 'ok', toolCalls: [], toolResults: [], usage: { inputTokens: 10, outputTokens: 1 } }]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 1 }),
      response: Promise.resolve({ messages: [] }),
    });
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(makeConfig(), makeInput());
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheWriteTokens).toBe(0);
  });

  it('handles a turn with no steps without producing NaN', async () => {
    const result = await run([], { inputTokens: 0, outputTokens: 0 });
    expect(result.usage.peakPromptTokens).toBe(0);
  });
});
