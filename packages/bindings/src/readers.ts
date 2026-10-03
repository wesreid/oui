/**
 * A room's readers (ADR-0244 §2.2): how the assistant reads what the room
 * holds, built from the room's own declaration of its lists so they can never
 * fall behind it.
 *
 * A room declares each list of things its actions address — a document's
 * layers, its artboards — once: how a row is addressed and called, what its
 * rows are now, and everything about one row. From that come
 *
 * - the `x-rows` annotation of the list in the room's observation, so a list
 *   too long for the page state keeps an index of every row (§2.1);
 * - `inspect`, which returns everything about the rows it is given;
 * - `query`, which lists a list's rows, filtered, a page at a time;
 * - the resolution of a row's title wherever an action takes its id (`x-ref`);
 * - the rows an edit changed, as its result reports them (§2.5).
 *
 * Plain TypeScript: no React, no OUI runtime.
 */

import type { JsonSchema, RoomChangedRow, RowList } from '@ouispec/contract';

import type { RoomAction, RoomResult } from './room.js';

export type { RoomChangedRow, RowList } from '@ouispec/contract';

/** The ids of a room's two readers, built from its lists. A room with lists declares both. */
export const ROOM_INSPECT_ID = 'inspect';
export const ROOM_QUERY_ID = 'query';

/** How many rows one `inspect` returns everything about. */
export const MAX_INSPECTED_ROWS = 20;
/** How many rows one `query` lists, and how many it lists when not told. */
export const MAX_QUERY_ROWS = 200;
export const DEFAULT_QUERY_ROWS = 50;

/** One row of a list, as a reader returns it: at least what addresses it and what it is called. */
export type RoomRow = Readonly<Record<string, unknown>>;

/** One list of things a room's actions address. `Ctx` is the room's runtime. */
export interface RoomList<Ctx> {
  /** `<observation id>/<list property>` (or `<observation id>` when the observation is the list): where the list is in what the room reports, and what `x-ref` names. */
  id: string;
  /** What the room calls its rows: "Layers", "Artboards". */
  title: string;
  /** How a row is addressed, called and indexed (the list's `x-rows`). */
  rows: RowList;
  /** Every row now, in the list's order, each as the observation reports it. */
  list(ctx: Ctx): readonly RoomRow[];
  /** Everything about one row: all its panels show. Undefined when there is no such row. */
  detail(ctx: Ctx, ref: string): Record<string, unknown> | undefined;
}

const ok = (data: Record<string, unknown>): RoomResult => ({ ok: true, data });
const fail = (code: string, message: string): RoomResult => ({ ok: false, code, message });

const refOf = (list: Pick<RoomList<unknown>, 'rows'>, row: RoomRow) => String(row[list.rows.ref]);
const titleOf = (list: Pick<RoomList<unknown>, 'rows'>, row: RoomRow) => String(row[list.rows.title] ?? '');

