/**
 * Orchestrator Execution Bounds Tests (W7.T1)
 *
 * Tests all four execution bounds:
 *   1. Token budget — maxOutputTokens passed to streamText
 *   2. Wall-clock deadline — AbortSignal fires on timeout
 *   3. Per-tool quota — side-effecting tools capped at SIDE_EFFECT_TOOL_QUOTA (2)
 *   4. Retries — maxRetries forwarded to streamText
 *
 * Also tests stopReason detection for step_count and present_options.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';

// ─── Mock the `ai` module ────────────────────────────────────────────────────

interface MockStep {
  text: string;
  toolCalls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }>;
  toolResults: unknown[];
}

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;

vi.mock('ai', () => {
  return {
    streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
    dynamicTool: (def: Record<string, unknown>) => def,
    jsonSchema: (schema: Record<string, unknown>) => schema,
    isStepCount: (n: number) => `isStepCount(${n})`,
    hasToolCall: (name: string) => `hasToolCall(${name})`,
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockStreamResult(steps: MockStep[]): Record<string, unknown> {
  async function* textGen() {
    for (const step of steps) {
      if (step.text) {
        yield step.text;
      }
    }
  }

  return {
    textStream: textGen(),
    steps: Promise.resolve(steps),
    usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
    response: Promise.resolve({
      messages: steps.map((s) => ({
        role: 'assistant',
        content: s.text || null,
        tool_calls: s.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: 'function',
          function: { name: tc.toolName, arguments: JSON.stringify(tc.args) },
        })),
      })),
    }),
  };
}

function makeEmit(): { emit: ReturnType<typeof vi.fn>; calls: Array<{ event: string; data: unknown }> } {
  const calls: Array<{ event: string; data: unknown }> = [];
  const emit = vi.fn(async (_room: string, event: string, data: unknown) => {
    calls.push({ event, data });
  });
  return { emit, calls };
}

function makeSideEffectingTool(name: string): RegisteredTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    execute: vi.fn(async () => ({ success: true, data: { result: `${name} done` } })),
  };
}

function makeReadOnlyTool(name: string): RegisteredTool {
  return {
    name,
    description: `Read-only tool ${name}`,
    inputSchema: { type: 'object', properties: {}, sideEffects: false } as Record<string, unknown>,
    execute: vi.fn(async () => ({ success: true, data: { result: `${name} done` } })),
  };
}

function makeBaseInput(overrides?: Partial<AgentTurnInput>): AgentTurnInput {
  return {
    turnId: 'turn-test-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'room-1',
    content: 'Hello agent',
    ...overrides,
  };
}

function makeBaseConfig(overrides?: Partial<AgentWorkerConfig>): AgentWorkerConfig {
  const { emit: emitFn } = makeEmit();
  return {
    tools: createToolRegistry([]),
    emit: { emit: emitFn },
    model: 'test-model',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Orchestrator Execution Bounds (W7.T1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Token budget ────────────────────────────────────────────────────────

  describe('Token budget', () => {
    it('passes maxOutputTokens to streamText call options', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ maxTokens: 8192 });
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.maxOutputTokens).toBe(8192);
    });

    it('uses DEFAULT_MAX_TOKENS (4096) when maxTokens not specified', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig();
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.maxOutputTokens).toBe(4096);
    });
  });

  // ── 2. Wall-clock deadline ─────────────────────────────────────────────────

  describe('Wall-clock deadline', () => {
    it('fires AbortSignal and turn fails with deadline error', async () => {
      // Use real timers for this test — fake timers don't advance inside async generators
      vi.useRealTimers();

      let capturedAbortSignal: AbortSignal | undefined;

      mockStreamTextImpl = (opts) => {
        capturedAbortSignal = opts.abortSignal as AbortSignal;
        // Return a stream that blocks until aborted
        return {
          textStream: (async function* () {
            // Yield empty to satisfy require-yield, then wait for abort
            yield '';
            // Wait until abort fires (or 10s safety ceiling)
            await new Promise<void>((resolve) => {
              const signal = opts.abortSignal as AbortSignal;
              if (signal.aborted) { resolve(); return; }
              signal.addEventListener('abort', () => resolve(), { once: true });
              setTimeout(resolve, 10_000);
            });
            // After abort, throw like a real stream would
            throw new Error('This operation was aborted');
          })(),
          steps: new Promise(() => {}),
          usage: new Promise(() => {}),
          response: new Promise(() => {}),
        };
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const { emit: emitFn } = makeEmit();
      const config = makeBaseConfig({
        emit: { emit: emitFn },
        turnDeadlineMs: 50, // Very short deadline for test
      });

      // The turn should reject/throw due to abort
      await expect(runAgentTurn(config, makeBaseInput())).rejects.toThrow();

      // The abort signal should have fired
      expect(capturedAbortSignal?.aborted).toBe(true);
    }, 15_000);
  });

  // ── 3. Per-tool quota ──────────────────────────────────────────────────────

  describe('Per-tool quota', () => {
    it('side-effecting tool is capped at SIDE_EFFECT_TOOL_QUOTA (2)', async () => {
      const seTool = makeSideEffectingTool('create_item');
      let toolExecuteCount = 0;

      mockStreamTextImpl = (opts) => {
        // The orchestrator wraps our tools with dynamicTool. We need to find
        // the wrapped execute function and call it to test quota enforcement.
        const tools = opts.tools as Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;
        const wrappedTool = tools['create_item'];

        // Simulate 3 tool calls in sequence
        const runToolCalls = async () => {
          const results: string[] = [];
          for (let i = 0; i < 3; i++) {
            const result = await wrappedTool.execute(
              { input: `call-${i}` },
              { toolCallId: `tc_${i}` },
            );
            results.push(result);
            toolExecuteCount++;
          }
          return results;
        };

        const resultsPromise = runToolCalls();

        return {
          textStream: (async function* () {
            await resultsPromise;
            yield 'Done';
          })(),
          steps: resultsPromise.then(() => [
            { text: 'Done', toolCalls: [], toolResults: [] },
          ]),
          usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
          response: Promise.resolve({ messages: [] }),
        };
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const { emit: emitFn } = makeEmit();
      const config = makeBaseConfig({
        tools: createToolRegistry([seTool]),
        emit: { emit: emitFn },
      });

      await runAgentTurn(config, makeBaseInput());

      expect(toolExecuteCount).toBe(3);
      // The underlying tool should have been called only 2 times (quota = 2)
      expect(seTool.execute).toHaveBeenCalledTimes(2);
    });

    it('read-only tool (sideEffects: false) has higher quota (DEFAULT_TOOL_QUOTA = 12)', async () => {
      const roTool = makeReadOnlyTool('search');

      mockStreamTextImpl = (opts) => {
        const tools = opts.tools as Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;
        const wrappedTool = tools['search'];

        const runToolCalls = async () => {
          for (let i = 0; i < 5; i++) {
            await wrappedTool.execute({}, { toolCallId: `tc_${i}` });
          }
        };

        const p = runToolCalls();

        return {
          textStream: (async function* () {
            await p;
            yield 'Done';
          })(),
          steps: p.then(() => [{ text: 'Done', toolCalls: [], toolResults: [] }]),
          usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
          response: Promise.resolve({ messages: [] }),
        };
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const { emit: emitFn } = makeEmit();
      const config = makeBaseConfig({
        tools: createToolRegistry([roTool]),
        emit: { emit: emitFn },
      });

      await runAgentTurn(config, makeBaseInput());

      // All 5 calls should pass — below the 12 quota
      expect(roTool.execute).toHaveBeenCalledTimes(5);
    });

    it('quota refusal returns JSON with quotaExceeded: true', async () => {
      const seTool = makeSideEffectingTool('mutate_item');
      let thirdCallResult: string | undefined;

      mockStreamTextImpl = (opts) => {
        const tools = opts.tools as Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;
        const wrappedTool = tools['mutate_item'];

        const runToolCalls = async () => {
          await wrappedTool.execute({}, { toolCallId: 'tc_0' });
          await wrappedTool.execute({}, { toolCallId: 'tc_1' });
          thirdCallResult = await wrappedTool.execute({}, { toolCallId: 'tc_2' });
        };

        const p = runToolCalls();

        return {
          textStream: (async function* () {
            await p;
            yield 'Done';
          })(),
          steps: p.then(() => [{ text: 'Done', toolCalls: [], toolResults: [] }]),
          usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
          response: Promise.resolve({ messages: [] }),
        };
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const { emit: emitFn } = makeEmit();
      const config = makeBaseConfig({
        tools: createToolRegistry([seTool]),
        emit: { emit: emitFn },
      });

      await runAgentTurn(config, makeBaseInput());

      expect(thirdCallResult).toBeDefined();
      const parsed = JSON.parse(thirdCallResult!);
      expect(parsed.quotaExceeded).toBe(true);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('maximum invocation quota');
    });
  });

  // ── 4. Retries ─────────────────────────────────────────────────────────────

  describe('Retries', () => {
    it('passes maxRetries to streamText', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ retries: 5 });
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.maxRetries).toBe(5);
    });

    it('defaults to 3 retries when not specified', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig();
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.maxRetries).toBe(3);
    });
  });

  // ── 5. Stop reason ─────────────────────────────────────────────────────────

  describe('Stop reason', () => {
    it('returns step_count when max rounds reached', async () => {
      const maxRounds = 2;
      // Create steps equal to maxRounds
      const steps: MockStep[] = Array.from({ length: maxRounds }, (_, i) => ({
        text: `Step ${i}`,
        toolCalls: [],
        toolResults: [],
      }));

      mockStreamTextImpl = () => createMockStreamResult(steps);

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ maxToolRounds: maxRounds });
      const result = await runAgentTurn(config, makeBaseInput());

      expect(result.stopReason).toBe('step_count');
      expect(result.maxRoundsReached).toBe(true);
    });

    it('returns present_options when that tool is called', async () => {
      const steps: MockStep[] = [
        {
          text: 'Here are your options',
          toolCalls: [{ toolName: 'present_options', toolCallId: 'tc_po', args: { options: [] } }],
          toolResults: [],
        },
      ];

      mockStreamTextImpl = () => createMockStreamResult(steps);

      const { runAgentTurn } = await import('../orchestrator.js');

      const { emit: emitFn } = makeEmit();
      const config = makeBaseConfig({ emit: { emit: emitFn } });
      const result = await runAgentTurn(config, makeBaseInput());

      expect(result.stopReason).toBe('present_options');
    });

    it('returns complete for a normal single-step turn', async () => {
      mockStreamTextImpl = () => createMockStreamResult([
        { text: 'Just a simple response.', toolCalls: [], toolResults: [] },
      ]);

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ maxToolRounds: 12 });
      const result = await runAgentTurn(config, makeBaseInput());

      expect(result.stopReason).toBe('complete');
      expect(result.maxRoundsReached).toBe(false);
    });
  });

  // ── 6. streamText options validation ───────────────────────────────────────

  describe('streamText options', () => {
    it('passes temperature to streamText', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ temperature: 0.7 });
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.temperature).toBe(0.7);
    });

    it('passes system prompt to streamText', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({ systemPrompt: 'Custom prompt' });
      await runAgentTurn(config, makeBaseInput());

      // The system prompt travels in `instructions`, not the deprecated
      // top-level `system` and never inside `messages` (ai rejects a system
      // role there). `instructions` takes a SystemModelMessage, which is what
      // lets it carry a cache breakpoint. Same invariant, new location.
      const instructions = capturedOpts.instructions as Record<string, unknown>;
      expect(instructions.role).toBe('system');
      expect(instructions.content).toBe('Custom prompt');
    });

    it('supports function-based system prompt with context', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig({
        model: 'test-model',
        systemPrompt: ({ userId, accountId }) => `Hello ${userId} from ${accountId}`,
      });
      await runAgentTurn(config, makeBaseInput({ userId: 'u1', accountId: 'a1' }));

      const instructions = capturedOpts.instructions as Record<string, unknown>;
      expect(instructions.role).toBe('system');
      expect(instructions.content).toBe('Hello u1 from a1');
    });

    it('passes abort signal to streamText', async () => {
      let capturedOpts: Record<string, unknown> = {};
      mockStreamTextImpl = (opts) => {
        capturedOpts = opts;
        return createMockStreamResult([
          { text: 'Hello!', toolCalls: [], toolResults: [] },
        ]);
      };

      const { runAgentTurn } = await import('../orchestrator.js');

      const config = makeBaseConfig();
      await runAgentTurn(config, makeBaseInput());

      expect(capturedOpts.abortSignal).toBeDefined();
      expect(capturedOpts.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });
});
