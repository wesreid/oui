/**
 * A message the person spoke says so (ADR-0259 §2.6).
 *
 * The tab transcribes speech and sends the words as the person's message, with
 * `context.input = { mode: 'voice', language }`. Speech recognition mis-hears:
 * a product name, a number, a word that sounds like another. Read as typed, a
 * mis-heard word is taken literally and acted on. Told the message was
 * spoken, the model reads an odd word as a likely mis-hearing, and asks when
 * one leaves the request ambiguous.
 *
 * - **What is read:** `readMessageInput` from `@ouispec/agent-core` keeps only
 *   a known mode and a well-formed language tag; anything else is read as
 *   typed, and a typed message is given nothing.
 * - **Where it goes:** on the turn's user message, right after the person's
 *   words, never in the system prompt or on an earlier message. The system
 *   prompt and the tools are a cached prefix, and the earlier messages are
 *   sent again unchanged on the next turn, so this changes only the newest
 *   message, as the clock does (`clock.ts`).
 */
import { MESSAGE_INPUT_CONTEXT_KEY, readMessageInput, type MessageInput } from '@ouispec/agent-core';
import type { ModelMessage } from 'ai';
import { withUserText } from './user-text.js';

/** How the turn's message was entered, from the turn's context; null when typed. */
export function readClientMessageInput(context: Record<string, unknown> | null | undefined): MessageInput | null {
  return readMessageInput(context?.[MESSAGE_INPUT_CONTEXT_KEY]);
}

/** The language's English name ("French"), or null when this runtime has none for the tag. */
function languageName(tag: string): string | null {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(tag) ?? null;
  } catch {
    return null;
  }
}

/** What the model is told about a spoken message: one line. */
export function spokenInputText(input: MessageInput): string {
  const name = input.language ? languageName(input.language) : null;
  const language = input.language ? ` The language detected was ${name ? `${name} (${input.language})` : input.language}.` : '';
  return (
    `<input>The user spoke this message and speech recognition transcribed it, so it may contain recognition errors.${language} ` +
    'If a likely mis-hearing makes the request ambiguous, ask the user what they meant rather than guess.</input>'
  );
}

/**
 * Say on the turn's user message that it was spoken, when the turn's context
 * says so. A typed message, and messages that do not end with the user's (a
 * continuation the worker runs itself), are left as they are.
 */
export function withSpokenInput(
  messages: ModelMessage[],
  context: Record<string, unknown> | null | undefined,
): ModelMessage[] {
  const input = readClientMessageInput(context);
  const last = messages[messages.length - 1];
  if (!input || !last || last.role !== 'user') return messages;
  return [...messages.slice(0, -1), withUserText(last, spokenInputText(input))];
}
