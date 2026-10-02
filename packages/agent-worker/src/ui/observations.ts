/**
 * Page state within the model's budget, problems first (ADR-0167).
 *
 * A surface may publish a `problems` observation: what its page cannot draw,
 * load or read — a face it does not have and the text it therefore hides, an
 * asset that failed, what an import could not reproduce. Those are exactly
 * what the model must not miss before it tells the user a result, so when the
 * page state is over budget they are kept whole and only the rest is cut. So
 * are the statuses of the jobs the page follows: whether what an action
 * started has finished is how the model knows it may say so.
 */

import type { OUIObservationSnapshot } from 'oui-spec/spec';

/** The observation id a surface reports its page's problems under. */
export const PROBLEMS_OBSERVATION_ID = 'problems';

/** Every surface's non-empty `problems`, by surface id; null when none reports any. */
export function surfaceProblems(observations: OUIObservationSnapshot): Record<string, unknown> | null {
  const found: Record<string, unknown> = {};
  for (const [surface, values] of Object.entries(observations)) {
    const problems = values?.[PROBLEMS_OBSERVATION_ID];
    if (Array.isArray(problems) ? problems.length > 0 : problems !== undefined && problems !== null) {
      found[surface] = problems;
    }
  }
  return Object.keys(found).length > 0 ? found : null;
}

/**
 * Every job an action started that the page is following: each surface's
 * `<surface>:<action>:status` observations (started, running, complete with
 * what it made, failed with why), by surface id; null when there are none.
 * The model is told an action like Generate is done only through these, so
 * they must reach it whatever else the page reports.
 */
export function jobStatuses(observations: OUIObservationSnapshot): Record<string, Record<string, unknown>> | null {
  const found: Record<string, Record<string, unknown>> = {};
  for (const [surface, values] of Object.entries(observations)) {
    for (const [id, value] of Object.entries(values ?? {})) {
      if (!isJobStatus(id)) continue;
      (found[surface] ??= {})[id] = value;
    }
  }
  return Object.keys(found).length > 0 ? found : null;
}

const isJobStatus = (observationId: string) => observationId.endsWith(':status');

/** The observations without what is reported whole beside them: problems and job statuses. */
function withoutKeptWhole(observations: OUIObservationSnapshot): OUIObservationSnapshot {
  return Object.fromEntries(
    Object.entries(observations).map(([surface, values]) => [
      surface,
      Object.fromEntries(
        Object.entries(values ?? {}).filter(([id]) => id !== PROBLEMS_OBSERVATION_ID && !isJobStatus(id)),
      ),
    ]),
  );
}

/** Rows past this in any list are summed up as "… and N more" at the first step of fitting an over-budget page state. */
export const MAX_LIST_ROWS = 20;

/**
 * A list this short is never shortened: it is a field's choices (the engines a
 * voice can speak with, a document's types), not a collection to browse.
 */
export const WHOLE_LIST_ROWS = 5;

/** How far long lists are shortened, step by step; 0 gives only how many rows there are. */
const LIST_STEPS = [MAX_LIST_ROWS, 10, WHOLE_LIST_ROWS, 0] as const;

/**
 * What a page state reports that is never shortened: its fields, what is
 * unavailable or busy, and a row's own schema (its options or range).
 */
const FIELD_KEYS = new Set(['values', 'unavailable', 'busy', 'schema']);

/**
 * Where a surface comes in the page state over budget: the surface the action
 * acted on, then the pages and rooms, then shared parts of them, then anything
 * else, and the shells (the chrome around every page: accounts, projects,
 * navigation) last. A long project list in the shell must never crowd out the
 * page the model is working on.
 */
function surfaceRank(surfaceId: string, acting: string | undefined): number {
  if (acting !== undefined && surfaceId === acting) return 0;
  if (surfaceId.startsWith('page:') || surfaceId.startsWith('room:')) return 1;
  if (surfaceId.startsWith('shared:')) return 2;
  if (surfaceId.startsWith('shell:') || surfaceId === 'app-shell') return 4;
  return 3;
}

