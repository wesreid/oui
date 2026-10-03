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

/**
 * The largest page state the model is given when the host sets none
 * (`ui.maxObservationChars`): the user's message's, and each UI action's
 * answer's. About 3,000 tokens: room for a document of a hundred rows as index
 * rows with the few being worked on whole (ADR-0244 §2.1). It was 6,000, which
 * a board of six artboards filled.
 */
export const DEFAULT_PAGE_STATE_CHARS = 12_000;

/** Rows past this in any list are given as index rows at the first step of fitting an over-budget page state. */
export const MAX_LIST_ROWS = 20;

/**
 * A list this short is never shortened: it is a field's choices (the engines a
 * voice can speak with, a document's types), not a collection to browse.
 */
export const WHOLE_LIST_ROWS = 5;

/**
 * One step of fitting: how many rows of a long list are kept whole, and how
 * many of the rest are kept as index rows (ADR-0244 §2.1). Rows are cut to
 * their index before any is dropped, so the model can still name every row;
 * only when the index itself does not fit is it shortened, and then it says
 * how the rest are read.
 */
interface ListStep {
  whole: number;
  index: number;
}

const LIST_STEPS: readonly ListStep[] = [
  { whole: MAX_LIST_ROWS, index: Infinity },
  { whole: 10, index: Infinity },
  { whole: WHOLE_LIST_ROWS, index: Infinity },
  { whole: 0, index: Infinity },
  { whole: 0, index: 100 },
  { whole: 0, index: 40 },
  { whole: 0, index: 12 },
  { whole: 0, index: 0 },
];

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

/** The annotation of an observation's schema that declares a list of addressable rows (oui-contract `x-rows`). */
interface RowListDeclaration {
  ref: string;
  title: string;
  index?: readonly string[];
  selection?: string;
}

/** A schema node, as far as fitting reads it. */
interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  'x-rows'?: RowListDeclaration;
}

/** Each surface's observation schemas, by surface id then observation id: where the row lists are declared. */
export type ObservationSchemas = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The observation schemas of a turn's surfaces, for fitting their page state. */
export function observationSchemas(
  surfaces: readonly { id: string; observations?: readonly { id: string; schema?: unknown }[] }[],
): ObservationSchemas {
  return Object.fromEntries(
    surfaces.map((s) => [s.id, Object.fromEntries((s.observations ?? []).map((o) => [o.id, o.schema]))]),
  );
}

/** How a list's rows are indexed and which of them are chosen; null for a list of anything else. */
interface RowShape {
  /** A row cut to what names it. */
  index(row: Record<string, unknown>): Record<string, unknown>;
  chosen(row: unknown): boolean;
  /** How the rows an index leaves out are read. */
  rest: string;
}

/** A page list's row (oui-bindings `PageStateRow`): addressed by its key, called by its title, chosen when its value is true. */
const PAGE_ROW: RowShape = {
  index: (row) => ({ key: row.key, title: row.title }),
  chosen: (row) => row !== null && typeof row === 'object' && (row as { value?: unknown }).value === true,
  rest: 'name a row by its title',
};

const isPageRow = (row: unknown) =>
  row !== null &&
  typeof row === 'object' &&
  typeof (row as { key?: unknown }).key === 'string' &&
  typeof (row as { title?: unknown }).title === 'string';

/** A declared list's rows: addressed and called by the properties it names, chosen when selected or just changed. */
function declaredShape(declaration: RowListDeclaration, chosenRefs: ReadonlySet<string>): RowShape {
  const kept = [declaration.ref, declaration.title, ...(declaration.index ?? [])];
  return {
    index: (row) => Object.fromEntries(kept.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])),
    chosen: (row) =>
      row !== null && typeof row === 'object' && chosenRefs.has(String((row as Record<string, unknown>)[declaration.ref])),
    rest: 'read them with this surface’s query tool, or one with its inspect tool',
  };
}

/** A row the person has chosen (a selected card, the variant in use): kept however short its list gets. */
const isChosenValue = PAGE_ROW.chosen;

