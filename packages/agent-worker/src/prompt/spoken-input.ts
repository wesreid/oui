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
 * - **Where it goes:** after the conversation, with what else is true only
 *   for this turn (step-messages.ts), never in the system prompt or on the
 *   message itself. The system prompt and the tools are a cached prefix, and
 *   the next turn sends the message as the host stored it, without this line:
 *   on the message, it made that turn write the conversation from there to the
 *   cache again.
 */
import { MESSAGE_INPUT_CONTEXT_KEY, readMessageInput, type MessageInput } from '@ouispec/agent-core';

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
    `<input>The user spoke their newest message and speech recognition transcribed it, so it may contain recognition errors.${language} ` +
    'If a likely mis-hearing makes the request ambiguous, ask the user what they meant rather than guess.</input>'
  );
}
