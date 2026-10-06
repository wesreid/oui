/**
 * Adding to the turn's user message without losing its parts.
 *
 * The note, the page's state and the clock are put after what the user said.
 * A message with files is parts (its text, then pictures and documents,
 * ADR-0252 §2.11), and flattening it to its text dropped the pictures before
 * the model call. So the text is added to the message's first text part and
 * every other part is kept where it is.
 */
import type { ModelMessage } from 'ai';

type UserMessage = Extract<ModelMessage, { role: 'user' }>;
type UserPart = Exclude<UserMessage['content'], string>[number];

/** The message's text: a string message's whole content, or its text parts joined. */
export function userText(message: UserMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** `message` with `addition` after its text, every non-text part kept. */
export function withUserText(message: UserMessage, addition: string): UserMessage {
  if (typeof message.content === 'string') {
    return { ...message, content: message.content ? `${message.content}\n\n${addition}` : addition };
  }
  const parts: UserPart[] = [...message.content];
  const first = parts.findIndex((part) => part.type === 'text');
  if (first < 0) return { ...message, content: [{ type: 'text', text: addition }, ...parts] };
  const text = parts[first] as Extract<UserPart, { type: 'text' }>;
  parts[first] = { ...text, text: text.text ? `${text.text}\n\n${addition}` : addition };
  return { ...message, content: parts };
}
