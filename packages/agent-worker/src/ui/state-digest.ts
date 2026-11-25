/**
 * What a stored answer keeps of the page it showed: its digest.
 *
 * An answer gives its page state up as it arrives (page-state-at-end.ts), so
 * nothing of the page survived in stored history: a later turn, asked "why
 * did you say the Rogue?" after the page had moved on, read only "the page as
 * it is now" in every earlier answer, and the model took back an answer that
 * had been true. So each UI answer carries a short digest of what its page
 * showed (`shown`), beside its state. It is made once, when the answer
 * arrives, from the answer's own observations, and nothing changes it after:
 * `answerWithoutState` takes out only `state`, so the digest is stored and sent
 * again in the same words, and an answer once sent still never changes.
 *
 * The digest is bounded (`DEFAULT_STATE_DIGEST_CHARS`, the host's
 * `maxStateDigestChars`) and deterministic: the surface acted on first, then
 * the page's own surfaces, the shells last (`surfaceRank`); each display's
 * facts by label; each list's count and the titles of its first rows. A host
 * chooses its own content (`stateDigest`, a function of the observations), or
 * none (`false`).
 *
 * The page a turn began on is kept the same way, on the person's message
 * (`pageAtStart`, page-at-start.ts).
 */
import type { OUIObservationSnapshot } from 'oui-spec/spec';
import { rowValue } from '@ouispec/bindings';
import { PROBLEMS_OBSERVATION_ID, surfaceRank, type ObservationSchemas } from './observations.js';

/** The longest digest of a page a stored answer, or a person's message, keeps, in characters, when the host sets none. */
export const DEFAULT_STATE_DIGEST_CHARS = 600;

/** How many of a list's first rows the default digest names. */
export const DIGEST_FIRST_ROWS = 3;

/** The longest a fact's value or a row's title is in the default digest, in characters. */
const VALUE_CHARS = 80;

/** What a digest is made for. */
export interface StateDigestContext {
  /** The surface the answered action acted on; null for the page a turn began on, where nothing acted. */
  surfaceId: string | null;
  /** Each surface's observation schemas, by surface id then observation id: where row lists are declared (`x-rows`). */
  schemas: ObservationSchemas;
  /** `answer`: a UI answer's `shown`. `pageAtStart`: the page the person's message was sent from. */
  at: 'answer' | 'pageAtStart';
}

/**
 * A host's digest of a page: the text a stored answer keeps as `shown` (and a
 * person's message as `pageAtStart`), or null for none. Called once per
 * answer, when it arrives; what it returns is cut to the host's bound. A throw,
 * or anything that is not a string or null, is logged and keeps no digest.
 */
export type StateDigest = (observations: OUIObservationSnapshot, context: StateDigestContext) => string | null;

/** `ui.stateDigest`: the default digest (left out), the host's (a function), or none (`false`). */
export type StateDigestSetting = StateDigest | false | undefined;

/** The setting as given, or a refusal naming what it may be. */
export function readStateDigestSetting(value: unknown): StateDigestSetting {
  if (value === undefined || value === false || typeof value === 'function') return value as StateDigestSetting;
  throw new Error(
    `[agent-sdk] ui.stateDigest must be a function, false, or left out, not ${value === null ? 'null' : typeof value}`,
  );
}

/** The bound a host set, or the default. */
export function stateDigestChars(max: number | undefined): number {
  return typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_STATE_DIGEST_CHARS;
}

/** One line of text, at most `max` characters, cut with an ellipsis. */
function clip(text: string, max: number): string {
  return bounded(text.replace(/\s+/g, ' ').trim(), max);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const textOf = (v: unknown): string | null =>
  typeof v === 'string' ? (v.trim() ? v : null) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

/** What a page state reports that is not a list of what the page shows: its fields, what is unavailable or busy. */
const NOT_LISTS = new Set(['values', 'unavailable', 'busy', 'schema']);

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  'x-rows'?: { ref: string; title: string };
}

/** A row's title: as its list's schema declares it (`x-rows`), or its own `title` or `name`, or the row itself when it is text. */
function rowTitle(row: unknown, schema: SchemaNode | undefined): string | null {
  const declared = schema?.['x-rows'];
  if (declared && isObject(row)) return textOf(rowValue(row, declared.title));
  if (isObject(row)) return textOf(row.title) ?? textOf(row.name);
  return textOf(row);
}

/** A list: its name, how many rows it has, and the titles of its first rows. */
function listPart(name: string, rows: readonly unknown[], schema: SchemaNode | undefined): string {
  const titles = rows
    .map((row) => rowTitle(row, schema))
    .filter((t): t is string => t !== null)
    .slice(0, DIGEST_FIRST_ROWS)
    .map((t) => clip(t, VALUE_CHARS));
  if (titles.length === 0) return `${name}: ${rows.length}`;
  return `${name}: ${rows.length} (${titles.join(', ')}${rows.length > titles.length ? ', …' : ''})`;
}

/**
 * What the page shows (`shown`, oui-bindings `ShownFacts`), by display: the
 * page's own facts by label, and a display of many rows (a card each) as a
 * list of their titles.
 */
