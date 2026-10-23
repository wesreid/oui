/**
 * The model's thinking, relayed to the turn's room: the relay alone, then a
 * turn through the real `ai` loop with only the model a stand-in.
 *
 * On dev (2026-10-23) a 93-call Vector Studio turn showed nothing but the
 * typing dots until its end: each step thought for up to a minute before it
 * said or called anything, and nothing of that reached the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { createReasoningRelay } from '../reasoning-relay.js';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';

type Emitted = { event: string; data: Record<string, unknown> };

function recorder() {
  const emitted: Emitted[] = [];
  return {
    emitted,
    emit: vi.fn(async (event: string, data: Record<string, unknown>) => {
      emitted.push({ event, data });
    }),
  };
}

describe('createReasoningRelay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a block's start, its summary coalesced into pieces, and its end, in order", async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit, coalesceChars: 10, now: () => 7 });
    relay.onPart({ type: 'start-step' });
    relay.onPart({ type: 'reasoning-start', id: '0' });
    relay.onPart({ type: 'reasoning-delta', id: '0', text: 'Laying out ' });
    relay.onPart({ type: 'reasoning-delta', id: '0', text: 'the badge' });
    relay.onPart({ type: 'reasoning-end', id: '0' });
    await relay.settle();

    expect(emitted).toEqual([
      { event: AGENT_SOCKET_EVENTS.REASONING_STARTED, data: { turnId: 't1', reasoningId: 't1:1:0', timestamp: 7 } },
      { event: AGENT_SOCKET_EVENTS.REASONING_DELTA, data: { turnId: 't1', reasoningId: 't1:1:0', text: 'Laying out ', timestamp: 7 } },
      { event: AGENT_SOCKET_EVENTS.REASONING_DELTA, data: { turnId: 't1', reasoningId: 't1:1:0', text: 'the badge', timestamp: 7 } },
      { event: AGENT_SOCKET_EVENTS.REASONING_ENDED, data: { turnId: 't1', reasoningId: 't1:1:0', timestamp: 7 } },
    ]);
  });

  it('sends a short piece once it has waited the coalescing time', async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit, coalesceMs: 50, coalesceChars: 100 });
    relay.onPart({ type: 'reasoning-start', id: 'r' });
    relay.onPart({ type: 'reasoning-delta', id: 'r', text: 'Checking' });
    await vi.advanceTimersByTimeAsync(49);
    expect(emitted.map((e) => e.event)).toEqual([AGENT_SOCKET_EVENTS.REASONING_STARTED]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted.map((e) => e.event)).toEqual([AGENT_SOCKET_EVENTS.REASONING_STARTED, AGENT_SOCKET_EVENTS.REASONING_DELTA]);
    await relay.settle();
  });

  it('tells apart blocks a provider numbers the same in two steps', async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit });
    for (let i = 0; i < 2; i++) {
      relay.onPart({ type: 'start-step' });
      relay.onPart({ type: 'reasoning-start', id: '0' });
      relay.onPart({ type: 'reasoning-end', id: '0' });
    }
    await relay.settle();
    const started = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.REASONING_STARTED).map((e) => e.data.reasoningId);
    expect(started).toEqual(['t1:1:0', 't1:2:0']);
  });

  it('sends no piece for a block without a summary: the model returned none', async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit });
    relay.onPart({ type: 'reasoning-start', id: 'r' });
    relay.onPart({ type: 'reasoning-delta', id: 'r', text: '' });
    relay.onPart({ type: 'reasoning-end', id: 'r' });
    await relay.settle();
    expect(emitted.map((e) => e.event)).toEqual([AGENT_SOCKET_EVENTS.REASONING_STARTED, AGENT_SOCKET_EVENTS.REASONING_ENDED]);
  });

  it('ends a block a stopped or failed stream left open, after what it had buffered', async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit, coalesceChars: 100 });
    relay.onPart({ type: 'reasoning-start', id: 'r' });
    relay.onPart({ type: 'reasoning-delta', id: 'r', text: 'Half a thought' });
    await relay.settle();
    expect(emitted.map((e) => [e.event, e.data.text])).toEqual([
      [AGENT_SOCKET_EVENTS.REASONING_STARTED, undefined],
      [AGENT_SOCKET_EVENTS.REASONING_DELTA, 'Half a thought'],
      [AGENT_SOCKET_EVENTS.REASONING_ENDED, undefined],
    ]);
  });

  it('never throws when an emit fails, and the rest still go out', async () => {
    const emitted: string[] = [];
    const emit = vi.fn(async (event: string) => {
      if (event === AGENT_SOCKET_EVENTS.REASONING_STARTED) throw new Error('realtime down');
      emitted.push(event);
    });
    const relay = createReasoningRelay({ turnId: 't1', emit });
    relay.onPart({ type: 'reasoning-start', id: 'r' });
    relay.onPart({ type: 'reasoning-end', id: 'r' });
    await expect(relay.settle()).resolves.toBeUndefined();
    expect(emitted).toEqual([AGENT_SOCKET_EVENTS.REASONING_ENDED]);
  });

  it('ignores every other part of the stream', async () => {
    const { emitted, emit } = recorder();
    const relay = createReasoningRelay({ turnId: 't1', emit });
    relay.onPart({ type: 'text-delta' });
    relay.onPart({ type: 'tool-call' });
    relay.onPart({ type: 'reasoning-delta', id: 'never-started', text: 'x' });
    await relay.settle();
    expect(emitted).toEqual([]);
  });
});

// ─── Through the real `ai` loop ──────────────────────────────────────────────

const usage = (output: number) => ({
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: 0, reasoning: output },
});

const SUMMARY = 'Planning the badge: a ring, three stars, then the rocket.';

/** Step 1 thinks (with a summary) and calls a tool; step 2 thinks (without one) and answers. */
function model() {
  const calls: Array<{ providerOptions: unknown }> = [];
  const steps = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-delta', id: '0', delta: SUMMARY.slice(0, 20) },
      { type: 'reasoning-delta', id: '0', delta: SUMMARY.slice(20) },
      { type: 'reasoning-end', id: '0' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'add_shapes', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(400) },
    ],
    [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-end', id: '0' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'The badge is on the artboard.' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: usage(60) },
    ],
  ];
  const mock = new MockLanguageModelV4({
    doStream: async (options: { providerOptions?: unknown }) => {
      calls.push({ providerOptions: options.providerOptions });
      const chunks = steps[calls.length - 1];
      if (!chunks) throw new Error(`The model was called ${calls.length} times; the script has ${steps.length} steps`);
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { mock, calls };
}

const addShapes: RegisteredTool = {
  name: 'add_shapes',
  description: 'Add shapes',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, data: { added: 3 } })),
};

