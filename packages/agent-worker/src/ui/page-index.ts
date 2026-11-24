/**
 * The page as the worker holds it: an index of what it offers.
 *
 * A client sends its surfaces in one of two forms (oui-spec §7.3.8): an index
 * of its actions, or every action's definition. The worker works from the
 * index either way. From definitions it derives the same index, and keeps the
 * definitions to describe actions from; from an index it fetches a definition
 * when one is needed.
 */
import { sharedIdPrefix as sharedStart, surfaceIndex, type OUIAction, type OUIActionIndexEntry, type OUIObservationIndexEntry, type OUISurface, type OUISurfaceIndex } from 'oui-spec/spec';

import { surfaceRank } from './observations.js';

/** One surface of the page: what it is, what it reports, and its actions in index. */
export interface PageSurface {
  id: string;
  name: string;
  description: string;
  observations?: OUIObservationIndexEntry[];
  index: OUIActionIndexEntry[];
  /** The start its whole catalog's action ids share, as the client declares it (oui-spec §7.3.8). */
  idPrefix?: string;
}

/** An action of the page, with the surface that offers it. */
export interface PageAction {
  surface: PageSurface;
  entry: OUIActionIndexEntry;
}

/** The key a definition is kept under: it is good until the action's definition changes. */
export const definitionKey = (surfaceId: string, entry: Pick<OUIActionIndexEntry, 'id' | 'definitionHash'>): string =>
  `${surfaceId}\u0000${entry.id}\u0000${entry.definitionHash}`;

/** Definitions the worker holds, by `definitionKey`. */
export type HeldDefinitions = Map<string, OUIAction>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function isIndexEntry(value: unknown): value is OUIActionIndexEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.description === 'string' &&
    typeof value.input === 'string' &&
    typeof value.definitionHash === 'string'
  );
}

/** Whether `value` is a surface in index form. */
export function isSurfaceIndex(value: unknown): value is OUISurfaceIndex {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.index) &&
    value.index.every(isIndexEntry)
  );
}

/** Whether `value` is a surface with its actions' definitions. */
export function isFullSurface(value: unknown): value is OUISurface {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.every((a) => isRecord(a) && typeof a.id === 'string' && typeof a.description === 'string')
  );
}

/** The page from surfaces in index form. */
export function pageFromIndex(index: readonly OUISurfaceIndex[]): PageSurface[] {
  return index.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    ...(s.observations ? { observations: s.observations } : {}),
    index: s.index,
    ...(s.idPrefix !== undefined ? { idPrefix: s.idPrefix } : {}),
  }));
}

/**
 * The page from surfaces with definitions (a client on oui-spec 0.6, or one
 * made to send them): the same index a client would have sent, and each
 * definition kept in `held`, so describing an action needs no request.
 */
export function pageFromSurfaces(surfaces: readonly OUISurface[], held: HeldDefinitions): PageSurface[] {
  return surfaces.map((surface) => {
    const indexed = surfaceIndex(surface);
    surface.actions.forEach((action, i) => held.set(definitionKey(surface.id, indexed.index[i]), action));
    return pageFromIndex([indexed])[0];
  });
}

/** Every action of the page. The first surface to offer an action id keeps it. */
export function pageActions(page: readonly PageSurface[]): { actions: PageAction[]; collisions: Array<{ actionId: string; keptSurface: string; droppedSurface: string }> } {
  const owner = new Map<string, string>();
  const actions: PageAction[] = [];
  const collisions: Array<{ actionId: string; keptSurface: string; droppedSurface: string }> = [];
  for (const surface of page) {
    for (const entry of surface.index) {
      const kept = owner.get(entry.id);
      if (kept !== undefined) {
        collisions.push({ actionId: entry.id, keptSurface: kept, droppedSurface: surface.id });
        continue;
      }
      owner.set(entry.id, surface.id);
      actions.push({ surface, entry });
    }
  }
  return { actions, collisions };
}

/**
 * A stable fingerprint of what the page offers: its surface ids and each
 * action's id and definition. Two pages with the same fingerprint offer the
 * model the same index.
 */
export function pageFingerprint(page: readonly PageSurface[]): string {
  return page.map((s) => `${s.id}(${s.index.map((a) => `${a.id}@${a.definitionHash}`).join(',')})`).join('|');
}

/**
 * An index entry's `input` without what the model does not use: a text is its
 * name alone, and a list or object says only that it is one. An enum's first
 * values and a number's range stay. Measured on a long form with a live model:
 * names alone, or a long enum as a count, made it describe twice as often, and
 * a turn cost more than the shorter index saved. The values it sees are what let
 * it act without asking.
 */
