/**
 * How much the agent says while it works: before a tool call, between steps,
 * after a step that fails. Given as `narration` on a persona's overrides.
 *
 * - `brief` (the default): the SDK fixes it. At most one brief line before a
 *   tool call, one short sentence of narration, no text between tool rounds,
 *   and a pivot past a failure without narrating it. A persona that names no
 *   narration is told exactly what it was told before the option existed.
 * - `host`: the host says how much, in an instruction that comes with each
 *   turn (the history's `stepContext`, which every step sends straight after
 *   the turn's message). The base, communication and tool strategy rules keep
 *   what holds at any amount: only words for the user, never reasoning, never
 *   a result a tool has not returned, never the same answer twice. A turn
 *   that comes with no instruction is held to the host's default
 *   (`narrationDefault`), or, with none, to one brief line.
 *
 * The setting and the default are part of the system prompt, which stays the
 * same on every turn: a host that lets the person choose how much the agent
 * says states its default level once there, and sends an instruction with a
 * turn only for another level, so changing it keeps the cached conversation.
 */

/** Who decides how much the agent says while it works. */
export type NarrationSetting = 'brief' | 'host';

/** Every setting; the first is the default. */
export const NARRATION_SETTINGS: readonly NarrationSetting[] = ['brief', 'host'];

/**
 * The setting, `brief` when none is given. Anything else throws, naming it,
 * so a host that means to say how much is never quietly held to one line.
 */
export function resolveNarration(setting?: NarrationSetting | null): NarrationSetting {
  if (setting === undefined || setting === null) return 'brief';
  if (!NARRATION_SETTINGS.includes(setting)) {
    throw new Error(`[agent-sdk] narration must be one of ${NARRATION_SETTINGS.join(', ')}, not ${JSON.stringify(setting)}`);
  }
  return setting;
}

/** How the rules name the host's instruction, in every rule that defers to it. */
export const NARRATION_INSTRUCTION = 'the instruction on how much you say while you work';

/**
 * The host's default amount (`overrides.narrationDefault`), as the rules
 * carry it: its text trimmed, or null with none. It is the host's to say, so
 * it needs `narration: 'host'`; empty text, or anything but a string, throws.
 */
export function resolveNarrationDefault(setting: NarrationSetting | null | undefined, text: unknown): string | null {
  if (text === undefined || text === null) return null;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`[agent-sdk] narrationDefault must be the text of the default amount, not ${JSON.stringify(text)}`);
  }
  if (resolveNarration(setting) !== 'host') {
    throw new Error("[agent-sdk] narrationDefault is the host's default amount: it needs narration: 'host'");
  }
  return text.trim();
}