/** A row cut to its index: what addresses it, what it is called, and what tells rows apart. */
export function indexRow(rows: RowList, row: RoomRow): Record<string, unknown> {
  const kept = [rows.ref, rows.title, ...(rows.index ?? [])];
  return Object.fromEntries(kept.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

/** The `x-ref` of an input that addresses rows of these lists. */
export function refTo(...lists: readonly Pick<RoomList<never>, 'id'>[]): { 'x-ref': readonly string[] } {
  return { 'x-ref': lists.map(l => l.id) };
}

/** A row addressed by a ref or a title, among the rows of several lists. */
export interface RowLookup {
  /** The list ids, in the order they are searched. */
  lists: readonly string[];
  /** A list's rows now, each with what addresses it and what it is called. */
  rows(listId: string): readonly { ref: string; title: string }[];
}

/**
 * What a given string addresses: the row with that ref, else the one row
 * whose title it is, exactly (case and outer spaces aside). `null` when it is
 * neither, so the action's own check says what is missing; an error when
 * several rows share the title.
 */
export function resolveRef(given: string, lookup: RowLookup, among: readonly string[]): { ref: string } | { error: RoomResult } | null {
  const lists = among.filter(id => lookup.lists.includes(id));
  for (const id of lists) if (lookup.rows(id).some(r => r.ref === given)) return { ref: given };
  const wanted = given.trim().toLowerCase();
  if (!wanted) return null;
  const titled = lists.flatMap(id => lookup.rows(id).filter(r => r.title.trim().toLowerCase() === wanted));
  if (titled.length === 1) return { ref: titled[0].ref };
  if (titled.length === 0) return null;
  return {
    error: fail(
      'AMBIGUOUS_REF',
      `${titled.length} things are called "${given}": give the id of the one meant — ${titled
        .slice(0, 30)
        .map(r => r.ref)
        .join(', ')}${titled.length > 30 ? ', …' : ''}. The query tool tells them apart.`,
    ),
  };
}

/**
 * An action's input with every title given where a row is addressed replaced
 * by the row's ref (the inputs its schema marks `x-ref`), or why one cannot
 * be: several rows share the title. A string that is neither a ref nor a
 * title is left as given.
 */
export function resolveInputRefs(
  schema: JsonSchema | undefined,
  input: unknown,
  lookup: RowLookup,
): { input: unknown } | { error: RoomResult } {
  if (!schema || input === undefined || input === null) return { input };
  const among = schema['x-ref'];
  if (among && typeof input === 'string') {
    const found = resolveRef(input, lookup, among);
    if (found && 'error' in found) return found;
    return { input: found ? found.ref : input };
  }
  if (Array.isArray(input)) {
    const items = among && !schema.items ? { 'x-ref': among } : schema.items && among ? { ...schema.items, 'x-ref': among } : schema.items;
    const out: unknown[] = [];
    for (const item of input) {
      const resolved = resolveInputRefs(items, item, lookup);
      if ('error' in resolved) return resolved;
      out.push(resolved.input);
    }
    return { input: out };
  }
  if (typeof input === 'object' && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const resolved = resolveInputRefs(schema.properties[key], value, lookup);
      if ('error' in resolved) return resolved;
      out[key] = resolved.input;
    }
    return { input: out };
  }
  return { input };
}

/** Whether a schema, anywhere in it, addresses rows (`x-ref`). */
export function addressesRows(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema['x-ref']) return true;
  if (schema.items && addressesRows(schema.items)) return true;
  return Object.values(schema.properties ?? {}).some(addressesRows);
}

/** The lookup over a room's lists, read from the room as it is now. */
export function listLookup<Ctx>(lists: readonly RoomList<Ctx>[], ctx: Ctx): RowLookup {
  return {
    lists: lists.map(l => l.id),
    rows: id => {
      const list = lists.find(l => l.id === id);
      return list ? list.list(ctx).map(row => ({ ref: refOf(list, row), title: titleOf(list, row) })) : [];
    },
  };
}

/**
 * The arrays an observation's schema holds that could be lists of rows: the
 * observation itself when it is an array (named by the observation's id), and
 * each array among its properties (named `<observation id>/<property>`).
 */
function arraysOf(observation: { id: string; schema: JsonSchema }): { id: string; property: string | null; schema: JsonSchema }[] {
  const own = observation.schema.type === 'array' ? [{ id: observation.id, property: null, schema: observation.schema }] : [];
  const held = Object.entries(observation.schema.properties ?? {})
    .filter(([, schema]) => schema.type === 'array')
    .map(([property, schema]) => ({ id: `${observation.id}/${property}`, property, schema }));
  return [...own, ...held];
}

/**
 * The lookup over the lists a surface's observation schemas declare
 * (`x-rows`), read from the observation values the page last reported.
 */