/**
 * A list fitted to a step: the first `whole` rows and the chosen ones whole,
 * up to `index` of the rest as index rows, and how many are left out with how
 * to read them. A list whose rows cannot be indexed keeps only how many more
 * there are.
 */
function shortenRows(rows: unknown[], step: ListStep, shape: RowShape | null): unknown[] {
  if (rows.length <= Math.max(step.whole, WHOLE_LIST_ROWS)) return rows;
  const chosen = shape?.chosen ?? isChosenValue;
  const whole: unknown[] = [];
  const rest: unknown[] = [];
  rows.forEach((row, i) => (i < step.whole || chosen(row) ? whole : rest).push(row));
  if (!shape) {
    if (step.whole === 0) {
      const count = `${rest.length}${whole.length ? ' more' : ''} rows`;
      return [...whole, `${count}, not listed to fit the page state; name a row by its title`];
    }
    return [...whole, `… and ${rest.length} more`];
  }
  const indexed = rest.slice(0, step.index).map((row) => shape.index(row as Record<string, unknown>));
  const left = rest.length - indexed.length;
  if (left === 0) return [...whole, ...indexed];
  const count = whole.length + indexed.length > 0 ? `… and ${left} more rows` : `${left} rows`;
  return [...whole, ...indexed, `${count}, not listed to fit the page state; ${shape.rest}`];
}

/**
 * What the page shows (`shown`): facts that describe one row of a list (one per
 * card) are shortened like the list; the page's own facts, such as those of the
 * item open in a detail panel, are kept whole.
 */
function shortenShown(shown: unknown[], step: ListStep): unknown[] {
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
  return [...own, ...[...perList.values()].flatMap((rows) => shortenRows(rows, { whole: step.whole, index: 0 }, null))];
}

/** What fitting a value needs beside the step: its schema, and the rows an action just changed. */
interface FitContext {
  step: ListStep;
  changed: ReadonlySet<string>;
}

/** How a list's rows are indexed: as its schema declares, as a page list's rows are, or not at all. */
function shapeOf(rows: unknown[], schema: SchemaNode | undefined, selected: readonly string[], ctx: FitContext): RowShape | null {
  const declaration = schema?.['x-rows'];
  if (declaration) return declaredShape(declaration, new Set([...selected, ...ctx.changed]));
  return rows.length > 0 && rows.every(isPageRow) ? PAGE_ROW : null;
}

/**
 * The value with every long list fitted to the step (see shortenRows); fields,
 * what is unavailable or busy, and the page's own facts are left whole.
 */
function compactValue(value: unknown, schema: SchemaNode | undefined, ctx: FitContext, selected: readonly string[] = []): unknown {
  if (Array.isArray(value)) {
    const shape = shapeOf(value, schema, selected, ctx);
    // A row kept whole has its own lists fitted; a row cut to its index does not need them.
    const given = new Set(value);
    return shortenRows(value, ctx.step, shape).map((row) => (given.has(row) ? compactValue(row, schema?.items, ctx) : row));
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object).map(([key, v]) => {
        if (FIELD_KEYS.has(key)) return [key, v];
        if (key === 'shown' && Array.isArray(v)) return [key, shortenShown(v, ctx.step)];
        const child = schema?.properties?.[key];
        const selection = child?.['x-rows']?.selection;
        const chosen = selection && Array.isArray(object[selection]) ? (object[selection] as unknown[]).map(String) : [];
        return [key, compactValue(v, child, ctx, chosen)];
      }),
    );
  }
  return value;
}

interface Fitted {
  values: Record<string, unknown>;
  /** The last step used on the surfaces other than the acting one, when lists were shortened. */
  listStep?: ListStep;
  /** Surfaces left out to fit, least important first. */
  omitted: string[];
  fits: boolean;
}

const size = (value: unknown) => JSON.stringify(value).length;

/** What fitting reads beside the observations: where the row lists are declared, and the rows an action just changed. */
export interface FitOptions {
  schemas?: ObservationSchemas;
  /** Refs of the rows the answered action changed: kept whole, like the selection. */
  changed?: readonly string[];
}

