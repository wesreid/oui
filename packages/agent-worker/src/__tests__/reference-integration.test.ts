/**
 * Reference Integration Test (W8.T3)
 *
 * Proves the SDK boundary holds: an agent can run with custom tools,
 * a custom persona, and the default turn policy — with ZERO Closure dependencies.
 *
 * Also asserts that no Closure-specific strings remain in SDK source files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';
import { defaultTurnPolicy } from '../turn-policy.js';

// ─── Mock the AI module ──────────────────────────────────────────────────────

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

// ─── Custom tools (zero Closure dependency) ──────────────────────────────────

const getWeather: RegisteredTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'The city name' },
    },
  },
  execute: vi.fn(async (input: Record<string, unknown>) => ({
    success: true,
    data: { temperature: 72, city: input.city, unit: 'F' },
  })),
};

const setReminder: RegisteredTool = {
  name: 'set_reminder',
  description: 'Set a reminder for a specific time',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Reminder text' },
      time: { type: 'string', description: 'ISO 8601 time' },
    },
  },
  execute: vi.fn(async (input: Record<string, unknown>) => ({
    success: true,
    data: { reminderId: 'rem_123', message: input.message, time: input.time },
  })),
};

const searchNotes: RegisteredTool = {
  name: 'search_notes',
  description: 'Search through the user notes',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
  },
  execute: vi.fn(async (_input: Record<string, unknown>) => ({
    success: true,
    data: { results: [{ id: 'n1', title: 'Meeting notes', snippet: 'Discussed Q4 plans' }] },
  })),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Reference Integration (W8.T3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should run a turn with custom tools and default policy, no Closure dependencies', async () => {
    // Mock streamText to simulate a tool call + text response
    mockStreamTextImpl = (opts: Record<string, unknown>) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;
      const onStepEnd = opts.onStepEnd as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;

      const executeTools = async () => {
        // Simulate model calling get_weather
        if (tools.get_weather) {
          await tools.get_weather.execute({ city: 'San Francisco' }, { toolCallId: 'tc_1' });
        }
        if (onStepEnd) {
          await onStepEnd({
            text: '',
            toolCalls: [{ toolName: 'get_weather', toolCallId: 'tc_1', args: { city: 'San Francisco' } }],
          });
        }
      };

      const p = executeTools();

      return {
        textStream: (async function* () {
          await p;
          yield 'The weather in San Francisco is 72°F.';
        })(),
        steps: p.then(() => [{
          text: '',
          toolCalls: [{ toolName: 'get_weather', toolCallId: 'tc_1', args: { city: 'San Francisco' } }],
          toolResults: [],
        }]),
        usage: Promise.resolve({ inputTokens: 150, outputTokens: 80 }),
        response: Promise.resolve({
          messages: [{ role: 'assistant', content: 'The weather in San Francisco is 72°F.' }],
        }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const emitCalls: Array<{ event: string; data: unknown }> = [];
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([getWeather, setReminder, searchNotes]),
      emit: {
        emit: vi.fn(async (_room: string, event: string, data: unknown) => {
          emitCalls.push({ event, data });
        }),
      },
      model: 'test-model',
      systemPrompt: 'You are a helpful personal assistant. You can check weather, set reminders, and search notes.',
      turnPolicy: defaultTurnPolicy,
    };

    const input: AgentTurnInput = {
      turnId: 'turn-ref-1',
      conversationId: 'conv-ref-1',
      userId: 'user-ref',
      accountId: 'account-ref',
      socketRoom: 'room-ref',
      content: 'What is the weather in San Francisco?',
    };

    const result = await runAgentTurn(config, input);

    // Tool was called
    expect(getWeather.execute).toHaveBeenCalledWith(
      { city: 'San Francisco' },
      expect.objectContaining({ userId: 'user-ref' }),
    );

    // Turn completed
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.newMessages.length).toBeGreaterThan(0);

    // TURN_COMPLETE event emitted
    const turnCompleteEvents = emitCalls.filter((c) => c.event === 'agent:turn_complete');
    expect(turnCompleteEvents.length).toBe(1);

    // Tool start/complete events emitted
    const toolStarted = emitCalls.filter((c) => c.event === 'agent:tool_call_started');
    expect(toolStarted.length).toBe(1);
    expect((toolStarted[0].data as Record<string, unknown>).name).toBe('get_weather');
  });

  it('default turn policy classifies everything as normal', () => {
    expect(defaultTurnPolicy.classifyTurn('anything')).toBe('normal');
    expect(defaultTurnPolicy.classifyTurn('Give me a guided tour')).toBe('normal');
    expect(defaultTurnPolicy.classifyTurn('Next → Characters')).toBe('normal');
  });

  it('default turn policy applies no step constraints', async () => {
    const result = await defaultTurnPolicy.prepareStep({
      steps: [],
      turnClass: 'normal',
      allToolNames: ['get_weather', 'set_reminder'],
    });
    expect(result).toEqual({});

    const result2 = await defaultTurnPolicy.prepareStep({
      steps: [{ toolCalls: [{ toolName: 'get_weather' }] }],
      turnClass: 'normal',
      allToolNames: ['get_weather', 'set_reminder'],
    });
    expect(result2).toEqual({});
  });
});

describe('SDK source Closure-free assertion (W8.T3)', () => {
  it('SDK source should contain no Closure-specific strings', () => {
    const srcDir = path.resolve(__dirname, '..');
    const files = getAllTsFiles(srcDir);

    const closureStrings = [
      '/characters', '/voices', '/dataviz', '/productions',
      '/clips', '/images', '/audio', '/distribution', 'closure-studio',
      'Next →', 'guided tour', 'show me around',
    ];

    for (const file of files) {
      // Test fixtures are allowed to reference these strings
      if (file.includes('__tests__')) continue;
      const content = fs.readFileSync(file, 'utf-8');
      for (const str of closureStrings) {
        expect(content, `${path.relative(srcDir, file)} contains Closure-specific string "${str}"`).not.toContain(str);
      }
    }
  });
});