async function turn(stub: unknown, extra: Partial<AgentWorkerConfig> = {}) {
  const emitted: Emitted[] = [];
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([addShapes]),
    emit: {
      emit: vi.fn(async (_room: string, event: string, data: unknown) => {
        emitted.push({ event, data: data as Record<string, unknown> });
      }),
    },
    model: stub as AgentWorkerConfig['model'],
    systemPrompt: 'You are the assistant.',
    ...extra,
  };
  const input: AgentTurnInput = {
    turnId: 'turn-reasoning',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-reasoning',
    content: 'Build the badge',
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  const result = await runAgentTurn(config, input);
  return { result, emitted };
}

describe("a turn's thinking, through the real ai loop", () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reaches the room before what each step then does, with its summary, and ends before the turn does', async () => {
    const { mock } = model();
    const { emitted } = await turn(mock);
    const names = emitted.map((e) => e.event);

    const firstStart = names.indexOf(AGENT_SOCKET_EVENTS.REASONING_STARTED);
    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeLessThan(names.indexOf(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED));

    const summary = emitted
      .filter((e) => e.event === AGENT_SOCKET_EVENTS.REASONING_DELTA)
      .map((e) => e.data.text)
      .join('');
    expect(summary).toBe(SUMMARY);

    const ids = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.REASONING_STARTED).map((e) => e.data.reasoningId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const ended = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.REASONING_ENDED).map((e) => e.data.reasoningId);
    expect(ended).toEqual(ids);

    expect(names.at(-1)).toBe(AGENT_SOCKET_EVENTS.TURN_COMPLETE);
    expect(names.lastIndexOf(AGENT_SOCKET_EVENTS.REASONING_ENDED)).toBeLessThan(names.length - 1);
  });

  it('says how the turn ended', async () => {
    const { mock } = model();
    const { emitted } = await turn(mock);
    expect(emitted.at(-1)?.data.endReason).toBe('complete');
  });

  it('stores none of the summary with the conversation', async () => {
    const { mock } = model();
    const { result } = await turn(mock);
    expect(JSON.stringify(result.newMessages)).not.toContain('Planning the badge');
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: 'The badge is on the artboard.' });
  });

  it("sends the host's provider options with every model call, and none when the host gives none", async () => {
    const options = { amazonBedrock: { additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } } } };
    const withOptions = model();
    await turn(withOptions.mock, { modelProviderOptions: options });
    expect(withOptions.calls.map((c) => c.providerOptions)).toEqual([options, options]);

    const without = model();
    await turn(without.mock);
    for (const call of without.calls) expect(call.providerOptions ?? {}).toEqual({});
  });
});
