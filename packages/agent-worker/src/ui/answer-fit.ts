/**
 * What an action returned, fitted to what a model should read of it.
 *
 * The page fits an answer to the wire (oui-spec §7.3.9, 480 KB). That is far
 * more than a model should be handed: on dev (2026-10-08) deleting an artboard
 * of 779 layers answered with 88 KB of removed rows, and inspecting it with
 * 107 KB, and the step that carried both was 168,155 tokens. Every later step
 * of the turn read them again.
 *
 * Over the budget, the longest lists are cut to their first rows, then the
 * longest texts, and the model is told what each had and how many are here, so
 * it knows the result is partial and asks for less at a time.
 */

/** How much of an action's result the model is given, in characters of JSON: about 7,000 tokens. */
export const DEFAULT_ANSWER_DATA_CHARS = 24_000;
/** A text this long or shorter is never cut. */
const TEXT_KEPT_CHARS = 2_000;
/** Enough passes to bring any result under the budget: each halves what is largest. */
const MAX_PASSES = 40;

export interface AnswerDataCut {
  /** Where in the result, as a path: `changed`, `items[0].layers`. */
  path: string;
  kind: 'list' | 'text';
  /** Rows or characters it had, and how many of them are here. */
  total: number;
  kept: number;
}

type Holder = { parent: Record<string, unknown> | unknown[]; key: string | number; path: string };

const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

/** Every list of more than one row and every long text in `value`, each with where it is held. */
function cuttable(value: unknown, path: string, holder: Holder | null, out: Array<Holder & { size: number; kind: 'list' | 'text' }>): void {
  if (typeof value === 'string') {
    if (holder && value.length > TEXT_KEPT_CHARS) out.push({ ...holder, size: value.length, kind: 'text' });
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (holder && value.length > 1) out.push({ ...holder, size: sizeOf(value), kind: 'list' });
    value.forEach((item, i) => cuttable(item, `${path}[${i}]`, { parent: value, key: i, path: `${path}[${i}]` }, out));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    cuttable(child, at, { parent: value as Record<string, unknown>, key, path: at }, out);
  }
}

/**
 * `data` within `maxChars` of JSON, and what was cut to fit it. Data that fits
 * is returned as it is, with no cuts.
 */
export function fitAnswerData(data: unknown, maxChars: number = DEFAULT_ANSWER_DATA_CHARS): { data: unknown; cuts: AnswerDataCut[] } {
  if (data === undefined || sizeOf(data) <= maxChars) return { data, cuts: [] };
  // The result is held under a key, so that a result that is itself a list or a text can be cut.
  const root: { result: unknown } = { result: structuredClone(data) };
  const cuts = new Map<string, AnswerDataCut>();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const over = sizeOf(root.result) - maxChars;
    if (over <= 0) break;
    const found: Array<Holder & { size: number; kind: 'list' | 'text' }> = [];
    cuttable(root.result, '', { parent: root as unknown as Record<string, unknown>, key: 'result', path: '' }, found);
    // The largest first: one cut there does the most.
    const target = found.sort((a, b) => b.size - a.size)[0];
    if (!target) break;
    const held = (target.parent as Record<string | number, unknown>)[target.key];
    const path = target.path || 'result';
    if (target.kind === 'list') {
      const list = held as unknown[];
      // Keep the share of it that would fit, and never more than half: a list this large is cut again if need be.
      const share = Math.min(0.5, Math.max(0, (target.size - over) / target.size));
      const kept = Math.max(1, Math.floor(list.length * share));
      (target.parent as Record<string | number, unknown>)[target.key] = list.slice(0, kept);
      cuts.set(path, { path, kind: 'list', total: cuts.get(path)?.total ?? list.length, kept });
    } else {
      const text = held as string;
      const kept = Math.max(TEXT_KEPT_CHARS, Math.min(text.length - over, Math.floor(text.length / 2)));
      (target.parent as Record<string | number, unknown>)[target.key] = text.slice(0, kept);
      cuts.set(path, { path, kind: 'text', total: cuts.get(path)?.total ?? text.length, kept });
    }
  }
  // A list cut inside a row that a later cut removed is no longer in the result: it is not reported.
  const present = [...cuts.values()].filter((cut) => reaches(root.result, cut.path));
  return { data: root.result, cuts: present };
}

/** Whether `path` still leads somewhere in `value`. */
function reaches(value: unknown, path: string): boolean {
  if (path === 'result') return true;
  let at: unknown = value;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (at === null || typeof at !== 'object') return false;
    at = (at as Record<string, unknown>)[part];
    if (at === undefined) return false;
  }
  return true;
}

/** What the model is told of each cut: what the result had, how much is here, and to ask for less at a time. */
export function answerCutNotes(cuts: readonly AnswerDataCut[]): string[] {
  return cuts.map((cut) => {
    const where = cut.path === 'result' ? 'The result' : `result.${cut.path}`;
    return cut.kind === 'list'
      ? `${where} had ${cut.total} rows; the first ${cut.kept} are here. The action did all of them. To read the rest, ask for less at a time: fewer ids, a filter, or a page of the list.`
      : `${where} is ${cut.total} characters; the first ${cut.kept} are here.`;
  });
}
