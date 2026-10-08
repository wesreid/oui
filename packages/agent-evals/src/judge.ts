/**
 * A rubric's verdict (ADR-0260 §3.2): a judge model reads the customer's
 * message, the agent's reply and the rubric, and answers whether the reply
 * does what the rubric says. Its call goes through the same fetch as the
 * agent's, so in CI it is replayed from the scenario's recording like every
 * other model response.
 */
import { generateText } from 'ai';
import type { LanguageModel } from '@ouispec/agent-worker';

export interface Verdict {
  pass: boolean;
  reason: string;
}

export const JUDGE_INSTRUCTIONS =
  'You grade one reply of a customer-facing AI agent against one rubric. ' +
  'Answer with only a JSON object and nothing else: {"pass": true or false, "reason": "one sentence"}. ' +
  '"pass" is true only when the reply clearly does what the rubric describes.';

/** The JSON object in a judge's answer, or why there is none. */
export function readVerdict(text: string): Verdict | { error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return { error: `the judge answered no JSON: ${JSON.stringify(text.slice(0, 200))}` };
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { pass?: unknown; reason?: unknown };
    if (typeof value.pass !== 'boolean') return { error: `the judge's answer has no boolean "pass": ${text.slice(start, end + 1)}` };
    return { pass: value.pass, reason: typeof value.reason === 'string' ? value.reason : '' };
  } catch {
    return { error: `the judge's answer is not JSON: ${JSON.stringify(text.slice(start, end + 1).slice(0, 200))}` };
  }
}

/** Ask the judge whether `reply` does what `rubric` says. */
export async function judge(model: LanguageModel, rubric: string, customer: string, reply: string): Promise<Verdict | { error: string }> {
  const { text } = await generateText({
    model,
    instructions: JUDGE_INSTRUCTIONS,
    prompt: `Rubric: ${rubric}\n\nThe customer wrote:\n${customer || '(nothing: the turn continued after an approval)'}\n\nThe agent replied:\n${reply || '(nothing)'}`,
    maxOutputTokens: 300,
  });
  return readVerdict(text);
}
