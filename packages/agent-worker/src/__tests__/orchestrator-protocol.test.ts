/**
 * Orchestrator Emit Protocol Tests (W7.T1)
 *
 * Verifies the correct sequence and format of events emitted during an agent turn:
 *   1. Exact event sequence for a one-tool turn
 *   2. TURN_ERROR emission on failure (not string literal)
 *   3. TOKEN_CLEAR emission in tour mode for present_options
 *   4. No string literal event names in emit calls — all use AGENT_SOCKET_EVENTS constants
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

function createMockStreamResult(
  steps: MockStep[],
  _opts?: { onStepEnd?: (step: { text: string; toolCalls: unknown[] }) => Promise<void> },
): Record<string, unknown> {
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
      })),
    }),
  };
}

function makeEmit(): { emit: ReturnType<typeof vi.fn>; calls: () => Array<{ room: string; event: string; data: unknown }> } {
  const captured: Array<{ room: string; event: string; data: unknown }> = [];
  const emit = vi.fn(async (room: string, event: string, data: unknown) => {
    captured.push({ room, event, data });
  });
  return { emit, calls: () => captured };
}

function makeBaseInput(overrides?: Partial<AgentTurnInput>): AgentTurnInput {
  return {
    turnId: 'turn-proto-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'room-1',
    content: 'Hello agent',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Orchestrator Emit Protocol (W7.T1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Event sequence for a one-tool turn ──────────────────────────────────

  it('emits the correct sequence for a simple one-tool turn: TOOL_CALL_STARTED → TOOL_CALL_COMPLETE → TOKEN → TURN_COMPLETE', async () => {
    const testTool: RegisteredTool = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      execute: vi.fn(async () => ({ success: true, data: { answer: 42 } })),
    };

    mockStreamTextImpl = (opts) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;
      const wrappedTool = tools['test_tool'];

      // Execute the tool synchronously during stream construction
      const toolResultPromise = wrappedTool.execute({ q: 'test' }, { toolCallId: 'tc_1' });

      return {
        textStream: (async function* () {
          await toolResultPromise;
          yield 'The answer is 42.';
        })(),
        steps: toolResultPromise.then(() => [
          {
            text: 'The answer is 42.',
            toolCalls: [{ toolName: 'test_tool', toolCallId: 'tc_1', args: { q: 'test' } }],
            toolResults: [],
          },
        ]),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        response: Promise.resolve({ messages: [] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([testTool]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    };

    await runAgentTurn(config, makeBaseInput());

    const events = calls().map((c) => c.event);

    // The sequence must contain these events in order
    const toolStartIdx = events.indexOf('agent:tool_call_started');
    const toolCompleteIdx = events.indexOf('agent:tool_call_complete');
    const tokenIdx = events.indexOf('agent:token');
    const turnCompleteIdx = events.indexOf('agent:turn_complete');

    expect(toolStartIdx).toBeGreaterThanOrEqual(0);
    expect(toolCompleteIdx).toBeGreaterThan(toolStartIdx);
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIdx).toBeGreaterThan(toolCompleteIdx);

    // TURN_COMPLETE is always the last event
    expect(events[events.length - 1]).toBe('agent:turn_complete');
  });

  // ── 2. TURN_COMPLETE event contains usage data ─────────────────────────────

  it('TURN_COMPLETE event includes usage data', async () => {
    mockStreamTextImpl = () => createMockStreamResult([
      { text: 'Simple response', toolCalls: [], toolResults: [] },
    ]);

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    };

    await runAgentTurn(config, makeBaseInput());

    const turnCompleteCall = calls().find((c) => c.event === 'agent:turn_complete');
    expect(turnCompleteCall).toBeDefined();

    const data = turnCompleteCall!.data as Record<string, unknown>;
    expect(data.turnId).toBe('turn-proto-1');
    expect(data.usage).toBeDefined();
    expect((data.usage as Record<string, unknown>).promptTokens).toBe(100);
    expect((data.usage as Record<string, unknown>).completionTokens).toBe(50);
  });

  // ── 3. TOKEN events carry text and turnId ──────────────────────────────────

  it('TOKEN events carry the coalesced text and turnId', async () => {
    mockStreamTextImpl = () => createMockStreamResult([
      { text: 'Hello world from the agent', toolCalls: [], toolResults: [] },
    ]);

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    };

    await runAgentTurn(config, makeBaseInput());

    const tokenCalls = calls().filter((c) => c.event === 'agent:token');
    expect(tokenCalls.length).toBeGreaterThanOrEqual(1);

    // Coalesced text should contain the full output
    const allText = tokenCalls.map((c) => (c.data as Record<string, unknown>).text).join('');
    expect(allText).toBe('Hello world from the agent');

    // Each token event has turnId
    for (const tc of tokenCalls) {
      expect((tc.data as Record<string, unknown>).turnId).toBe('turn-proto-1');
    }
  });

  // ── 4. TOKEN_CLEAR in tour mode ────────────────────────────────────────────

  it('does NOT emit TOKEN_CLEAR without a custom turn policy (Closure tour behavior removed)', async () => {
    const presentOptionsTool: RegisteredTool = {
      name: 'present_options',
      description: 'Present tour options',
      inputSchema: { type: 'object', properties: { options: { type: 'array' }, prompt: { type: 'string' } }, sideEffects: false } as Record<string, unknown>,
      execute: vi.fn(async () => ({ success: true, data: { __present_options: true } })),
    };

    const navigateTool: RegisteredTool = {
      name: 'navigate',
      description: 'Navigate to a page',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, sideEffects: false } as Record<string, unknown>,
      execute: vi.fn(async () => ({ success: true, data: { navigated: true } })),
    };

    mockStreamTextImpl = (opts) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;

      // Simulate: navigate → present_options
      const runSequence = async () => {
        if (tools['navigate']) {
          await tools['navigate'].execute({ path: '/characters' }, { toolCallId: 'tc_nav' });
        }
        if (tools['present_options']) {
          await tools['present_options'].execute({ options: [], prompt: 'Tour info' }, { toolCallId: 'tc_po' });
        }
      };

      const p = runSequence();

      const onStepEnd = opts.onStepEnd as ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
      const triggerStepEnd = async () => {
        await p;
        if (onStepEnd) {
          await onStepEnd({
            text: 'Tour description',
            toolCalls: [{ toolName: 'present_options', toolCallId: 'tc_po' }],
          });
        }
      };

      const stepEndPromise = triggerStepEnd();

      return {
        textStream: (async function* () {
          await stepEndPromise;
          yield 'Tour description';
        })(),
        steps: stepEndPromise.then(() => [
          {
            text: 'Navigating...',
            toolCalls: [{ toolName: 'navigate', toolCallId: 'tc_nav', args: { path: '/characters' } }],
            toolResults: [],
          },
          {
            text: 'Tour description',
            toolCalls: [{ toolName: 'present_options', toolCallId: 'tc_po', args: {} }],
            toolResults: [],
          },
        ]),
        usage: Promise.resolve({ inputTokens: 200, outputTokens: 100 }),
        response: Promise.resolve({ messages: [] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([navigateTool, presentOptionsTool]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a tour guide.',
    };

    // Without a custom turn policy, TOKEN_CLEAR is NOT emitted
    // (it was Closure tour-specific behavior, now in studio-api's turn policy)
    await runAgentTurn(config, makeBaseInput({ content: 'Next → Characters' }));

    const events = calls().map((c) => c.event);
    expect(events).not.toContain('agent:token_clear');
  });

  // ── 5. No string literal event names ───────────────────────────────────────

  it('orchestrator source uses AGENT_SOCKET_EVENTS constants, not string literals for emit calls', () => {
    const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.ts');
    const source = fs.readFileSync(orchestratorPath, 'utf-8');

    // Find all emit calls — pattern: emit(room, <event>, data)
    // These should use AGENT_SOCKET_EVENTS.X not 'agent:...' string literals
    const emitCallPattern = /config\.emit\.emit\(\s*socketRoom\s*,\s*(['"`])agent:/g;
    const matches = source.match(emitCallPattern) ?? [];

    // The only string literal emit is 'oui:dispatch' — which is NOT in AGENT_SOCKET_EVENTS
    // and is intentionally a literal. All 'agent:...' events must use the constant.
    const agentLiteralEmits = matches.filter((m) => !m.includes('oui:'));
    expect(agentLiteralEmits).toEqual([]);

    // Verify AGENT_SOCKET_EVENTS is used for the standard emit events
    expect(source).toContain('AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED');
    expect(source).toContain('AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE');
    expect(source).toContain('AGENT_SOCKET_EVENTS.TOKEN');
    expect(source).toContain('AGENT_SOCKET_EVENTS.TURN_COMPLETE');
    // TOKEN_CLEAR is no longer emitted directly by the orchestrator —
    // it was Closure-specific tour behavior, now handled by the integrator's TurnPolicy.
  });

  // ── 6. No dispatch marker path ────────────────────────────────────────────
  // UI actions are dispatched by UI tools and answered by the client
  // (ADR-0209). A host tool whose result merely LOOKS like the old
  // `__oui_dispatch` marker must not be turned into a UI dispatch.

  it('never emits oui:dispatch for a host tool result, whatever it contains', async () => {
    const legacy: RegisteredTool = {
      name: 'legacy_tool',
      description: 'returns the retired marker',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({
        success: true,
        data: { __oui_dispatch: true, surfaceId: 'app-shell', actionId: 'navigate', params: { path: '/voices' } },
      })),
    };

    mockStreamTextImpl = (opts) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;
      const p = tools['legacy_tool'].execute({}, { toolCallId: 'tc_legacy' });
      return {
        textStream: (async function* () {
          await p;
          yield 'ok';
        })(),
        steps: p.then(() => [{ text: 'ok', toolCalls: [{ toolName: 'legacy_tool', toolCallId: 'tc_legacy', args: {} }], toolResults: [] }]),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        response: Promise.resolve({ messages: [] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');
    const { emit: emitFn, calls } = makeEmit();
    await runAgentTurn(
      { tools: createToolRegistry([legacy]), emit: { emit: emitFn }, model: 'test-model', systemPrompt: 'You are a test agent.' },
      makeBaseInput(),
    );

    expect(calls().filter((c) => c.event === 'oui:dispatch')).toHaveLength(0);
  });

  // ── 7. TOOL_CALL_STARTED includes correct metadata ────────────────────────

  it('TOOL_CALL_STARTED includes turnId, name, and input', async () => {
    const testTool: RegisteredTool = {
      name: 'search_entities',
      description: 'Search entities',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      execute: vi.fn(async () => ({ success: true, data: { results: [] } })),
    };

    mockStreamTextImpl = (opts) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;
      const wrappedTool = tools['search_entities'];
      const p = wrappedTool.execute({ query: 'voices' }, { toolCallId: 'tc_search' });

      return {
        textStream: (async function* () {
          await p;
          yield 'Found results';
        })(),
        steps: p.then(() => [
          { text: 'Found results', toolCalls: [{ toolName: 'search_entities', toolCallId: 'tc_search', args: { query: 'voices' } }], toolResults: [] },
        ]),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        response: Promise.resolve({ messages: [] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([testTool]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    };

    await runAgentTurn(config, makeBaseInput());

    const startedCalls = calls().filter((c) => c.event === 'agent:tool_call_started');
    expect(startedCalls.length).toBeGreaterThanOrEqual(1);

    const data = startedCalls[0].data as Record<string, unknown>;
    expect(data.turnId).toBe('turn-proto-1');
    expect(data.name).toBe('search_entities');
    expect(data.input).toEqual({ query: 'voices' });
  });

  // ── 8. TOOL_CALL_COMPLETE includes success and durationMs ──────────────────

  it('TOOL_CALL_COMPLETE includes success flag and durationMs', async () => {
    const testTool: RegisteredTool = {
      name: 'quick_tool',
      description: 'Quick tool',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({ success: true, data: { done: true } })),
    };

    mockStreamTextImpl = (opts) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown, o: unknown) => Promise<string> }>;
      const wrappedTool = tools['quick_tool'];
      const p = wrappedTool.execute({}, { toolCallId: 'tc_quick' });

      return {
        textStream: (async function* () {
          await p;
          yield 'Done';
        })(),
        steps: p.then(() => [
          { text: 'Done', toolCalls: [{ toolName: 'quick_tool', toolCallId: 'tc_quick', args: {} }], toolResults: [] },
        ]),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
        response: Promise.resolve({ messages: [] }),
      };
    };

    const { runAgentTurn } = await import('../orchestrator.js');

    const { emit: emitFn, calls } = makeEmit();
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([testTool]),
      emit: { emit: emitFn },
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    };

    await runAgentTurn(config, makeBaseInput());

    const completeCalls = calls().filter((c) => c.event === 'agent:tool_call_complete');
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);

    const data = completeCalls[0].data as Record<string, unknown>;
    expect(data.success).toBe(true);
    expect(typeof data.durationMs).toBe('number');
    expect(data.durationMs as number).toBeGreaterThanOrEqual(0);
  });
});
