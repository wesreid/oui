/**
 * Rows of a list on the page, named as a host names them: by key, else by
 * title (exactly, or ignoring case and outer spaces), through the bindings'
 * own resolver (`resolveRef`), so a fixture resolves a row exactly as the
 * product's page does. The fixture page uses it for the rows a run writes
 * (`writes`), and the checks for the row a run addressed (`page.ran`,
 * `page.ranInCase`, a stub's `afterRan`).
 */
import { resolveRef } from '@ouispec/bindings';
import { holdsSubset } from './matchers.js';

/** A row of a list on the page: what addresses it, and what it is called. */
export interface EvalPageRow {
  key: string;
  title: string;
}

/** The row a value names, or why none: no row has it, or several share it as their title. */
export type RowResolution = { row: EvalPageRow } | { missing: true } | { ambiguous: readonly EvalPageRow[] };

/** The row `given` names among `rows`: its key, else the one row whose title it is. */
export function resolveRow(rows: readonly EvalPageRow[], given: string): RowResolution {
  const found = resolveRef(given, { lists: ['rows'], rows: () => rows.map((r) => ({ ref: r.key, title: r.title })) }, ['rows']);
  if (found === null) return { missing: true };
  if ('error' in found) {
    const wanted = given.trim().toLowerCase();
    return { ambiguous: rows.filter((r) => r.title.trim().toLowerCase() === wanted) };
  }
  return { row: rows.find((r) => r.key === found.ref)! };
}

/** Rows as a message lists them: `"Line 1" (line-1), …`, at most 30. */
export function describeRows(rows: readonly EvalPageRow[]): string {
  if (rows.length === 0) return 'none';
  const shown = rows.slice(0, 30).map((r) => `"${r.title}" (${r.key})`);
  return `${shown.join(', ')}${rows.length > 30 ? ', …' : ''}`;
}

/** The key of the row a value names among `rows`; null when it names none, or several. */
export function rowKeyOf(rows: readonly EvalPageRow[], given: unknown): string | null {
  if (typeof given !== 'string') return null;
  const resolved = resolveRow(rows, given);
  return 'row' in resolved ? resolved.row.key : null;
}

/**
 * Whether a run's input holds what an expectation wants of it, as a subset
 * (`holdsSubset`). Where the run addressed a row of a list the page knows
 * (`rows`), its `item` also holds when it names the same row as the
 * expectation's: by key, exact title or title ignoring case. Everything that
 * held before rows were resolved still holds.
 */
export function runInputHolds(input: Readonly<Record<string, unknown>>, wanted: Readonly<Record<string, unknown>> | undefined, rows?: readonly EvalPageRow[]): boolean {
  if (wanted === undefined || holdsSubset(input, wanted)) return true;
  if (!rows || !('item' in wanted)) return false;
  const { item, ...rest } = wanted;
  const want = rowKeyOf(rows, item);
  return want !== null && want === rowKeyOf(rows, input.item) && holdsSubset(input, rest);
}

/** Whether two runs' `item`s name the same row: equal as given, or the same row of `rows`. */
export function sameRow(given: unknown, other: unknown, rows?: readonly EvalPageRow[]): boolean {
  if (given === other) return true;
  if (!rows) return false;
  const key = rowKeyOf(rows, given);
  return key !== null && key === rowKeyOf(rows, other);
}
