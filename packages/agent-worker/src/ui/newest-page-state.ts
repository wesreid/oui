/**
 * Only the newest UI answer carries the page's state to the model.
 *
 * Every UI answer comes with the page's state (`state`, up to the page-state
 * budget), so the model sees what its action did. Kept on every answer, a turn
 * of many actions resends every earlier page with every step: in session
 * 24611234 a turn of 24 editor actions peaked at 205,000 prompt tokens, about
 * 5,000 for each answer kept. An earlier page is not what the page is now, and
 * the newest answer holds that.
 *
 * So before each step, every earlier answer keeps what it did (its result, the
 * rows it changed, what the page offers since, any error) and its `state` is
 * replaced with one line that says where the page's state is.
 */
import type { ModelMessage } from 'ai';

export const SUPERSEDED_STATE =
  'Not repeated: a later answer in this conversation carries the page’s state, which is what the page is now.';

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
 * `messages` with the page's state kept on the newest answer that carries one
 * and replaced on every earlier one, or null when there is nothing to replace.
 */
export function withNewestPageStateOnly(messages: readonly ModelMessage[]): { messages: ModelMessage[]; replaced: number } | null {
  // The newest answer with a state, found from the end.
  let newest: string | null = null;
  for (let i = messages.length - 1; i >= 0 && newest === null; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j];
      if (part.type !== 'tool-result') continue;
      const text = textOf(part.output);
      if (text !== null && stateful(text)) {
        newest = part.toolCallId;
        break;
      }
    }
  }
  if (newest === null) return null;

  let replaced = 0;
  const out = messages.map((m) => {
    if (m.role !== 'tool') return m;
    let changed = false;
    const content = m.content.map((part) => {
      if (part.type !== 'tool-result' || part.toolCallId === newest) return part;
      const text = textOf(part.output);
      const answer = text === null ? null : stateful(text);
      if (!answer || answer.state === SUPERSEDED_STATE) return part;
      changed = true;
      replaced++;
      return { ...part, output: withText(part.output, JSON.stringify({ ...answer, state: SUPERSEDED_STATE })) };
    });
    return changed ? { ...m, content } : m;
  });
  return replaced ? { messages: out, replaced } : null;
}