export function observationLookup(
  observations: readonly { id: string; schema: JsonSchema }[],
  values: Readonly<Record<string, unknown>>,
): RowLookup {
  const lists = new Map<string, () => { ref: string; title: string }[]>();
  for (const observation of observations) {
    for (const { id, property, schema } of arraysOf(observation)) {
      const rows = schema['x-rows'];
      if (!rows) continue;
      lists.set(id, () => {
        const reported = values[observation.id];
        const value = property === null ? reported : (reported as Record<string, unknown> | undefined)?.[property];
        return Array.isArray(value)
          ? value
              .filter((row): row is RoomRow => row !== null && typeof row === 'object')
              .map(row => ({ ref: String(row[rows.ref]), title: String(row[rows.title] ?? '') }))
          : [];
      });
    }
  }
  return { lists: [...lists.keys()], rows: id => lists.get(id)?.() ?? [] };
}

/** The rows of a room result's `changed`: each list's rows among `refs`, as its reader reports them now. */
export function changedRows<Ctx>(lists: readonly RoomList<Ctx>[], ctx: Ctx, refs: Iterable<string>): RoomChangedRow[] {
  const wanted = [...new Set(refs)];
  const present = new Map(lists.map(list => [list, new Set(list.list(ctx).map(row => refOf(list, row)))]));
  return wanted.flatMap(ref => {
    const list = lists.find(l => present.get(l)!.has(ref));
    if (!list) return [];
    const detail = list.detail(ctx, ref);
    return [{ list: list.id, ref, ...(detail ? { detail } : {}) }];
  });
}

interface QueryInput {
  list: string;
  where?: Record<string, unknown>;
  title_contains?: string;
  fields?: string[];
  after?: string;
  limit?: number;
}

/**
 * The room's two readers, built from its lists. Both only read: they change
 * nothing, select nothing and make no undo step.
 */
