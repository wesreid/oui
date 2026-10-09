/**
 * The page's state is read at the end of each step, never inside an answer.
 *
 * Every UI answer comes with the page's state (`state`, up to the page-state
 * budget), so the model sees what its action did. Kept on every answer, a turn
 * of many actions resent every earlier page with every step: in session
 * 24611234 a turn of 24 editor actions peaked at 205,000 prompt tokens, about
 * 5,000 for each answer kept. So only the newest answer kept it, and each
 * earlier one had it replaced when a newer one came.
 *
 * Replacing it in an answer already sent changed a prefix the prompt cache
 * held: each new answer made the step write the conversation from the answer
 * before it, and the first answer of a turn did that from the end of the
 * previous turn (dev, 2026-10-08: a quarter of PA input written again, a
 * quarter never read from the cache). So every answer gives its state up the
 * same way, as it arrives and every time it is sent again, and the newest
 * state goes after the conversation, where nothing is cached
 * (step-messages.ts). An answer once sent never changes.
 */
import type { ModelMessage } from 'ai';

/** What an answer holds where its state was: the same words every time, so it never changes once sent. */
export const STATE_AT_END = 'The page’s state is at the end of what you read, in <page_state>: the page as it is now.';

type ToolResultPart = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>;

/** The JSON text of an answer, when it is a UI answer that carries the page's state. */
function stateful(text: string): Record<string, unknown> | null {
  if (!text.includes('"state"')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) && 'state' in value
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The answer's text, wherever its output keeps it. */
function textOf(output: ToolResultPart['output']): string | null {
  if (output.type === 'text') return output.value;
  if (output.type === 'json') return JSON.stringify(output.value);
  if (output.type === 'content') {
    const part = output.value.find((p) => p.type === 'text') as { text: string } | undefined;
    return part?.text ?? null;
  }
  return null;
}

function withText(output: ToolResultPart['output'], text: string): ToolResultPart['output'] {
  if (output.type === 'text') return { ...output, value: text };
  if (output.type === 'json') return { ...output, value: JSON.parse(text) };
  if (output.type === 'content') {
    let done = false;
    return {
      ...output,
      value: output.value.map((p) => {
        if (done || p.type !== 'text') return p;
        done = true;
        return { ...p, text };
      }),
    };
  }
  return output;
}

/**
 * An answer's text with its state taken out, as the model is sent it: what is
 * stored, so the history sends it the same way every turn. Text that is not an
 * answer with a state is returned as it is.
 */
export function answerWithoutState(text: string): string {
  const answer = stateful(text);
  if (!answer) return text;
  const { state: _state, ...rest } = answer;
  return JSON.stringify({ ...rest, pageState: STATE_AT_END });
}

/**
 * `messages` with the state taken out of every answer, and the newest state
 * taken from an answer after `from` (this turn's answers: earlier ones are older
 * than the page the turn began on). An answer that already gave its state up is
 * left exactly as it is.
 */
export function withStatesAtEnd(
  messages: readonly ModelMessage[],
  from: number,
): { messages: ModelMessage[]; newest: unknown; moved: number } {
  let newest: unknown;
  let moved = 0;
  const out = messages.map((m, index) => {
    if (m.role !== 'tool') return m;
    let changed = false;
    const content = m.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const text = textOf(part.output);
      const answer = text === null ? null : stateful(text);
      if (!answer) return part;
      if (index > from) newest = answer.state;
      changed = true;
      moved++;
      return { ...part, output: withText(part.output, answerWithoutState(text!)) };
    });
    return changed ? { ...m, content } : m;
  });
  return { messages: out, newest, moved };
}
