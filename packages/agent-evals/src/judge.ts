/**
 * A rubric's verdict: a judge model reads the customer's
 * message, the agent's reply and the rubric, and answers whether the reply
 * does what the rubric says. Its call goes through the same fetch as the
 * agent's, so in CI it is replayed from the scenario's recording like every
 * other model response.
 *
 * The verdict is asked for as structured output (`Output.object`): the
 * provider package chooses how its model gives an object (a JSON schema, a
 * forced tool, or instructions for a model that refuses a forced tool). An
 * answer that is still not a verdict is read as text, then asked for again;
 * a judge that never gives one is a judge failure, reported apart from the
 * case's assertions: the reply was not found wanting, it was not judged.
 */
import { generateText, jsonSchema, NoObjectGeneratedError, Output } from 'ai';
import type { LanguageModel } from '@ouispec/agent-worker';

export interface Verdict {
  pass: boolean;
  reason: string;
}

/** A judge that gave no verdict, with what it answered each time it was asked. */
export interface JudgeFailure {
  error: string;
  attempts: number;
}

export const JUDGE_INSTRUCTIONS =
  'You grade one reply of a customer-facing AI agent against one rubric. ' +
  'Answer with only a JSON object and nothing else: {"pass": true or false, "reason": "one sentence"}. ' +
  '"pass" is true only when the reply clearly does what the rubric describes.';

/** What the judge is asked for: a verdict and one sentence why. */
export const VERDICT_SCHEMA: Parameters<typeof jsonSchema>[0] & object = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'True only when the reply clearly does what the rubric describes.' },
    reason: { type: 'string', description: 'Why, in one sentence.' },
  },
  required: ['pass', 'reason'],
  additionalProperties: false,
};

export interface JudgeOptions {
  /** How many times a judge that gave no verdict is asked again. Default 2. */
  retries?: number;
  /** The most the judge may write, thinking included. Default 1024. */
  maxOutputTokens?: number;
}

/** The JSON object in a judge's answer, or why there is none. */
export function readVerdict(text: string): Verdict | { error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return { error: `the judge answered no JSON: ${JSON.stringify(text.slice(0, 200))}` };
  try {
    return asVerdict(JSON.parse(text.slice(start, end + 1)), text.slice(start, end + 1));
  } catch {
    return { error: `the judge's answer is not JSON: ${JSON.stringify(text.slice(start, end + 1).slice(0, 200))}` };
  }
}

function asVerdict(value: unknown, as: string): Verdict | { error: string } {
  const verdict = (value ?? {}) as { pass?: unknown; reason?: unknown };
  if (typeof verdict.pass !== 'boolean') return { error: `the judge's answer has no boolean "pass": ${as.slice(0, 200)}` };
  return { pass: verdict.pass, reason: typeof verdict.reason === 'string' ? verdict.reason : '' };
}

/** Ask the judge whether `reply` does what `rubric` says: a verdict, or a judge failure after every retry. */
export async function judge(
  model: LanguageModel,
  rubric: string,
  customer: string,
  reply: string,
  options: JudgeOptions = {},
): Promise<Verdict | JudgeFailure> {
  const attempts = 1 + Math.max(0, options.retries ?? 2);
  const errors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await askOnce(model, rubric, customer, reply, options.maxOutputTokens ?? 1024);
    if (!('error' in answer)) return answer;
    errors.push(answer.error);
    // A request that failed is not asked again here: the provider has its own retries for that.
    if (!answer.askAgain) return { error: `the judge could not be asked: ${answer.error}`, attempts: attempt };
  }
  return {
    error: `the judge gave no verdict in ${attempts} attempt${attempts === 1 ? '' : 's'}: ${errors.map((e, i) => `(${i + 1}) ${e}`).join('; ')}`,
    attempts,
  };
}

async function askOnce(
  model: LanguageModel,
  rubric: string,
  customer: string,
  reply: string,
  maxOutputTokens: number,
): Promise<Verdict | { error: string; askAgain: boolean }> {
  try {
    const result = await generateText({
      model,
      instructions: JUDGE_INSTRUCTIONS,
      prompt: `Rubric: ${rubric}\n\nThe customer wrote:\n${customer || '(nothing: the turn continued after an approval)'}\n\nThe agent replied:\n${reply || '(nothing)'}`,
      output: Output.object({ schema: jsonSchema<Verdict>(VERDICT_SCHEMA), name: 'verdict', description: 'Whether the reply does what the rubric describes.' }),
      maxOutputTokens,
    });
    const verdict = asVerdict(result.output, JSON.stringify(result.output));
    return 'error' in verdict ? { ...verdict, askAgain: true } : verdict;
  } catch (err) {
    // An answer the structured parse refused may still hold a verdict as text (an older recording, a model that wrapped it).
    if (NoObjectGeneratedError.isInstance(err)) {
      const fromText = err.text ? readVerdict(err.text) : { error: 'the judge answered nothing' };
      if (!('error' in fromText)) return fromText;
      return { error: `${fromText.error}${err.finishReason === 'length' ? ` (cut off at ${maxOutputTokens} output tokens)` : ''}`, askAgain: true };
    }
    return { error: err instanceof Error ? err.message : String(err), askAgain: false };
  }
}