export function roomReaders<Ctx>(room: { title: string }, lists: readonly RoomList<Ctx>[]): RoomAction<Ctx, never>[] {
  const named = lists.map(l => `${l.id} (${l.title.toLowerCase()})`).join(', ');
  const byId = new Map(lists.map(l => [l.id, l]));

  const inspect: RoomAction<Ctx, { refs: string[] }> = {
    kind: 'action',
    id: ROOM_INSPECT_ID,
    title: 'Inspect',
    description:
      `Reads everything the ${room.title} holds about the things named — all that its panels show for each, as it is now — ` +
      `without changing or selecting anything. Give each by its id, or by its exact name when only one thing has it. ` +
      `Its lists: ${named}. Use it to find out what something is before changing it, and to check an edit did what was meant.`,
    control: 'Selecting the thing and reading its panels',
    effect: 'view',
    input: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_INSPECTED_ROWS,
          description: `Up to ${MAX_INSPECTED_ROWS} ids (or exact names)`,
          ...refTo(...lists),
        },
      },
      required: ['refs'],
      additionalProperties: false,
    },
    run: (ctx, input) => {
      // A name is as good as an id here, whoever calls: the adapter resolves names for every action, and so does this.
      const lookup = listLookup(lists, ctx);
      const refs: string[] = [];
      for (const given of input.refs) {
        const resolved = resolveRef(given, lookup, lookup.lists);
        if (resolved && 'error' in resolved) return resolved.error;
        refs.push(resolved ? resolved.ref : given);
      }
      const items = changedRows(lists, ctx, refs);
      const found = new Set(items.map(i => i.ref));
      const missing = refs.filter(ref => !found.has(ref));
      if (items.length === 0) {
        return fail(
          'NO_SUCH_ROW',
          `Nothing in the ${room.title} has the id or the name ${missing.map(m => `"${m}"`).join(', ')}. ` +
            `List what there is with the query tool.`,
        );
      }
      return ok({ items, ...(missing.length ? { missing } : {}) });
    },
  };

  const query: RoomAction<Ctx, QueryInput> = {
    kind: 'action',
    id: ROOM_QUERY_ID,
    title: 'Query',
    description:
      `Lists the rows of one of the ${room.title}’s lists — ${named} — each with its id, its name and what tells rows apart, ` +
      `without changing or selecting anything. Narrow it with \`where\` (a row property and the value it must have) and ` +
      `\`title_contains\`; ask for more of each row with \`fields\`; read on from where a page ended with \`after\`. ` +
      `Use it to find a thing by its name or by what it is on, however large the document is.`,
    control: 'Reading the room’s lists (its Layers panel)',
    effect: 'view',
    input: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: lists.map(l => l.id), description: lists.map(l => `${l.id} = ${l.title}`).join('; ') },
        where: {
          type: 'object',
          description:
            'Row properties and the value each must have, of those a row is indexed by: ' +
            lists.map(l => `${l.id}: ${[l.rows.ref, l.rows.title, ...(l.rows.index ?? [])].join(', ')}`).join('; '),
          additionalProperties: true,
        },
        title_contains: { type: 'string', description: 'Only rows whose name contains this, whatever its case' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'More of each row than its index: properties of what inspect returns for it',
        },
        after: { type: 'string', description: 'The id of the last row of the page before: the rows after it are listed' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY_ROWS, description: `How many rows; ${DEFAULT_QUERY_ROWS} when not given` },
      },
      required: ['list'],
      additionalProperties: false,
    },
    run: (ctx, input) => {
      const list = byId.get(input.list);
      if (!list) return fail('NO_SUCH_LIST', `The ${room.title} has no list "${input.list}": its lists are ${named}`);
      const indexed = new Set([list.rows.ref, list.rows.title, ...(list.rows.index ?? [])]);
      const unknown = Object.keys(input.where ?? {}).filter(key => !indexed.has(key));
      if (unknown.length > 0) {
        return fail(
          'NOT_INDEXED',
          `${list.title} cannot be narrowed by ${unknown.join(', ')}: a row is indexed by ${[...indexed].join(', ')}`,
        );
      }
      const contains = input.title_contains?.trim().toLowerCase();
      const matching = list.list(ctx).filter(
        row =>
          Object.entries(input.where ?? {}).every(([key, value]) => row[key] === value) &&
          (!contains || titleOf(list, row).toLowerCase().includes(contains)),
      );
      let from = 0;
      if (input.after !== undefined) {
        const at = matching.findIndex(row => refOf(list, row) === input.after);
        if (at === -1) return fail('NO_SUCH_ROW', `No row "${input.after}" among those listed: \`after\` is the id of a row of the page before`);
        from = at + 1;
      }
      const page = matching.slice(from, from + (input.limit ?? DEFAULT_QUERY_ROWS));
      const rows = page.map(row => {
        const index = indexRow(list.rows, row);
        if (!input.fields?.length) return index;
        const detail = list.detail(ctx, refOf(list, row)) ?? {};
        return { ...index, ...Object.fromEntries(input.fields.filter(f => detail[f] !== undefined).map(f => [f, detail[f]])) };
      });
      const left = matching.length - from - page.length;
      return ok({
        list: list.id,
        total: matching.length,
        rows,
        ...(left > 0 ? { more: left, after: refOf(list, page[page.length - 1]) } : {}),
      });
    },
  };

  return [inspect, query] as unknown as RoomAction<Ctx, never>[];
}

/** A catalog as far as its lists are checked: its actions' inputs and its observations' schemas. */
interface ListedCatalog {
  room: string;
  actions: readonly { id: string; input: JsonSchema }[];
  observations: readonly { id: string; schema: JsonSchema }[];
}

/** The lists a catalog's observations declare (`x-rows`), as `<observation id>/<property>`. */
export function declaredLists(catalog: Pick<ListedCatalog, 'observations'>): string[] {
  return catalog.observations.flatMap(o => arraysOf(o).filter(list => list.schema['x-rows']).map(list => list.id));
}

/** Every `x-ref` a schema holds, with where it is. */
function refsIn(schema: JsonSchema | undefined, path: string): { path: string; lists: readonly string[] }[] {
  if (!schema) return [];
  return [
    ...(schema['x-ref'] ? [{ path, lists: schema['x-ref'] }] : []),
    ...refsIn(schema.items, `${path}[]`),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, value]) => refsIn(value, path ? `${path}.${key}` : key)),
  ];
}