/** A row the person has chosen (a selected card, the variant in use): kept however short its list gets. */
const isChosen = (row: unknown) =>
  row !== null && typeof row === 'object' && (row as { value?: unknown }).value === true;

/** A list shortened to `limit` rows plus the chosen ones and how many more; only a count at 0. */
function shortenRows(rows: unknown[], limit: number): unknown[] {
  if (rows.length <= Math.max(limit, WHOLE_LIST_ROWS)) return rows;
  if (limit === 0) {
    const chosen = rows.filter(isChosen);
    const count = `${rows.length - chosen.length}${chosen.length ? ' more' : ''} rows`;
    return [...chosen, `${count}, not listed to fit the page state; name a row by its title`];
  }
  const kept = rows.slice(0, limit);
  const chosen = rows.slice(limit).filter(isChosen);
  return [...kept, ...chosen, `… and ${rows.length - kept.length - chosen.length} more`];
}

/**
 * What the page shows (`shown`): facts that describe one row of a list (one per
 * card) are shortened like the list; the page's own facts, such as those of the
 * item open in a detail panel, are kept whole.
 */
function shortenShown(shown: unknown[], limit: number): unknown[] {
  const perList = new Map<string, unknown[]>();
  const own: unknown[] = [];
  for (const entry of shown) {
    const item = (entry as { item?: unknown; id?: unknown } | null)?.item;
    if (item === undefined) own.push(entry);
    else {
      const id = String((entry as { id?: unknown }).id);
      perList.set(id, [...(perList.get(id) ?? []), entry]);
    }
  }
  return [...own, ...[...perList.values()].flatMap((rows) => shortenRows(rows, limit))];
}

/**
 * The value with every long list shortened to `limit` (see shortenRows); fields,
 * what is unavailable or busy, and the page's own facts are left whole.
 */
function compactValue(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) {
    const rows = value.map((v) => compactValue(v, limit));
    return shortenRows(rows, limit);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (FIELD_KEYS.has(key)) return [key, v];
        if (key === 'shown' && Array.isArray(v)) return [key, shortenShown(v, limit)];
        return [key, compactValue(v, limit)];
      }),
    );
  }
  return value;
}

interface Fitted {
  values: Record<string, unknown>;
  /** The shortest list step used on any surface, when lists were shortened. */
  listStep?: number;
  /** Surfaces left out to fit, least important first. */
  omitted: string[];
  fits: boolean;
}

const size = (value: unknown) => JSON.stringify(value).length;

/**
 * The page state over budget, fitted step by step, cutting the least important
 * first. The surfaces are ordered by rank. Then long lists are shortened (20
 * rows, 10, 5, then only a count), on every other surface a step before the
 * surface the action acted on. Lists of five rows or fewer, every field, what is
 * unavailable or busy, the page's own facts and chosen rows are never shortened,
 * so the item open in a detail panel stays whole beside a long list. Then whole
 * surfaces are left out, the shells first, never the acting one. Only if that
 * still does not fit is the rest cut.
 */
