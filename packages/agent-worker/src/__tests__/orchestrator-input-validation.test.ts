/**
 * The orchestrator validates every tool call's input against the tool's schema before
 * quota, policy or execution.
 *
 * Tools reach the model as raw JSON Schema with no validator, so a call's arguments were
 * whatever the model produced. A host's entity update tool passed every key it received
 * to a database write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

type WrappedTools = Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;

/** Run one turn in which the model makes the given calls, and return each call's result. */
async function runCalls(
  tools: RegisteredTool[],
  calls: Array<{ tool: string; args: unknown }>,
  overrides: Partial<AgentWorkerConfig> = {},
): Promise<Array<Record<string, unknown>>> {
  let results: Array<Record<string, unknown>> = [];
  mockStreamTextImpl = (opts) => {
    const wrapped = opts.tools as WrappedTools;
    const done = (async () => {
      for (const [i, call] of calls.entries()) {
        const raw = await wrapped[call.tool].execute(call.args, { toolCallId: `tc_${i}` });
        results.push(JSON.parse(raw));
      }
    })();
    return {
      textStream: (async function* () {
        await done;
        yield 'Done';
      })(),
      steps: done.then(() => [{ text: 'Done', toolCalls: [], toolResults: [] }]),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
      response: Promise.resolve({ messages: [] }),
    };
  };

  const { runAgentTurn } = await import('../orchestrator.js');
  const config: AgentWorkerConfig = {
    tools: createToolRegistry(tools),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
  const input: AgentTurnInput = {
    turnId: 'turn-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'room-1',
    content: 'Hello',
  };
  results = [];
  await runAgentTurn(config, input);
  return results;
}

function updateTool(): RegisteredTool {
  return {
    name: 'update-character',
    description: 'Update a character',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({ success: true, data: { updated: true } })),
  };
}

describe('orchestrator tool input validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects an undeclared property without running the tool', async () => {
    const tool = updateTool();
    const [result] = await runCalls([tool], [
      { tool: 'update-character', args: { id: 'c1', accountId: 'someone-elses-account' } },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Invalid input for "update-character": (input) has a property this tool does not accept: "accountId"',
      invalidInput: true,
    });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('rejects a missing required property and a wrong type, reporting both', async () => {
    const tool = updateTool();
    const [result] = await runCalls([tool], [{ tool: 'update-character', args: { name: 7 } }]);

    expect(result.invalidInput).toBe(true);
    expect(result.error).toContain('is missing required property "id"');
    expect(result.error).toContain('/name must be string');
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('does not consult the policy for an invalid call', async () => {
    const tool = updateTool();
    const evaluate = vi.fn(async () => ({ action: 'allow' as const }));
    await runCalls([tool], [{ tool: 'update-character', args: {} }], { toolPolicy: { evaluate } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not count an invalid call against the tool quota', async () => {
    // Side-effecting tools are capped at 2 calls per turn.
    const tool = updateTool();
    const results = await runCalls([tool], [
      { tool: 'update-character', args: {} },
      { tool: 'update-character', args: {} },
      { tool: 'update-character', args: { id: 'c1', name: 'Ada' } },
      { tool: 'update-character', args: { id: 'c1', name: 'Ada' } },
    ]);

    // A successful call returns the tool's data; a refusal carries invalidInput.
    expect(results).toEqual([
      expect.objectContaining({ invalidInput: true }),
      expect.objectContaining({ invalidInput: true }),
      { updated: true },
      { updated: true },
    ]);
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });

  it('runs a valid call with the validated input, dropping nulls on optional properties', async () => {
    const tool = updateTool();
    const evaluate = vi.fn(async () => ({ action: 'allow' as const }));
    const [result] = await runCalls(
      [tool],
      [{ tool: 'update-character', args: { id: 'c1', name: null } }],
      { toolPolicy: { evaluate } },
    );

    expect(result).toEqual({ updated: true });
    expect(tool.execute).toHaveBeenCalledWith({ id: 'c1' }, expect.anything());
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ args: { id: 'c1' } }));
  });
});
