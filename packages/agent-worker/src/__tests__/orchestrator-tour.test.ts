/**
 * TurnPolicy integration tests (W8.T2)
 *
 * Validates the TurnPolicy interface contract and integration with the orchestrator.
 * The Closure-specific tour functions (detectTurnIntent, inferTourDestination,
 * buildPrepareStep) have been relocated to studio-api as a custom TurnPolicy
 * implementation. These tests verify the SDK's policy machinery works correctly
 * with both the default and custom policies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defaultTurnPolicy } from '../turn-policy.js';
import type { TurnPolicy } from '../turn-policy.js';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';

// ─── Mock the AI module ──────────────────────────────────────────────────────

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ALL_TOOLS = ['navigate', 'open_entity', 'present_options', 'search', 'answer'];

function makeTools(names: string[]): RegisteredTool[] {
  return names.map((name) => ({
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object' as const, properties: {} },
    execute: vi.fn(async () => ({ success: true, data: { result: `${name} done` } })),
  }));
}

// ─── Default policy tests ────────────────────────────────────────────────────

describe('defaultTurnPolicy', () => {
  it('classifies all turns as "normal"', () => {
    expect(defaultTurnPolicy.classifyTurn('Hello')).toBe('normal');
    expect(defaultTurnPolicy.classifyTurn('Show me around')).toBe('normal');
    expect(defaultTurnPolicy.classifyTurn('Next → Characters')).toBe('normal');
    expect(defaultTurnPolicy.classifyTurn('Tell me more', [
      { role: 'user', content: 'Give me a tour' },
    ])).toBe('normal');
  });

  it('applies no constraints on any step', async () => {
    expect(await defaultTurnPolicy.prepareStep({
      steps: [],
      turnClass: 'normal',
      allToolNames: ALL_TOOLS,
    })).toEqual({});

    expect(await defaultTurnPolicy.prepareStep({
      steps: [{ toolCalls: [{ toolName: 'navigate' }] }],
      turnClass: 'normal',
      allToolNames: ALL_TOOLS,
    })).toEqual({});

    expect(await defaultTurnPolicy.prepareStep({
      steps: [
        { toolCalls: [{ toolName: 'search' }] },
        { toolCalls: [{ toolName: 'search' }] },
        { toolCalls: [{ toolName: 'search' }] },
        { toolCalls: [{ toolName: 'search' }] },
      ],
      turnClass: 'normal',
      allToolNames: ALL_TOOLS,
    })).toEqual({});
  });

  it('has no onTurnClassified side effect', () => {
    expect(defaultTurnPolicy.onTurnClassified).toBeUndefined();
  });
});

// ─── Custom policy integration tests ────────────────────────────────────────

describe('Custom TurnPolicy integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('orchestrator calls classifyTurn and passes turnClass to prepareStep', async () => {
    const classifyTurn = vi.fn().mockReturnValue('custom_class');
    const prepareStep = vi.fn().mockResolvedValue({});
    const onTurnClassified = vi.fn().mockResolvedValue(undefined);

    const customPolicy: TurnPolicy = {
      classifyTurn,
      prepareStep,
      onTurnClassified,
    };

    // Mock streamText to produce a simple text-only response
    mockStreamTextImpl = (opts: Record<string, unknown>) => {
      const onStepEnd = opts.onStepEnd as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
      // Call prepareStep via the passed function
      const ps = opts.prepareStep as (ctx: { steps: unknown[] }) => Promise<unknown>;

      const exec = async () => {
        if (ps) await ps({ steps: [] });
        if (onStepEnd) await onStepEnd({ text: 'Response', toolCalls: [] });
      };

      const p = exec();

      return {
        textStream: (async function* () {
          await p;
          yield 'Response text.';
        })(),
        steps: p.then(() => [{ text: 'Response text.', toolCalls: [], toolResults: [] }]),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Response text.' }] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const config: AgentWorkerConfig = {
      tools: createToolRegistry(makeTools(['search', 'answer'])),
      emit: { emit: vi.fn(async () => {}) },
      model: 'test-model',
      systemPrompt: 'You are a test assistant.',
      turnPolicy: customPolicy,
    };

    const input: AgentTurnInput = {
      turnId: 'turn-policy-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      accountId: 'acct-1',
      socketRoom: 'room-1',
      content: 'test message',
    };

    await runAgentTurn(config, input);

    // classifyTurn was called with the message content
    expect(classifyTurn).toHaveBeenCalledWith('test message', expect.any(Array));

    // onTurnClassified was called with the classification result
    expect(onTurnClassified).toHaveBeenCalledWith(
      expect.objectContaining({
        turnClass: 'custom_class',
        content: 'test message',
        socketRoom: 'room-1',
      }),
    );

    // prepareStep was called with turnClass from classifyTurn
    expect(prepareStep).toHaveBeenCalledWith(
      expect.objectContaining({
        turnClass: 'custom_class',
        allToolNames: expect.arrayContaining(['search', 'answer']),
      }),
    );
  });

  it('adds the policy’s note after the conversation for that step only, never to the system prompt', async () => {
    const note = 'You have used this turn’s steps. Say what is done and what is left, then offer to continue.';
    const customPolicy: TurnPolicy = {
      classifyTurn: () => 'normal',
      prepareStep: async ({ steps }) =>
        steps.length === 1 ? { toolChoice: { type: 'tool', toolName: 'present_options' }, note } : {},
    };
    const prepared: Array<Record<string, unknown>> = [];
    mockStreamTextImpl = (opts: Record<string, unknown>) => {
      const ps = opts.prepareStep as (ctx: { steps: unknown[]; messages: unknown[] }) => Promise<Record<string, unknown>>;
      const messages = [{ role: 'user', content: 'do it' }];
      const p = (async () => {
        prepared.push(await ps({ steps: [], messages }));
        prepared.push(await ps({ steps: [{ toolCalls: [{ toolName: 'search' }] }], messages }));
        prepared.push(await ps({ steps: [{ toolCalls: [] }, { toolCalls: [] }], messages }));
      })();
      return {
        textStream: (async function* () {
          await p;
          yield 'Done.';
        })(),
        steps: p.then(() => [{ text: 'Done.', toolCalls: [], toolResults: [] }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Done.' }] }),
      };
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      {
        tools: createToolRegistry(makeTools(['search', 'present_options'])),
        emit: { emit: vi.fn(async () => {}) },
        model: 'test-model',
        systemPrompt: 'You are a test assistant.',
        turnPolicy: customPolicy,
      },
      { turnId: 't-note', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'do it' },
    );

    const base = prepared[0].instructions as { role: string; content: string };
    expect(base.role).toBe('system');
    expect(base.content).toContain('You are a test assistant.');
    expect(prepared[1].toolChoice).toEqual({ type: 'tool', toolName: 'present_options' });
    // The system prompt is the same every step: a note there would change the prefix the cache holds.
    expect(prepared[1].instructions).toBe(base);
    expect(prepared[2].instructions).toBe(base);
    expect(prepared[1]).not.toHaveProperty('note');
    const lastOf = (p: Record<string, unknown>) => (p.messages as Array<{ role: string; content: unknown }>).at(-1)!;
    expect(lastOf(prepared[1])).toMatchObject({ role: 'user' });
    expect(JSON.stringify(lastOf(prepared[1]).content)).toContain(`<step_note>\\n${note}\\n</step_note>`);
    // The next step carries no note.
    expect(JSON.stringify(prepared[2].messages)).not.toContain('<step_note>');
  });

  it('holds a forced step by its tools, with no tool choice, for a model that refuses a forced choice', async () => {
    // Claude Sonnet 5.5 answers 400 to a forced choice ("tool_choice: type "tool" and "any" are not supported").
    const customPolicy: TurnPolicy = {
      classifyTurn: () => 'normal',
      prepareStep: async ({ steps }) =>
        steps.length === 1 ? { toolChoice: { type: 'tool', toolName: 'present_options' }, note: 'Hand the turn back.' } : {},
    };
    const prepared: Array<Record<string, unknown>> = [];
    mockStreamTextImpl = (opts: Record<string, unknown>) => {
      const ps = opts.prepareStep as (ctx: { steps: unknown[]; messages: unknown[] }) => Promise<Record<string, unknown>>;
      const messages = [{ role: 'user', content: 'do it' }];
      const p = (async () => {
        prepared.push(await ps({ steps: [], messages }));
        prepared.push(await ps({ steps: [{ toolCalls: [{ toolName: 'search' }] }], messages }));
      })();
      return {
        textStream: (async function* () {
          await p;
          yield 'Done.';
        })(),
        steps: p.then(() => [{ text: 'Done.', toolCalls: [], toolResults: [] }]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Done.' }] }),
      };
    };
    const run = async (forcedToolChoice?: boolean) => {
      prepared.length = 0;
      const { runAgentTurn } = await import('../orchestrator.js');
      await runAgentTurn(
        {
          tools: createToolRegistry(makeTools(['search', 'present_options'])),
          emit: { emit: vi.fn(async () => {}) },
          model: 'test-model',
          systemPrompt: 'You are a test assistant.',
          turnPolicy: customPolicy,
          ...(forcedToolChoice === undefined ? {} : { forcedToolChoice }),
        },
        { turnId: 't-held', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'do it' },
      );
      return prepared[1];
    };
    const tail = (p: Record<string, unknown>) => JSON.stringify((p.messages as unknown[]).at(-1));

    // By default the choice is forced, as the policy asked.
    const forced = await run();
    expect(forced.toolChoice).toEqual({ type: 'tool', toolName: 'present_options' });
    expect(forced).not.toHaveProperty('activeTools');

    // For a model that refuses one: no tool choice, only that tool, and told to call it.
    const held = await run(false);
    expect(held).not.toHaveProperty('toolChoice');
    expect(held.activeTools).toEqual(['present_options']);
    expect(tail(held)).toContain('This step: call present_options. It is the only tool this step has.');
    expect(tail(held)).toContain('Hand the turn back.');
  });

  it('custom policy can force tool choice', async () => {
    const customPolicy: TurnPolicy = {
      classifyTurn: () => 'forced',
      prepareStep: async ({ steps }) => {
        if (steps.length === 0) {
          return { toolChoice: { type: 'tool', toolName: 'search' } };
        }
        return {};
      },
    };

    // Verify prepareStep returns the forced choice
    const result = await customPolicy.prepareStep({
      steps: [],
      turnClass: 'forced',
      allToolNames: ['search', 'answer'],
    });

    expect(result).toEqual({
      toolChoice: { type: 'tool', toolName: 'search' },
    });
  });

  it('custom policy can filter active tools', async () => {
    const customPolicy: TurnPolicy = {
      classifyTurn: () => 'restricted',
      prepareStep: async ({ allToolNames }) => ({
        activeTools: allToolNames.filter((n) => n !== 'answer'),
      }),
    };

    const result = await customPolicy.prepareStep({
      steps: [],
      turnClass: 'restricted',
      allToolNames: ['search', 'answer', 'navigate'],
    });

    expect(result.activeTools).toEqual(['search', 'navigate']);
    expect(result.activeTools).not.toContain('answer');
  });
});
