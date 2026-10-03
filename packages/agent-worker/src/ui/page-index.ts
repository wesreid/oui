/**
 * The page as the worker holds it: an index of what it offers (ADR-0245 §2.1).
 *
 * A client sends its surfaces in one of two forms (oui-spec §7.3.8): an index
 * of its actions, or every action's definition. The worker works from the
 * index either way. From definitions it derives the same index, and keeps the
 * definitions to describe actions from; from an index it fetches a definition
 * when one is needed.
 */
import { surfaceIndex, type OUIAction, type OUIActionIndexEntry, type OUIObservation, type OUISurface, type OUISurfaceIndex } from 'oui-spec/spec';

/** One surface of the page: what it is, what it reports, and its actions in index. */
export interface PageSurface {
  id: string;
  name: string;
  description: string;
  observations?: OUIObservation[];
  index: OUIActionIndexEntry[];
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
 * One action on a line, as the model reads the index: its id, what it does,
 * what it takes, and what calling it involves.
 */
export function indexLine(entry: OUIActionIndexEntry): string {
  const marks = [
    entry.effect === 'view' ? 'reads' : '',
    entry.effect === 'transaction' || entry.confirm ? 'needs approval' : '',
    entry.async ? `waits for its work${entry.estimatedDuration ? `, ${entry.estimatedDuration}` : ''}` : '',
  ].filter(Boolean);
  const takes = entry.input === 'none' ? 'takes nothing' : `takes ${entry.input}`;
  return `- ${entry.id}: ${entry.description} (${takes}${marks.length ? `; ${marks.join('; ')}` : ''})`;
}

/** The longest the page's index is in the model's context, in characters, before surfaces are listed by name only. */
export const DEFAULT_INDEX_CHARS = 60_000;

/**
 * The page's index as the model reads it: each surface, then its actions a
 * line each. Past `maxChars`, the surfaces furthest from the page (shared
 * chrome before rooms and pages, as `order` gives them) are listed by their
 * action ids only, and say so: every action stays findable.
 */
export function indexText(page: readonly PageSurface[], maxChars: number = DEFAULT_INDEX_CHARS): string {
  const full = page.map((s) => ({
    surface: s,
    text: [`${s.name} (${s.id}): ${s.description}`, ...s.index.map(indexLine)].join('\n'),
  }));
  let total = full.reduce((n, s) => n + s.text.length + 2, 0);
  // Shorten from the end: a client lists the page's own surfaces first.
  for (let i = full.length - 1; i >= 0 && total > maxChars; i--) {
    const s = full[i].surface;
    const short = [
      `${s.name} (${s.id}): ${s.description}`,
      `- ${s.index.length} actions, listed by id only to save room; describe one to learn what it does: ${s.index.map((a) => a.id).join(', ')}`,
    ].join('\n');
    total += short.length - full[i].text.length;
    full[i].text = short;
  }
  return full.map((s) => s.text).join('\n\n');
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