/**
 * The page state over budget, fitted step by step, cutting the least important
 * first. The surfaces are ordered by rank. Then long lists are shortened: 20
 * rows kept whole, then 10, 5, then none, the rest cut to index rows (what
 * each is addressed and called by); then the index itself, to 100 rows, 40, 12
 * and none, saying how the rest are read. Every other surface is a step ahead of
 * the surface the action acted on. Lists of five rows or fewer, every field,
 * what is unavailable or busy, the page's own facts and chosen rows are never
 * shortened, so the item open in a detail panel and the layer just changed
 * stay whole beside a long list. Then whole surfaces are left out, the shells
 * first, never the acting one. Only if that still does not fit is the rest cut.
 */
function fitted(
  observations: OUIObservationSnapshot,
  maxChars: number,
  acting: string | undefined,
  options: FitOptions,
): Fitted {
  const base = Object.fromEntries(
    Object.entries(withoutKeptWhole(observations)).sort(([a], [b]) => surfaceRank(a, acting) - surfaceRank(b, acting)),
  ) as Record<string, unknown>;
  const actingPresent = acting !== undefined && acting in base;
  const changed = new Set(options.changed ?? []);

  // Each step is (others' step, the acting surface's step): the acting one lags a step behind.
  const steps: Array<[ListStep, ListStep]> = [];
  LIST_STEPS.forEach((step, i) => {
    if (actingPresent && i > 0) steps.push([step, LIST_STEPS[i - 1]]);
    steps.push([step, step]);
  });

  const fit = (surfaceId: string, value: unknown, step: ListStep) =>
    Object.fromEntries(
      Object.entries((value ?? {}) as Record<string, unknown>).map(([observationId, v]) => [
        observationId,
        compactValue(v, options.schemas?.[surfaceId]?.[observationId] as SchemaNode | undefined, { step, changed }),
      ]),
    );

  let values = base;
  let listStep: ListStep | undefined;
  for (const [others, own] of steps) {
    values = Object.fromEntries(Object.entries(base).map(([id, v]) => [id, fit(id, v, id === acting ? own : others)]));
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
  const step = fit.listStep;
  const lists =
    step === undefined
      ? ''
      : step.whole > 0
      ? `long lists keep their first ${Math.max(step.whole, WHOLE_LIST_ROWS)} rows whole and the rest as index rows (what each is addressed and called by)`
      : step.index > 0
      ? `rows of lists longer than ${WHOLE_LIST_ROWS} are given as index rows (what each is addressed and called by)${
          Number.isFinite(step.index) ? `, the first ${step.index} of them` : ''
        }`
      : `lists longer than ${WHOLE_LIST_ROWS} rows are given as a count, with how to read them`;
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
 * fitted (see fitted): long lists cut to index rows first, the page it acted on
 * first and kept whole, and only if that still does not fit is the rest cut, saying so.
 */
export function boundObservations(
  observations: OUIObservationSnapshot,
  maxChars: number,
  actingSurfaceId?: string,
  options: FitOptions = {},
): unknown {
  const json = JSON.stringify(observations);
  if (json.length <= maxChars) return observations;
  const problems = surfaceProblems(observations);
  const jobs = jobStatuses(observations);
  const fit = fitted(observations, maxChars, actingSurfaceId, options);
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
export function observationsText(observations: OUIObservationSnapshot, maxChars: number, options: FitOptions = {}): string {
  const json = JSON.stringify(observations);
  if (json.length <= maxChars) return json;
  const problems = surfaceProblems(observations);
  const jobs = jobStatuses(observations);
  const fit = fitted(observations, maxChars, undefined, options);
  const rest = JSON.stringify(fit.values);
  const head =
    (problems ? `Problems (in full): ${JSON.stringify(problems)}\n` : '') +
    (jobs ? `Jobs (in full): ${JSON.stringify(jobs)}\n` : '');
  const tail = fit.fits
    ? ` (fitted from ${json.length} characters. ${fitSummary(fit, maxChars, [], false)})`
    : `… (truncated from ${json.length} characters)`;
  return `${head}${head ? 'Values: ' : ''}${rest.slice(0, maxChars)}${tail}`;
}