function fitted(observations: OUIObservationSnapshot, maxChars: number, acting: string | undefined): Fitted {
  const base = Object.fromEntries(
    Object.entries(withoutKeptWhole(observations)).sort(([a], [b]) => surfaceRank(a, acting) - surfaceRank(b, acting)),
  ) as Record<string, unknown>;
  const actingPresent = acting !== undefined && acting in base;

  // Each step is (others' limit, the acting surface's limit): the acting one lags a step behind.
  const steps: Array<[number, number]> = [];
  LIST_STEPS.forEach((limit, i) => {
    if (actingPresent && i > 0) steps.push([limit, LIST_STEPS[i - 1]]);
    steps.push([limit, limit]);
  });

  let values = base;
  let listStep: number | undefined;
  for (const [others, own] of steps) {
    values = Object.fromEntries(
      Object.entries(base).map(([id, v]) => [id, compactValue(v, id === acting ? own : others)]),
    );
    listStep = others;
    if (size(values) <= maxChars) return { values, listStep, omitted: [], fits: true };
  }

  const omitted: string[] = [];
  const droppable = Object.keys(values)
    .filter((id) => id !== acting)
    .sort((a, b) => surfaceRank(b, acting) - surfaceRank(a, acting) || size(values[b]) - size(values[a]));
  for (const id of droppable) {
    if (Object.keys(values).length <= 1) break;
    values = Object.fromEntries(Object.entries(values).filter(([key]) => key !== id));
    omitted.push(id);
    if (size(values) <= maxChars) return { values, listStep, omitted, fits: true };
  }
  return { values, listStep, omitted, fits: false };
}

/** What fitting did, in words. */
function fitSummary(fit: Fitted, maxChars: number, whole: string[], acted: boolean): string {
  const lists =
    fit.listStep === undefined
      ? ''
      : fit.listStep === 0
      ? `lists longer than ${WHOLE_LIST_ROWS} rows are given as a count`
      : `long lists are shortened, to as few as ${Math.max(fit.listStep, WHOLE_LIST_ROWS)} rows, with how many more`;
  const parts = [
    lists,
    'fields, the page’s own facts and chosen rows are kept whole',
    acted ? 'the page you acted on comes first' : 'the pages come first and the shells last',
    fit.omitted.length ? `left out to fit: ${fit.omitted.join(', ')}` : '',
    fit.fits ? '' : `showing the first ${maxChars} characters`,
    whole.length ? `with ${whole.join(' and ')} in full` : '',
  ].filter(Boolean);
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The observations as the model receives them: whole when they fit. Over
 * budget, every surface's problems and job statuses are kept whole; the rest is
 * fitted (see fitted): long lists shortened first, the page it acted on first
 * and kept whole, and only if that still does not fit is the rest cut, saying so.
 */
export function boundObservations(
  observations: OUIObservationSnapshot,
  maxChars: number,
  actingSurfaceId?: string,
): unknown {
  const json = JSON.stringify(observations);
  if (json.length <= maxChars) return observations;
  const problems = surfaceProblems(observations);
  const jobs = jobStatuses(observations);
  const fit = fitted(observations, maxChars, actingSurfaceId);
  const whole = [problems ? 'every surface’s problems' : '', jobs ? 'every job’s status' : ''].filter(Boolean);
  return {
    truncated: true,
    note: `Page state is ${json.length} characters. ${fitSummary(fit, maxChars, whole, actingSurfaceId !== undefined)}`,
    ...(problems ? { problems } : {}),
    ...(jobs ? { jobs } : {}),
    ...(fit.fits ? { values: fit.values } : { preview: JSON.stringify(fit.values).slice(0, maxChars) }),
  };
}

/** The same, as the text of a `<page_state>` block. */
export function observationsText(observations: OUIObservationSnapshot, maxChars: number): string {
  const json = JSON.stringify(observations);
  if (json.length <= maxChars) return json;
  const problems = surfaceProblems(observations);
  const jobs = jobStatuses(observations);
  const fit = fitted(observations, maxChars, undefined);
  const rest = JSON.stringify(fit.values);
  const head =
    (problems ? `Problems (in full): ${JSON.stringify(problems)}\n` : '') +
    (jobs ? `Jobs (in full): ${JSON.stringify(jobs)}\n` : '');
  const tail = fit.fits
    ? ` (fitted from ${json.length} characters. ${fitSummary(fit, maxChars, [], false)})`
    : `… (truncated from ${json.length} characters)`;
  return `${head}${head ? 'Values: ' : ''}${rest.slice(0, maxChars)}${tail}`;
}
