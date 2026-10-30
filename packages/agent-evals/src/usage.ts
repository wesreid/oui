/**
 * What each of the agent's model calls used, as the provider reported it:
 * read where the model is built, so a turn's budget is the turn's own calls
 * (never the judge's), whichever provider runs it, recorded or live.
 */
import { wrapLanguageModel, type LanguageModel as AiLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModel } from '@ouispec/agent-worker';

/** One model call's tokens. */
export interface EvalModelCall {
  inputTokens: number;
  /** Of the input, read from the prompt cache. */
  cacheReadTokens: number;
  /** Of the input, written to the prompt cache. */
  cacheWriteTokens: number;
  outputTokens: number;
}

/** A turn's model calls, and what they add up to. */
export interface EvalTurnUsage {
  calls: EvalModelCall[];
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** The first call's input: what the turn costs before it has done anything. */
  firstCallInputTokens: number;
  /** The largest call's input: what the context window saw. */
  peakCallInputTokens: number;
  /** The share of the input read from the prompt cache; 0 with no input. */
  cachedShare: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

type Usage = { inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number }; outputTokens?: { total?: number } } | undefined;

const callOf = (usage: Usage): EvalModelCall => ({
  inputTokens: count(usage?.inputTokens?.total),
  cacheReadTokens: count(usage?.inputTokens?.cacheRead),
  cacheWriteTokens: count(usage?.inputTokens?.cacheWrite),
  outputTokens: count(usage?.outputTokens?.total),
});

/** The model, with `onCall` told of every call it makes, streamed or not, when it ends. A model named by a string is returned as it is. */
export function recordingCalls(model: LanguageModel, onCall: (call: EvalModelCall) => void): LanguageModel {
  if (typeof model === 'string') return model;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      onCall(callOf(result.usage as Usage));
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let reported = false;
      const report = (usage: Usage) => {
        if (reported) return;
        reported = true;
        onCall(callOf(usage));
      };
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') report(part.usage as Usage);
            controller.enqueue(part);
          },
          flush() {
            report(undefined);
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return wrapLanguageModel({ model: model as Exclude<AiLanguageModel, string>, middleware }) as LanguageModel;
}

/** A turn's calls, summed. */
export function turnUsage(calls: readonly EvalModelCall[]): EvalTurnUsage {
  const sum = (pick: (c: EvalModelCall) => number) => calls.reduce((s, c) => s + pick(c), 0);
  const inputTokens = sum((c) => c.inputTokens);
  const cacheReadTokens = sum((c) => c.cacheReadTokens);
  return {
    calls: [...calls],
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: sum((c) => c.cacheWriteTokens),
    outputTokens: sum((c) => c.outputTokens),
    firstCallInputTokens: calls[0]?.inputTokens ?? 0,
    peakCallInputTokens: calls.reduce((m, c) => Math.max(m, c.inputTokens), 0),
    cachedShare: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
  };
}
