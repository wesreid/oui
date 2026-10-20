/**
 * A turn hands back before its time runs out.
 *
 * The clock alone, then whole turns through the real `ai` loop with only the
 * model a stand-in: each model step takes a minute of the turn's clock, as the
 * vector studio's long build did, and the
 * step that would not leave time to answer is held to saying what is done.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import type { TurnPolicy } from '../turn-policy.js';
import { createStepClock, DEFAULT_HAND_BACK_RESERVE_MS, timeHandBackNote } from '../time-hand-back.js';

describe('the step clock', () => {
  it('lets a step run while a step as long as the longest, and the hand-back, still fit', () => {
    const clock = createStepClock({ deadlineAt: 240_000, turnDeadlineMs: 240_000 });
    expect(clock.stepStarting(0)).toEqual({ remainingMs: 240_000, longestStepMs: 0, reserveMs: 30_000, handBack: false });
    expect(clock.stepStarting(50_000)).toMatchObject({ remainingMs: 190_000, longestStepMs: 50_000, handBack: false });
    // A shorter step does not shorten the estimate: the longest so far is what the next may take.
    expect(clock.stepStarting(60_000)).toMatchObject({ remainingMs: 180_000, longestStepMs: 50_000, handBack: false });
    expect(clock.stepStarting(160_000)).toMatchObject({ remainingMs: 80_000, longestStepMs: 100_000, handBack: true });
  });

  it('hands back exactly when the time left is under the longest step and the reserve', () => {
    const fits = createStepClock({ deadlineAt: 240_000, turnDeadlineMs: 240_000 });
    fits.stepStarting(0);
    expect(fits.stepStarting(105_000)).toMatchObject({ remainingMs: 135_000, longestStepMs: 105_000, handBack: false });
    const short = createStepClock({ deadlineAt: 240_000, turnDeadlineMs: 240_000 });
    short.stepStarting(0);
    expect(short.stepStarting(105_001)).toMatchObject({ handBack: true });
  });

  it('keeps the reserve to a quarter of a short deadline, so its first steps still work', () => {
    const clock = createStepClock({ deadlineAt: 20_000, turnDeadlineMs: 20_000 });
    expect(clock.stepStarting(0)).toEqual({ remainingMs: 20_000, longestStepMs: 0, reserveMs: 5_000, handBack: false });
    expect(createStepClock({ deadlineAt: 1, turnDeadlineMs: 600_000, reserveMs: 45_000 }).stepStarting(0).reserveMs).toBe(45_000);
    expect(DEFAULT_HAND_BACK_RESERVE_MS).toBe(30_000);
  });

  it('tells the model to say what is done and how to continue', () => {
    expect(timeHandBackNote(true)).toMatch(/last step.*what is done and what is left.*present_options/s);
    expect(timeHandBackNote(false)).toMatch(/ask you to continue/);
    expect(timeHandBackNote(false)).not.toMatch(/present_options/);
  });
});

// ─── Whole turns ─────────────────────────────────────────────────────────────

type StreamOptions = { prompt: unknown; tools?: Array<{ name: string }>; toolChoice?: unknown };
type Seen = { prompt: string; tools: string[]; toolChoice: unknown };

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const MINUTE = 60_000;

/**
 * A model that takes a minute of the turn's clock for each step. It draws while
 * it is free to; given only present_options, it offers to continue; told to
 * answer in words, it says what it did.
 */
function slowBuilder(clock: { now: number }) {
  const seen: Seen[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: StreamOptions) => {
      clock.now += MINUTE;
      const tools = (options.tools ?? []).map((t) => t.name);
      seen.push({ prompt: JSON.stringify(options.prompt), tools, toolChoice: options.toolChoice });
      const choice = options.toolChoice as { type?: string; toolName?: string } | undefined;
      const handBack = (tools.length === 1 && tools[0] === 'present_options') || choice?.toolName === 'present_options';
      const words = choice?.type === 'none';
      const call = (name: string, input: Record<string, unknown>) => [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `call-${seen.length}`, toolName: name, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
      ];
      const chunks = words
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Three concepts are drawn; the other three are left. Ask me to continue.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ]
        : handBack
          ? call('present_options', {
              context: 'Three of six concepts are drawn.',
              prompt: 'Carry on with the other three?',
              options: [{ label: 'Continue', value: 'Continue building the other three concepts' }],
            })
          : call('draw_concept', { concept: seen.length });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, seen };
}

const drawConcept: RegisteredTool = {
  name: 'draw_concept',
  description: 'Draws one logo concept.',
  // Read-only to the quota: the turn's calls are bounded by time here, not by count.
  inputSchema: { type: 'object', properties: { concept: { type: 'number' } }, sideEffects: false } as RegisteredTool['inputSchema'],
  execute: vi.fn(async () => ({ success: true, data: { drawn: true } })),
};

