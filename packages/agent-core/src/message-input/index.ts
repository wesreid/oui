/**
 * How the person entered a message, and how the reply reaches them.
 *
 * A message the person spoke, and the tab transcribed with speech
 * recognition, carries `{ mode: 'voice', language }` on its turn's context,
 * under `input`. A typed message carries nothing. The worker tells the model
 * the message was spoken and machine-transcribed, so a word it cannot make
 * sense of may be a mis-hearing; the host stores it on the user's message so
 * the chat can show the message was spoken.
 *
 * A reply that will be spoken rather than shown (a live call, where a voice
 * reads the reply out) carries `{ mode: 'voice' }` under `output`. The worker
 * then tells the model to write for the ear.
 *
 * Both arrive from outside the worker, so every reader takes them through
 * `readMessageInput` and `readReplyOutput`, which keep only what they
 * recognise.
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

/** The key under a turn's context that carries how its reply reaches the person. */
export const REPLY_OUTPUT_CONTEXT_KEY = 'output';

/** The ways a reply can reach the person besides being shown as text. A shown reply carries no `output`. */
export const REPLY_OUTPUT_MODES = ['voice'] as const;

export type ReplyOutputMode = (typeof REPLY_OUTPUT_MODES)[number];

/**
 * What the voice that reads a spoken reply can be directed with: the inline
 * tags its speech engine honours (`[laughs]`, `[whispering]`), and how to use
 * them. The service that speaks the reply sends it, since only it knows which
 * engine will read the reply; the model is told it may use those tags.
 */
export interface VoiceDirections {
  /** The speech engine the tags are for, as the service names it. */
  engine: string;
  /** The tags the engine honours, each exactly as it is written in the text. */
  tags: string[];
  /** How and when to use them, in the service's words. */
  guidance: string;
}

/** Limits on `VoiceDirections`: longer is not a direction contract, and is left out. */
export const VOICE_DIRECTIONS_LIMITS = {
  engineChars: 64,
  tags: 64,
  tagChars: 64,
  guidanceChars: 2_000,
} as const;

/** A reply that will be spoken: a voice reads its text out, and nothing of it is shown. */
export interface ReplyOutput {
  mode: ReplyOutputMode;
  /** The voice's direction tags, when the speaking service offers them. */
  voiceDirections?: VoiceDirections;
}

/** Any control character but none of the ordinary whitespace a guidance paragraph may hold. */
// eslint-disable-next-line no-control-regex
const DIRECTION_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * `value` as voice directions, or null when it is not one: an engine, a list
 * of tags and guidance, each a non-blank string within `VOICE_DIRECTIONS_LIMITS`
 * and free of control characters (guidance may break lines). Tags are kept
 * once each, in order.
 */
export function readVoiceDirections(value: unknown): VoiceDirections | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { engine, tags, guidance } = value as Record<string, unknown>;
  const line = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !LINE_CONTROL.test(s);
  if (!line(engine, VOICE_DIRECTIONS_LIMITS.engineChars)) return null;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > VOICE_DIRECTIONS_LIMITS.tags) return null;
  if (!tags.every((t) => line(t, VOICE_DIRECTIONS_LIMITS.tagChars))) return null;
  if (typeof guidance !== 'string' || !guidance.trim() || guidance.length > VOICE_DIRECTIONS_LIMITS.guidanceChars || DIRECTION_CONTROL.test(guidance)) {
    return null;
  }
  return { engine: engine.trim(), tags: [...new Set((tags as string[]).map((t) => t.trim()))], guidance: guidance.trim() };
}

/**
 * How a reply reaches the person, when `value` says so in a way this runtime
 * knows; else null, and the reply is shown as text. Anything but the mode and
 * well-formed `voiceDirections` is left out; malformed directions are left
 * out and the reply is still spoken.
 */
export function readReplyOutput(value: unknown): ReplyOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { mode, voiceDirections } = value as Record<string, unknown>;
  if (typeof mode !== 'string' || !(REPLY_OUTPUT_MODES as readonly string[]).includes(mode)) return null;
  const directions = readVoiceDirections(voiceDirections);
  return { mode: mode as ReplyOutputMode, ...(directions ? { voiceDirections: directions } : {}) };
}
