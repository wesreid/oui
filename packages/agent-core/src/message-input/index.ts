/**
 * How the person entered a message (ADR-0259 §2.6).
 *
 * A message the person spoke, and the tab transcribed with speech
 * recognition, carries `{ mode: 'voice', language }` on its turn's context,
 * under `input`. A typed message carries nothing. The worker tells the model
 * the message was spoken and machine-transcribed, so a word it cannot make
 * sense of may be a mis-hearing; the host stores it on the user's message so
 * the chat can show the message was spoken.
 *
 * It arrives from a browser, so every reader takes it through
 * `readMessageInput`, which keeps only what it recognises.
 */

/** The key under a turn's context that carries how its message was entered. */
export const MESSAGE_INPUT_CONTEXT_KEY = 'input';

/** The ways a message can be entered besides typing. A typed message carries no `input`. */
export const MESSAGE_INPUT_MODES = ['voice'] as const;

export type MessageInputMode = (typeof MESSAGE_INPUT_MODES)[number];

/** The longest language tag kept: longer is not a language a recogniser names. */
export const MAX_MESSAGE_INPUT_LANGUAGE_CHARS = 16;

/** A message the person spoke: the language is the one the recogniser detected. */
export interface MessageInput {
  mode: MessageInputMode;
  /**
   * The language the recogniser detected, as a BCP 47 tag ("fr", "pt-BR").
   * Absent when it did not say.
   */
  language?: string;
}

/** A primary language subtag of 2–3 letters, then subtags of 2–8 letters or digits. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * `value` as a language tag, canonical ("pt-br" → "pt-BR"), or null when it is
 * not one: not a string, too long, or not shaped as a tag.
 */
export function readMessageInputLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MESSAGE_INPUT_LANGUAGE_CHARS) return null;
  if (!LANGUAGE_TAG.test(value)) return null;
  try {
    // Throws a RangeError for a tag that is shaped right but is not valid BCP 47.
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * How a message was entered, when `value` says so in a way this runtime
 * knows; else null. An unknown mode, or a value that is not an object, is
 * null: the message is read as typed. A language that is not a language tag
 * is left out, and the message is still read as spoken.
 */
export function readMessageInput(value: unknown): MessageInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { mode, language } = value as Record<string, unknown>;
  if (typeof mode !== 'string' || !(MESSAGE_INPUT_MODES as readonly string[]).includes(mode)) return null;
  const tag = readMessageInputLanguage(language);
  return { mode: mode as MessageInputMode, ...(tag ? { language: tag } : {}) };
}
