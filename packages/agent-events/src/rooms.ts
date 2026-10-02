/**
 * Room patterns: `generation:{jobId}` names every room of that kind. One
 * reading of a pattern, used to build a room, to recognise one, and to
 * generate constructors, so the three cannot disagree.
 */

/** What an id in a room may be. */
export const ROOM_ID_CHARS = '[a-zA-Z0-9_-]+';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** The placeholders of a pattern, in order: `agent:turn:{turnId}` → `['turnId']`. */
export function roomPlaceholders(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** The pattern with `{name}`s replaced by `format(name)`, and the literal text by `literal(text)`. */
export function mapRoomPattern(pattern: string, literal: (text: string) => string, format: (name: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of pattern.matchAll(PLACEHOLDER)) {
    out += literal(pattern.slice(last, m.index));
    out += format(m[1]);
    last = (m.index ?? 0) + m[0].length;
  }
  return out + literal(pattern.slice(last));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular-expression source (unanchored) matching exactly the rooms of a pattern. */
export function roomPatternSource(pattern: string): string {
  return mapRoomPattern(pattern, escapeRegExp, () => ROOM_ID_CHARS);
}

/** A regular expression matching exactly the rooms of any of the patterns. */
export function roomPatternsRegExp(patterns: readonly string[]): RegExp {
  return new RegExp(`^(?:${patterns.map(roomPatternSource).join('|')})$`);
}

/**
 * The room a pattern names for these values. Throws when a value is missing
 * or is not a valid id: a room built from `undefined` is a room nobody is in.
 */
export function formatRoom(pattern: string, values: Readonly<Record<string, unknown>>): string {
  const idChars = new RegExp(`^${ROOM_ID_CHARS}$`);
  return mapRoomPattern(
    pattern,
    (text) => text,
    (name) => {
      const value = values[name];
      if (typeof value !== 'string' || !idChars.test(value)) {
        throw new Error(`[agent-sdk-events] room ${pattern} needs '${name}' to be an id, got ${JSON.stringify(value)}`);
      }
      return value;
    },
  );
}