export function shortInput(input: string): string {
  if (input.startsWith('one of ') || !input.includes(': ')) return input;
  return input
    .split(', ')
    .map((part) => {
      const at = part.indexOf(': ');
      if (at < 0) return part;
      const name = part.slice(0, at);
      const value = part.slice(at + 2);
      if (value === 'string') return name;
      if (value.startsWith('list of ')) return `${name}: list`;
      if (value.startsWith('object')) return `${name}: object`;
      return part;
    })
    .join(', ');
}

/**
 * One action on a line, as the model reads the index: its id, what it does, and
 * in brackets what it takes and what calling it involves. An index is hundreds
 * of these. No brackets: it takes nothing.
 */
export function indexLine(entry: OUIActionIndexEntry, sharedPrefix = ''): string {
  const notes = [
    entry.input === 'none' ? '' : shortInput(entry.input),
    entry.effect === 'view' ? 'reads' : '',
    entry.effect === 'transaction' || entry.confirm ? 'needs approval' : '',
    entry.async ? `waits for its work${entry.estimatedDuration ? `, ${entry.estimatedDuration}` : ''}` : '',
  ].filter(Boolean);
  return `- ${entry.id.slice(sharedPrefix.length)}: ${entry.description}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/** The longest the page's index is in the model's context, in characters, before surfaces are listed by id only. */
export const DEFAULT_INDEX_CHARS = 60_000;

/**
 * How a surface's heading says its lines leave out the start every one of its
 * action ids shares. The one wording of it: the heading, and every test and
 * measure of the index, read it from here.
 */
export const sharedPrefixNote = (prefix: string): string => `every action id here is ${prefix} + the name its line starts with`;

/**
 * The start a surface's action ids share, that a name its lines give is read through: `vector_studio_`
 * for `vector_studio_add_text` and its 188 siblings. A surface that declares it from its whole catalog
 * (`idPrefix`, oui-spec §7.3.8) has it whenever every action it offers now starts with it and keeps a
 * word of its own, so a name never stops meaning its action as controls show and hide. Otherwise it is
 * taken from the actions offered now (`sharedIdPrefix` of oui-spec). Empty when there is none.
 */
export function sharedIdPrefix(surface: Pick<PageSurface, 'index' | 'idPrefix'>): string {
  const ids = surface.index.map((a) => a.id);
  const declared = surface.idPrefix;
  // Declared: the client knows its whole catalog. An empty start declares there is none.
  if (declared !== undefined) {
    const fits = ids.length > 0 && ids.every((id) => id.startsWith(declared) && id.length > declared.length);
    return fits ? declared : '';
  }
  return sharedStart(ids);
}

/** Whether saying a surface's start once, in its heading, is shorter than repeating it on each of its lines. */
const foldingIsShorter = (prefix: string, lines: number): boolean => prefix.length * lines > sharedPrefixNote(prefix).length + 2;

/**
 * The start each surface's names are read through on the page: its `sharedIdPrefix`, unless a name it
 * would give is the full id of an action on the page. A full id resolves first, so that name would run
 * the other action: such a surface has none. `resolveActionName` reads names through these.
 */
export function resolvablePrefixes(page: readonly PageSurface[]): Map<string, string> {
  const fullIds = new Set(pageActions(page).actions.map((a) => a.entry.id));
  return new Map(
    page.map((s) => {
      const prefix = sharedIdPrefix(s);
      const clashes = prefix !== '' && s.index.some((a) => fullIds.has(a.id.slice(prefix.length)));
      return [s.id, clashes ? '' : prefix];
    }),
  );
}

/**
 * The start each surface's lines leave out in the index: its resolvable start (`resolvablePrefixes`),
 * where saying it once, in the heading, is shorter than repeating it on every line. A surface of a few
 * actions keeps its full ids; a name its lines would give still resolves, so a name the model learned on
 * a page where the surface was folded keeps meaning its action here.
 */
export function foldedPrefixes(page: readonly PageSurface[]): Map<string, string> {
  const resolvable = resolvablePrefixes(page);
  return new Map(
    page.map((s) => {
      const prefix = resolvable.get(s.id) ?? '';
      return [s.id, prefix && foldingIsShorter(prefix, s.index.length) ? prefix : ''];
    }),
  );
}

/** A surface's heading: its name, its id, and the id start its lines leave out. */
function surfaceHeading(s: PageSurface, prefix: string): string {
  return `${s.name} (${s.id}${prefix ? `; ${sharedPrefixNote(prefix)}` : ''}): ${s.description}`;
}

export interface IndexTextOptions {
  /**
   * Fold each surface's shared id start into its heading (`sharedIdPrefix`).
   * Default true: the index in the model's context. False where a line is read
   * on its own, away from its heading (what an answer says the page now offers).
   */
  foldSharedPrefix?: boolean;
}

/**
 * The page's index as the model reads it: each surface, then its actions a
 * line each. A surface whose action ids share a start says it once, in its
 * heading, and its lines give the rest of each id; `resolveActionName` takes
 * either. Past `maxChars`, surfaces are listed by their action ids only, and
 * say so, so every action stays findable: first the frame around every page,
 * then what is shared between pages, then the pages and rooms, the longest
 * mounted first. A client lists its surfaces as they mounted, so what the person
 * opened last, a studio docked on the page they are working in, keeps its lines
 * longest.
 */
export function indexText(page: readonly PageSurface[], maxChars: number = DEFAULT_INDEX_CHARS, options: IndexTextOptions = {}): string {
  const fold = options.foldSharedPrefix ?? true;
  const folded = fold ? foldedPrefixes(page) : new Map<string, string>();
  const full = page.map((s) => {
    const prefix = fold ? (folded.get(s.id) ?? '') : '';
    return { surface: s, prefix, text: [surfaceHeading(s, prefix), ...s.index.map((a) => indexLine(a, prefix))].join('\n') };
  });
  let total = full.reduce((n, s) => n + s.text.length + 2, 0);
  if (total <= maxChars) return full.map((s) => s.text).join('\n\n');
  const shortestFirst = full
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => surfaceRank(b.entry.surface.id, undefined) - surfaceRank(a.entry.surface.id, undefined) || a.at - b.at);
  for (const { entry } of shortestFirst) {
    if (total <= maxChars) break;
    const s = entry.surface;
    const short = [
      surfaceHeading(s, entry.prefix),
      `- ${s.index.length} actions, listed by id only to save room; describe one to learn what it does: ${s.index.map((a) => a.id.slice(entry.prefix.length)).join(', ')}`,
    ].join('\n');
    total += short.length - entry.text.length;
    entry.text = short;
  }
  return full.map((s) => s.text).join('\n\n');
}

/** What a name the model gave stands for on the page: one action's id, several it could mean, or none. */
export type ActionNameResolution = { id: string } | { ambiguous: string[] } | null;

/**
 * The action a name the model gave means, on the page as it is now. An action's
 * id is itself, exactly as it always was. Otherwise the name is read as an index
 * line gives it, the rest of an id after its surface's shared start: it means
 * the one action whose surface folds a start that, with the name, is that
 * action's id. A name more than one surface's start makes an action of is
 * ambiguous, and never resolved: the caller refuses it with the full ids. The
 * one resolver `ui_act`, `ui_describe` and an action called as a tool share.
 */
export function resolveActionName(page: readonly PageSurface[], name: string): ActionNameResolution {
  const { actions } = pageActions(page);
  const owner = new Map(actions.map((a) => [a.entry.id, a.surface]));
  if (owner.has(name)) return { id: name };
  const meant: string[] = [];
  const folded = resolvablePrefixes(page);
  for (const surface of page) {
    const prefix = folded.get(surface.id) ?? '';
    if (!prefix || name.startsWith(prefix)) continue;
    const id = `${prefix}${name}`;
    if (owner.get(id) === surface) meant.push(id);
  }
  if (meant.length === 0) return null;
  return meant.length === 1 ? { id: meant[0] } : { ambiguous: meant };
}

/** What a model is told of a name that stands for several actions: each one's full id, to call it by. */
export function ambiguousNameError(name: string, ids: readonly string[]): string {
  return `"${name}" names an action on more than one part of the page: ${ids.join(', ')}. Call it by its full id.`;
}

/** What an answer changed in what the page offers: the actions added, a line each, and the ids removed. */
export function indexDiff(before: readonly PageSurface[], after: readonly PageSurface[]): { added: string[]; removed: string[] } {
  const was = new Map(pageActions(before).actions.map((a) => [a.entry.id, a.entry.definitionHash]));
  const now = pageActions(after).actions;
  const nowIds = new Set(now.map((a) => a.entry.id));
  return {
    // An action whose definition changed is listed again: what it takes may have.
    added: now.filter((a) => was.get(a.entry.id) !== a.entry.definitionHash).map((a) => indexLine(a.entry)),
    removed: [...was.keys()].filter((id) => !nowIds.has(id)),
  };
}
