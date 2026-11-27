import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

import { startCallClock, stepClockFields, turnTiming, type CallClock } from '../call-clock.js';
import { createToolRegistry } from '../tools/types.js';
import { runAgentTurn } from '../orchestrator.js';

describe('the call clock', () => {
  it('times the first token of any kind, the end at `finish`, and the gap since the call before', () => {
    let t = 1_000;
    const now = () => t;
    const clocks: CallClock[] = [];
    t = 1_200;
    const first = startCallClock(clocks, 1_000, now);
    t = 1_250;
    first.saw('stream-start');
    t = 1_900;
    first.saw('reasoning-delta');
    t = 2_400;
    first.saw('finish');
    t = 2_500;
    first.ended();
    t = 3_100;
    const second = startCallClock(clocks, 1_000, now);
    t = 3_300;
    second.saw('tool-input-start');
    t = 3_800;
    second.ended();

    expect(clocks[0]).toEqual({ startedAt: 1_200, firstTokenMs: 700, durationMs: 1_200, sinceLastMs: 200 });
    expect(clocks[1]).toEqual({ startedAt: 3_100, firstTokenMs: 200, durationMs: 700, sinceLastMs: 700 });
    expect(stepClockFields(clocks[1])).toEqual({ firstTokenMs: 200, durationMs: 700, sinceLastCallMs: 700 });
    expect(stepClockFields(undefined)).toEqual({ firstTokenMs: null, durationMs: null, sinceLastCallMs: null });
    expect(turnTiming(clocks, 1_000, 2_950)).toEqual({ firstTokenMs: 900, firstTextMs: 2_950, modelMs: 1_900, betweenCallsMs: 700, callMs: [1_200, 700] });
  });

  it('gives no first token to a call that produced none', () => {
    const clocks: CallClock[] = [];
    const clock = startCallClock(clocks, 0, () => 5);
    clock.saw('stream-start');
    clock.ended();
    expect(clocks[0].firstTokenMs).toBeNull();
    expect(turnTiming(clocks, 0, null).firstTokenMs).toBeNull();
  });
});

describe('a turn’s logs carry each call’s clock', () => {
  const finish = (reason: 'stop' | 'tool-calls') => ({
    type: 'finish',
    finishReason: { unified: reason, raw: reason === 'stop' ? 'end_turn' : 'tool_use' },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
  });
  let call = 0;
  const model = () =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 5,
          chunks: (call++ === 0
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'c1', toolName: 'look_up', input: '{}' },
                finish('tool-calls'),
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Found it.' },
                { type: 'text-end', id: '0' },
                finish('stop'),
              ]) as never[],
        }),
      }),
    } as never);

  it('on every step, and summed on the turn', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAgentTurn(
      {
        tools: createToolRegistry([
          {
            name: 'look_up',
            description: 'Looks a thing up.',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { success: true, data: { found: true } };
            },
          } as never,
        ]),
        emit: { emit: vi.fn(async () => {}) },
        model: model() as never,
        systemPrompt: 'You are the assistant.',
      },
      {
        turnId: 'turn-clock',
        conversationId: 'conv',
        userId: 'user',
        accountId: 'account',
        socketRoom: 'agent:turn:clock',
        content: 'Look it up.',
        history: [{ role: 'user', content: 'Look it up.' }],
      },
    );
    const lines = logged.mock.calls.map(([text]) => String(text));
    logged.mockRestore();
    const read = (text: string) => {
      const { data, ...entry } = JSON.parse(text) as { data?: Record<string, unknown> } & Record<string, unknown>;
      return (data ?? entry) as Record<string, unknown>;
    };
    const steps = lines.filter((text) => text.includes('Step completed')).map(read);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.firstTokenMs).toEqual(expect.any(Number));
      expect(step.durationMs as number).toBeGreaterThanOrEqual(step.firstTokenMs as number);
    }
    // The tool ran between the two calls.
    expect(steps[1].sinceLastCallMs as number).toBeGreaterThanOrEqual(15);
    const usage = read(lines.find((text) => text.includes('Turn usage'))!);
    const timing = usage.timing as Record<string, unknown>;
    expect(timing.callMs).toHaveLength(2);
    expect(timing.modelMs).toBe((timing.callMs as number[])[0] + (timing.callMs as number[])[1]);
    expect(timing.betweenCallsMs as number).toBeGreaterThanOrEqual(15);
    expect(timing.firstTextMs as number).toBeGreaterThan(timing.firstTokenMs as number);
    expect(timing.turnMs as number).toBeGreaterThanOrEqual((timing.modelMs as number) + (timing.betweenCallsMs as number));
  });
});
