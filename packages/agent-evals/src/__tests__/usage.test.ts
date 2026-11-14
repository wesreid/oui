/**
 * What a model call reports, read where the model is built: its tokens with
 * the cache split (the uncached input as the provider gives it, else what the
 * total leaves), the time to its first token and in all, and why it
 * finished, for a streamed call and a one-piece one, on a clock the test
 * moves.
 */
import { describe, expect, it } from 'vitest';
import type { LanguageModel } from '@ouispec/agent-worker';
import { callOf, recordingCalls, type EvalModelCall } from '../usage.js';

/** A clock that reads what the test sets. */
const clock = () => {
  let now = 1_000;
  return { now: () => now, at: (ms: number) => (now = 1_000 + ms) };
};

const usage = { inputTokens: { total: 1_200, noCache: 200, cacheRead: 900, cacheWrite: 100 }, outputTokens: { total: 80 } };

/** A provider model whose stream the test feeds a part at a time, at the times it says. */
function fakeModel(time: ReturnType<typeof clock>, parts: Array<[number, Record<string, unknown>]>, generated?: { at: number; finish: string }) {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-1',
    supportedUrls: {},
    doGenerate: async () => {
      time.at(generated!.at);
      return { content: [{ type: 'text', text: 'hi' }], finishReason: { unified: generated!.finish, raw: generated!.finish }, usage, warnings: [] };
    },
    doStream: async () => ({
      // Each part arrives when it is read, at its time.
      stream: new ReadableStream(
        {
          pull(controller) {
            const next = parts.shift();
            if (!next) return controller.close();
            time.at(next[0]);
            controller.enqueue(next[1]);
          },
        },
        { highWaterMark: 0 },
      ),
    }),
  } as unknown as LanguageModel;
}

type Wrapped = { doStream: (options: unknown) => Promise<{ stream: ReadableStream }>; doGenerate: (options: unknown) => Promise<unknown> };
const OPTIONS = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // every part passes through untouched
  }
}

describe('a model call', () => {
  it('is timed to its first token, and in all, when streamed', async () => {
    const time = clock();
    const calls: EvalModelCall[] = [];
    const model = recordingCalls(
      fakeModel(time, [
        [5, { type: 'stream-start', warnings: [] }],
        [40, { type: 'response-metadata', id: 'r' }],
        [350, { type: 'reasoning-delta', id: 'r1', delta: 'thinking' }],
        [600, { type: 'text-delta', id: 't1', delta: 'Hello' }],
        [1_250, { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_use' } }],
      ]),
      (call) => calls.push(call),
      time.now,
    ) as unknown as Wrapped;
    await drain((await model.doStream(OPTIONS)).stream);
    expect(calls).toEqual([
      { inputTokens: 1_200, noCacheTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 100, outputTokens: 80, finishReason: 'tool-calls', firstTokenMs: 350, durationMs: 1_250 },
    ]);
  });

  it('has no first token when it produced none, and is still reported when its stream ends with no finish', async () => {
    const time = clock();
    const calls: EvalModelCall[] = [];
    const model = recordingCalls(fakeModel(time, [[20, { type: 'stream-start', warnings: [] }]]), (call) => calls.push(call), time.now) as unknown as Wrapped;
    await drain((await model.doStream(OPTIONS)).stream);
    expect(calls).toEqual([
      { inputTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, finishReason: 'unknown', firstTokenMs: null, durationMs: 20 },
    ]);
  });

  it('in one piece, has its first token at its end, and says when the provider stopped it for its content', async () => {
    const time = clock();
    const calls: EvalModelCall[] = [];
    const model = recordingCalls(fakeModel(time, [], { at: 900, finish: 'content-filter' }), (call) => calls.push(call), time.now) as unknown as Wrapped;
    await model.doGenerate(OPTIONS);
    expect(calls[0]).toMatchObject({ finishReason: 'content-filter', firstTokenMs: 900, durationMs: 900, noCacheTokens: 200 });
  });

  it('reads the uncached input from the total where the provider gives no count of its own', () => {
    expect(callOf({ inputTokens: { total: 1_000, cacheRead: 700, cacheWrite: 50 }, outputTokens: { total: 9 } }, 'stop', { firstTokenMs: 1, durationMs: 2 })).toEqual({
      inputTokens: 1_000,
      noCacheTokens: 250,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
      outputTokens: 9,
      finishReason: 'stop',
      firstTokenMs: 1,
      durationMs: 2,
    });
    expect(callOf(undefined, 'whatever', { firstTokenMs: null, durationMs: 0 }).finishReason).toBe('unknown');
  });
});
