/**
 * What each of the agent's model calls used, as the provider reported it:
 * read where the model is built, so a turn's budget is the turn's own calls
 * (never the judge's), whichever provider runs it, recorded or live. Each
 * call also says how long it took: to its first token (text, reasoning or a
 * tool call's input) and in all, and why it finished.
 */
import { wrapLanguageModel, type LanguageModel as AiLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModel } from '@ouispec/agent-worker';

/** How long a call took, in milliseconds: what a recording keeps, so a replay reports the live call's times. */
export interface EvalCallTiming {
  /** From the request to the first token the model produced (text, reasoning, or a tool call's input); null when it produced none. */
  firstTokenMs: number | null;
  /** From the request to its last part. */
  durationMs: number;
}

/** Why a call finished, as the provider unified it (`stop`, `tool-calls`, `length`, `content-filter`, `error`, `other`). */
export type EvalFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';

/** One model call's tokens and times. */
export interface EvalModelCall extends EvalCallTiming {
  inputTokens: number;
  /** Of the input, neither read from nor written to the prompt cache. */
  noCacheTokens: number;
  /** Of the input, read from the prompt cache. */
  cacheReadTokens: number;
  /** Of the input, written to the prompt cache. */
  cacheWriteTokens: number;
  outputTokens: number;
  finishReason: EvalFinishReason;
}

/** A turn's model calls, and what they add up to. */
export interface EvalTurnUsage {
  calls: EvalModelCall[];
  inputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** The first call's input: what the turn costs before it has done anything. */
  firstCallInputTokens: number;
  /** The largest call's input: what the context window saw. */
  peakCallInputTokens: number;
  /** The share of the input read from the prompt cache; 0 with no input. */
  cachedShare: number;
  /**
   * The time to the turn's first token: the calls before the first that
   * produced one, then that call's time to it; null when none produced one.
   */
  firstTokenMs: number | null;
  /** The time its model calls took, one after another: the turn's time less its tools'. */
  modelMs: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

type Usage =
  | { inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }; outputTokens?: { total?: number } }
  | undefined;
type Finish = { unified?: string } | string | undefined;

const FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']);
const finishOf = (finish: Finish): EvalFinishReason => {
  const unified = typeof finish === 'string' ? finish : finish?.unified;
  return unified && FINISH_REASONS.has(unified) ? (unified as EvalFinishReason) : 'unknown';
};

/** A call's tokens as the provider reported them: the uncached input is its own count, else what the total leaves. */
export function callOf(usage: Usage, finish: Finish, timing: EvalCallTiming): EvalModelCall {
  const inputTokens = count(usage?.inputTokens?.total);
  const cacheReadTokens = count(usage?.inputTokens?.cacheRead);
  const cacheWriteTokens = count(usage?.inputTokens?.cacheWrite);
  const given = usage?.inputTokens?.noCache;
  return {
    inputTokens,
    noCacheTokens: typeof given === 'number' && Number.isFinite(given) ? given : Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage?.outputTokens?.total),
    finishReason: finishOf(finish),
    ...timing,
  };
}

/** The stream parts that are the model's own output: its first one is the call's first token. */
const OUTPUT_PARTS: ReadonlySet<string> = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call']);

/**
 * The model, with `onCall` told of every call it makes, streamed or not, when
 * it ends: its tokens, its times and why it finished. A model named by a
 * string is returned as it is. `now` is the clock (milliseconds).
 */
export function recordingCalls(model: LanguageModel, onCall: (call: EvalModelCall) => void, now: () => number = () => performance.now()): LanguageModel {
  if (typeof model === 'string') return model;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const started = now();
      const result = await doGenerate();
      const durationMs = Math.round(now() - started);
      // One response: its first token is its whole time.
      onCall(callOf(result.usage as Usage, result.finishReason as Finish, { firstTokenMs: durationMs, durationMs }));
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const started = now();
      const result = await doStream();
      let firstTokenMs: number | null = null;
      let reported = false;
      const report = (usage: Usage, finish: Finish) => {
        if (reported) return;
        reported = true;
        onCall(callOf(usage, finish, { firstTokenMs, durationMs: Math.round(now() - started) }));
      };
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (firstTokenMs === null && OUTPUT_PARTS.has(part.type)) firstTokenMs = Math.round(now() - started);
            if (part.type === 'finish') report(part.usage as Usage, part.finishReason as Finish);
            controller.enqueue(part);
          },
          flush() {
            report(undefined, undefined);
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return wrapLanguageModel({ model: model as Exclude<AiLanguageModel, string>, middleware }) as LanguageModel;
}

/** The time to a turn's first token, its calls one after another. */
function firstTokenOf(calls: readonly EvalModelCall[]): number | null {
  let before = 0;
  for (const call of calls) {
    if (call.firstTokenMs !== null) return before + call.firstTokenMs;
    before += call.durationMs;
  }
  return null;
}

/** A turn's calls, summed. */
export function turnUsage(calls: readonly EvalModelCall[]): EvalTurnUsage {
  const sum = (pick: (c: EvalModelCall) => number) => calls.reduce((s, c) => s + pick(c), 0);
  const inputTokens = sum((c) => c.inputTokens);
  const cacheReadTokens = sum((c) => c.cacheReadTokens);
  return {
    calls: [...calls],
    inputTokens,
    noCacheTokens: sum((c) => c.noCacheTokens),
    cacheReadTokens,
    cacheWriteTokens: sum((c) => c.cacheWriteTokens),
    outputTokens: sum((c) => c.outputTokens),
    firstCallInputTokens: calls[0]?.inputTokens ?? 0,
    peakCallInputTokens: calls.reduce((m, c) => Math.max(m, c.inputTokens), 0),
    cachedShare: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    firstTokenMs: firstTokenOf(calls),
    modelMs: sum((c) => c.durationMs),
  };
}