function shownParts(shown: readonly unknown[]): string[] {
  const order: string[] = [];
  const displays = new Map<string, { title: string; facts: Array<[string, string]>; rows: string[]; count: number }>();
  for (const entry of shown) {
    if (!isObject(entry)) continue;
    const id = String(entry.id ?? '');
    let display = displays.get(id);
    if (!display) {
      display = { title: textOf(entry.title) ?? id, facts: [], rows: [], count: 0 };
      displays.set(id, display);
      order.push(id);
    }
    const item = isObject(entry.item) ? entry.item : null;
    if (item) {
      display.count += 1;
      const title = textOf(item.title);
      if (title && display.rows.length < DIGEST_FIRST_ROWS) display.rows.push(clip(title, VALUE_CHARS));
      continue;
    }
    if (isObject(entry.facts)) {
      for (const [label, value] of Object.entries(entry.facts)) {
        const text = textOf(value);
        if (text) display.facts.push([label, clip(text, VALUE_CHARS)]);
      }
    }
  }
  return order.flatMap((id) => {
    const d = displays.get(id)!;
    const parts: string[] = [];
    if (d.facts.length) parts.push(`${clip(d.title, VALUE_CHARS)} (${d.facts.map(([label, value]) => `${label}: ${value}`).join('; ')})`);
    if (d.count) {
      parts.push(
        `${clip(d.title, VALUE_CHARS)}: ${d.count}${d.rows.length ? ` (${d.rows.join(', ')}${d.count > d.rows.length ? ', …' : ''})` : ''}`,
      );
    }
    return parts;
  });
}

/** One observation, as the digest gives it: what it shows and its lists. */
function observationParts(id: string, value: unknown, schema: SchemaNode | undefined): string[] {
  if (Array.isArray(value)) return value.length ? [listPart(id, value, schema)] : [];
  if (!isObject(value)) return [];
  const parts: string[] = [];
  if (Array.isArray(value.shown)) parts.push(...shownParts(value.shown));
  // A page's lists, by the binding that shows each.
  if (isObject(value.lists)) {
    for (const [list, rows] of Object.entries(value.lists)) {
      if (Array.isArray(rows) && rows.length) parts.push(listPart(list, rows, schema?.properties?.lists?.properties?.[list]));
    }
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === 'shown' || key === 'lists' || NOT_LISTS.has(key) || !Array.isArray(v) || v.length === 0) continue;
    parts.push(listPart(`${id}.${key}`, v, schema?.properties?.[key]));
  }
  return parts;
}

/** A job's status (`<surface>:<action>:status`): what the page state reports whole, not what the page shows. */
const isJobStatus = (observationId: string) => observationId.endsWith(':status');

/**
 * The default digest of a page: every surface that shows something, the one
 * acted on first and the shells last, each as its id and then what it shows
 * (each display's facts by label) and its lists (each one's count and its
 * first rows' titles), cut to `maxChars`. An empty string when the page shows
 * nothing it can say.
 *
 *   page:lead — Lead (Name: Maria Alvarez; Source: Website); leads.open: 3 (Maria Alvarez, Tom Lee, Ana Diaz, …)
 */
export function pageDigest(
  observations: OUIObservationSnapshot,
  context: Pick<StateDigestContext, 'surfaceId' | 'schemas'>,
  maxChars: number = DEFAULT_STATE_DIGEST_CHARS,
): string {
  const acting = context.surfaceId ?? undefined;
  const surfaces = Object.entries(observations ?? {})
    .map(([surface, values], at) => ({ surface, values, at }))
    .sort((a, b) => surfaceRank(a.surface, acting) - surfaceRank(b.surface, acting) || a.at - b.at);
  const lines = surfaces.flatMap(({ surface, values }) => {
    const schemas = (context.schemas?.[surface] ?? {}) as Readonly<Record<string, SchemaNode | undefined>>;
    const parts = Object.entries(values ?? {}).flatMap(([id, value]) =>
      id === PROBLEMS_OBSERVATION_ID || isJobStatus(id) ? [] : observationParts(id, value, schemas[id]),
    );
    return parts.length ? [`${surface} — ${parts.join('; ')}`] : [];
  });
  return bounded(lines.join(' | '), maxChars);
}

/** Text cut to `max` characters, with an ellipsis where it was cut. */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const cut = text.slice(0, max - 1);
  // At a word's end, when one is near.
  const space = cut.lastIndexOf(' ');
  return `${(space >= max - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type DigestLog = (level: 'info' | 'warn', message: string, data: Record<string, unknown>) => void;

/**
 * The digest a page is kept by, as the host's setting says: the default, the
 * host's own (cut to the bound), or none. Null when there is none: the
 * setting is `false`, the host's function said null or failed, or the page
 * showed nothing.
 */
export function stateDigestOf(
  observations: OUIObservationSnapshot | undefined,
  context: StateDigestContext,
  setting: StateDigestSetting,
  maxChars: number | undefined,
  log?: DigestLog,
): string | null {
  if (setting === false || !observations || Object.keys(observations).length === 0) return null;
  const max = stateDigestChars(maxChars);
  if (setting === undefined) return pageDigest(observations, context, max) || null;
  let made: unknown;
  try {
    made = setting(observations, context);
  } catch (err) {
    log?.('warn', 'The host’s page digest failed; the page is kept without one', {
      at: context.at,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (made === null || made === undefined) return null;
  if (typeof made !== 'string') {
    log?.('warn', 'The host’s page digest is not text; the page is kept without one', { at: context.at, got: typeof made });
    return null;
  }
  const text = made.trim();
  return text ? bounded(text, max) : null;
}