/**
 * What is wrong with how a catalog declares its lists (ADR-0244 §2.2), in
 * words: a list of things with ids that does not say how its rows are
 * addressed, lists with no readers, and an input that addresses a list the
 * room does not have. A generator fails on any of them, and the conformance
 * kit checks them, so a room cannot ship rows the assistant cannot read.
 */
export function roomListProblems(catalog: ListedCatalog): string[] {
  const problems: string[] = [];
  const lists = new Set(declaredLists(catalog));
  for (const observation of catalog.observations) {
    for (const { id, property, schema } of arraysOf(observation)) {
      const rows = schema['x-rows'];
      if (!rows) {
        if (schema.items?.properties?.id !== undefined) {
          problems.push(
            `${catalog.room}’s list ${id} holds things with an id, but does not declare how its rows are addressed and called ` +
              `(x-rows): a list too long for the page state would be cut to a count`,
          );
        }
        continue;
      }
      const row = schema.items?.properties ?? {};
      for (const key of [rows.ref, rows.title, ...(rows.index ?? [])]) {
        if (!(key in row)) problems.push(`${catalog.room}’s list ${id} indexes rows by ${key}, which a row does not have`);
      }
      if (rows.selection && (property === null || !(rows.selection in (observation.schema.properties ?? {})))) {
        problems.push(`${catalog.room}’s list ${id} names ${rows.selection} as its selection, which the observation does not report beside it`);
      }
    }
  }
  if (lists.size > 0) {
    const ids = new Set(catalog.actions.map(a => a.id));
    for (const id of [ROOM_INSPECT_ID, ROOM_QUERY_ID]) {
      if (!ids.has(id)) problems.push(`${catalog.room} declares lists (${[...lists].join(', ')}) but no "${id}" action to read them: build its readers with roomReaders`);
    }
  }
  for (const action of catalog.actions) {
    for (const { path, lists: named } of refsIn(action.input, '')) {
      for (const list of named) {
        if (!lists.has(list)) problems.push(`${catalog.room} action ${action.id}: ${path} addresses ${list}, which is not a list the room declares`);
      }
    }
  }
  return problems;
}

/** Every number a schema takes that says no unit, by where it is. A unit on an array is its numbers'. */
function unitlessNumbers(schema: JsonSchema | undefined, path: string, inherited = false): string[] {
  if (!schema) return [];
  const types = schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : schema.type;
  const declared = inherited || schema['x-unit'] !== undefined;
  return [
    ...(types.includes('number') && !declared ? [path] : []),
    // An array's unit is the unit of the numbers it holds, however deep.
    ...unitlessNumbers(schema.items, `${path}[]`, declared && types.includes('array')),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, value]) => unitlessNumbers(value, path ? `${path}.${key}` : key)),
    ...(typeof schema.additionalProperties === 'object' ? unitlessNumbers(schema.additionalProperties, `${path}.*`) : []),
    ...[...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].flatMap(alternative => unitlessNumbers(alternative, path, declared)),
  ];
}

/**
 * The numbers a catalog takes that do not say what they are measured in
 * (ADR-0244 §2.3), in words: each field's value and each action's input must
 * give every `number` a unit (`x-unit`). An `integer` counts things and needs
 * none. A generator fails on any of them: a number set without knowing its
 * unit is set by guessing.
 */
export function roomMeasureProblems(catalog: {
  room: string;
  actions: readonly { id: string; input: JsonSchema }[];
  fields: readonly { id: string; value: JsonSchema }[];
}): string[] {
  const say = (what: string, where: string[]) =>
    where.map(path => `${catalog.room} ${what}${path ? `: ${path}` : ''} is a number with no unit (x-unit)`);
  return [
    ...catalog.fields.flatMap(f => [...new Set(say(`field ${f.id}`, unitlessNumbers(f.value, '')))]),
    ...catalog.actions.flatMap(a => [...new Set(say(`action ${a.id}`, unitlessNumbers(a.input, '')))]),
  ];
}