function turnConfig(model: unknown, tools: RegisteredTool[], overrides: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry(tools),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    systemPrompt: 'You are the assistant.',
    temperature: null,
    maxToolRounds: 25,
    ...overrides,
  };
}

const turnInput: AgentTurnInput = {
  turnId: 'turn-time',
  conversationId: 'conv-1',
  userId: 'user-1',
  accountId: 'acct-1',
  socketRoom: 'agent:turn:turn-time',
  content: 'Build all six concepts',
};

const NOTE = 'almost out of time, so this is its last step';

/** The turn's clock: each model step moves it a minute on. */
function fakeClock() {
  const clock = { now: 1_000_000 };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  return clock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a turn that runs short of time', () => {
  it('ends with a step that says what is done and offers to continue, before the deadline', async () => {
    const clock = fakeClock();
    const { model, seen } = slowBuilder(clock);
    const policy: TurnPolicy = { classifyTurn: () => 'normal', prepareStep: vi.fn(async () => ({})) };
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      turnConfig(model, [drawConcept, ...loadBuiltinTools()], { turnPolicy: policy, forcedToolChoice: false }),
      turnInput,
    );

    // Steps start at 0, 1, 2 and 3 minutes. At 3 minutes, one more one-minute step and the
    // 30 s reserve no longer fit in the minute left: that step is the last.
    expect(seen).toHaveLength(4);
    for (const step of seen.slice(0, 3)) {
      expect(step.tools).toContain('draw_concept');
      expect(step.prompt).not.toContain(NOTE);
    }
    const last = seen[3];
    expect(last.tools).toEqual(['present_options']);
    expect(last.prompt).toContain(NOTE);
    expect(last.prompt).toContain('offer to continue with present_options');
    // The host's policy is not asked about the step time decided.
    expect(policy.prepareStep).toHaveBeenCalledTimes(3);
    expect(drawConcept.execute).toHaveBeenCalledTimes(3);

    expect(result.stopReason).toBe('time_limit');
    expect(result.stopped).toBeUndefined();
    // The turn's record ends with the offer, the person's to answer.
    const offer = result.newMessages.flatMap((m) => m.toolCalls ?? []).at(-1);
    expect(offer?.name).toBe('present_options');
    expect(offer?.arguments).toMatchObject({ options: [{ label: 'Continue' }] });
  });

  it('forces present_options as the tool choice for a model that takes one', async () => {
    const clock = fakeClock();
    const { model, seen } = slowBuilder(clock);
    const { runAgentTurn } = await import('../orchestrator.js');
    // A model that takes a forced choice keeps its tools; the choice holds it to present_options.
    const result = await runAgentTurn(turnConfig(model, [drawConcept, ...loadBuiltinTools()]), turnInput);

    expect(seen).toHaveLength(4);
    expect(seen[3].toolChoice).toEqual({ type: 'tool', toolName: 'present_options' });
    expect(seen[3].prompt).toContain(NOTE);
    expect(result.stopReason).toBe('time_limit');
  });

  it('answers in words when the host gives no present_options', async () => {
    const clock = fakeClock();
    const { model, seen } = slowBuilder(clock);
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(turnConfig(model, [drawConcept]), turnInput);

    expect(seen).toHaveLength(4);
    expect(seen[3].toolChoice).toEqual({ type: 'none' });
    expect(seen[3].prompt).toContain('say they can ask you to continue');
    expect(result.stopReason).toBe('time_limit');
    const said = result.newMessages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ');
    expect(said).toContain('Ask me to continue');
  });

  it('never cuts a turn short that has time for its steps', async () => {
    const clock = fakeClock();
    const { model, seen } = slowBuilder(clock);
    const policy: TurnPolicy = {
      classifyTurn: () => 'normal',
      // The host hands back at its own step limit, two steps in.
      prepareStep: vi.fn(async ({ steps }) =>
        steps.length >= 2 ? { toolChoice: { type: 'tool' as const, toolName: 'present_options' }, note: 'Step limit.' } : {},
      ),
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      turnConfig(model, [drawConcept, ...loadBuiltinTools()], { turnPolicy: policy, turnDeadlineMs: 600_000 }),
      turnInput,
    );

    expect(seen).toHaveLength(3);
    expect(seen.every((s) => !s.prompt.includes(NOTE))).toBe(true);
    expect(seen[2].prompt).toContain('Step limit.');
    expect(result.stopReason).toBe('present_options');
  });
});
