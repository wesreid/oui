/**
 * The query a page reads from its address, declared once.
 *
 * A list page keeps its filters in its address (`?view=declined&period=this_month`)
 * so a link, or the assistant, opens it filtered to exactly one question. The
 * page declares what it reads with `defineQuery`, reads it with `readQuery`
 * and writes it with `writeQuery`. The generator reads the same declaration
 * (`page-query.json` in the contract), and the generated `app.navigate` takes
 * it: the assistant opens the page already filtered, in one call, and a value
 * the page does not take is refused before anything moves.
 *
 * No React and no router: `readQuery` takes the address's `URLSearchParams`
 * (or anything with `get`), however the app reads it.
 */
import type { PageQuery, QueryChoice, QueryParam, QueryValue } from '@ouispec/contract';

import { validateValue, type JsonSchema } from './json-schema.js';

export type { PageQuery, QueryChoice, QueryDate, QueryFlag, QueryNumber, QueryParam, QueryText, QueryValue } from '@ouispec/contract';

// ─── Declaring and reading ───────────────────────────────────────────────────

type ChoiceValueOf<V> = V extends string ? V : V extends { readonly value: infer T extends string } ? T : never;

/** The value one parameter holds once read. */
type ParamValue<P> = P extends { readonly values: readonly (infer V)[] }
  ? ChoiceValueOf<V>
  : P extends { readonly type: 'integer' | 'number' }
    ? number
    : P extends { readonly type: 'boolean' }
      ? boolean
      : string;

/** A parameter as `readQuery` gives it: a flag is always on or off, a `multiple` always a list, one with a default always set. */
export type QueryParamValue<P> = P extends { readonly type: 'boolean' }
  ? boolean
  : P extends { readonly multiple: true }
    ? ParamValue<P>[]
    : P extends { readonly default: unknown }
      ? ParamValue<P>
      : ParamValue<P> | undefined;

/** What `readQuery` returns for a declaration: each parameter by name, typed by its declaration. */
export type QueryValues<D extends PageQuery> = { -readonly [K in keyof D]: QueryParamValue<D[K]> };

/** What `writeQuery` takes: any of the parameters; `undefined`, `null` or `''` leaves one out. */
export type QueryChanges<D extends PageQuery> = { [K in keyof D]?: ParamValue<D[K]> | ParamValue<D[K]>[] | null | undefined };

/**
 * Declare the query a page reads from its address. The generator reads it
 * where `readQuery` is called with it, so every value must be a build-time
 * constant (`page-query.json`): an option list the page's select already
 * renders is one.
 */
export function defineQuery<const D extends PageQuery>(declaration: D): D {
  return declaration;
}

/** Something to read an address's query from: `URLSearchParams`, a router's search params, or the query string itself. */
export type QuerySource = { get(name: string): string | null } | string;

/**
 * The page's query, read from its address as the declaration says. A value
 * the page does not take falls back to its default, or is left out: an
 * address written by hand never breaks the page.
 */
export function readQuery<D extends PageQuery>(declaration: D, source: QuerySource): QueryValues<D> {
  const params = typeof source === 'string' ? new URLSearchParams(source) : source;
  const out: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(declaration)) {
    out[name] = readParam(param, params.get(name));
  }
  return out as QueryValues<D>;
}

/**
 * The address's query with these changes, every other parameter kept as it
 * was (another list's, an open record's). A value that is empty or the
 * parameter's default is left out, so the plain address stays plain.
 */
export function writeQuery<D extends PageQuery>(
  declaration: D,
  current: URLSearchParams | string,
  changes: QueryChanges<D>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [name, value] of Object.entries(changes as Record<string, unknown>)) {
    const param = declaration[name];
    if (!param) throw new Error(`writeQuery: "${name}" is not a parameter of this query (${Object.keys(declaration).join(', ')})`);
    const text = written(param, value);
    if (text === null) next.delete(name);
    else next.set(name, text);
  }
  return next;
}

function readParam(param: QueryParam, raw: string | null): unknown {
  if (isFlag(param)) {
    const read = raw === null ? null : parseFlag(raw);
    return read ?? param.default ?? false;
  }
  if ('multiple' in param && param.multiple) {
    if (raw === null) return [];
    return [...new Set(raw.split(',').map(part => parseOne(param, part.trim())).filter((v): v is NonNullable<typeof v> => v !== null))];
  }
  const read = raw === null ? null : parseOne(param, raw);
  return read ?? ('default' in param ? param.default : undefined);
}

/** One value as the page takes it, or null when it does not. */
function parseOne(param: QueryParam, raw: string): string | number | null {
  if (raw === '') return null;
  if (isChoice(param)) return choiceValues(param).includes(raw) ? raw : null;
  switch (param.type) {
    case 'integer':
    case 'number': {
      if (!(param.type === 'integer' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(raw)) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || (param.type === 'integer' && !Number.isSafeInteger(n))) return null;
      if (param.minimum !== undefined && n < param.minimum) return null;
      if (param.maximum !== undefined && n > param.maximum) return null;
      return n;
    }
    case 'date':
      return isCalendarDate(raw) ? raw : null;
    case 'string':
      return param.maxLength !== undefined && raw.length > param.maxLength ? null : raw;
    default:
      return null;
  }
}

function parseFlag(raw: string): boolean | null {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

/** A value as the address writes it, or null to leave the parameter out. */
function written(param: QueryParam, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (isFlag(param)) {
    const on = value === true;
    return on === (param.default ?? false) ? null : on ? '1' : '0';
  }
  if (Array.isArray(value)) {
    const parts = value.filter(v => v !== undefined && v !== null && v !== '').map(String);
    return parts.length ? parts.join(',') : null;
  }
  const text = String(value);
  return 'default' in param && param.default !== undefined && String(param.default) === text ? null : text;
}

function isFlag(param: QueryParam): param is Extract<QueryParam, { type: 'boolean' }> {
  return 'type' in param && param.type === 'boolean';
}

function isChoice(param: QueryParam): param is QueryChoice {
  return 'values' in param;
}

const valueOf = (v: QueryValue): string => (typeof v === 'string' ? v : v.value);

/** A choice's values, as the address writes them. */
export function choiceValues(param: QueryChoice): string[] {
  return param.values.map(valueOf);
}

/** A real day written YYYY-MM-DD. */
function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

// ─── What the generator emits ────────────────────────────────────────────────

/**
 * Why a declaration cannot be a page's query, beyond its schema: a default
 * that is not one of its values or not in its range, a `multiple` with a
 * default, a value listed twice, a value with a comma in a `multiple`.
 */
export function pageQueryProblems(declaration: PageQuery): string[] {
  const problems: string[] = [];
  for (const [name, param] of Object.entries(declaration)) {
    const multiple = 'multiple' in param && param.multiple === true;
    if (multiple && 'default' in param && param.default !== undefined) {
      problems.push(`?${name} takes several values and has a default: leave the default out (none is the empty list)`);
    }
    if (isChoice(param)) {
      const values = choiceValues(param);
      const twice = values.filter((v, i) => values.indexOf(v) !== i);
      if (twice.length) problems.push(`?${name} lists ${[...new Set(twice)].map(v => `"${v}"`).join(', ')} twice`);
      if (multiple) {
        const commas = values.filter(v => v.includes(','));
        if (commas.length) problems.push(`?${name} takes several values, comma-separated, so no value can hold a comma: ${commas.map(v => `"${v}"`).join(', ')}`);
      }
      if (param.default !== undefined && !values.includes(param.default)) {
        problems.push(`?${name}'s default "${param.default}" is not one of its values (${values.join(', ')})`);
      }
    } else if (!multiple && 'default' in param && param.default !== undefined) {
      const text = String(param.default);
      const read = isFlag(param) ? parseFlag(text) : parseOne(param, text);
      if (read === null) problems.push(`?${name}'s default ${JSON.stringify(param.default)} is not a value it takes`);
    }
  }
  return problems;
}

/** A choice's meanings in a few words: `lane (The lane); declined (Declined work: closed repair orders …)`. */
function meanings(param: QueryChoice): string {
  const told = param.values.filter((v): v is Exclude<QueryValue, string> => typeof v !== 'string' && !!(v.label || v.description));
  if (!told.length) return '';
  return ` ${told
    .map(v => {
      const words = [v.label, v.description].filter(Boolean).join(': ');
      return `${v.value} (${words})`;
    })
    .join('; ')}.`;
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** One parameter as a JSON Schema: what `app.navigate`'s query takes for it, and checks. */
export function queryParamSchema(param: QueryParam): JsonSchema {
  const multiple = 'multiple' in param && param.multiple === true;
  const listOf = (items: JsonSchema, description: string): JsonSchema => ({
    type: 'array',
    description: `${sentence(description)} Several may be given.`,
    items,
    uniqueItems: true,
  });
  if (isChoice(param)) {
    const description = `${sentence(param.description)}${meanings(param)}`;
    const one: JsonSchema = { type: 'string', enum: choiceValues(param) };
    if (multiple) return listOf(one, description);
    return { ...one, description, ...(param.default !== undefined ? { default: param.default } : {}) };
  }
  const withDefault = 'default' in param && param.default !== undefined ? { default: param.default } : {};
  switch (param.type) {
    case 'string': {
      const one: JsonSchema = { type: 'string', ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}) };
      if (multiple) return listOf(one, param.description);
      return { ...one, description: sentence(param.description), ...withDefault };
    }
    case 'integer':
    case 'number':
      return {
        type: param.type,
        description: sentence(param.description),
        ...(param.minimum !== undefined ? { minimum: param.minimum } : {}),
        ...(param.maximum !== undefined ? { maximum: param.maximum } : {}),
        ...(param.unit ? { 'x-unit': param.unit } : {}),
        ...withDefault,
      };
    case 'boolean':
      return { type: 'boolean', description: sentence(param.description), ...withDefault };
    case 'date':
      return { type: 'string', format: 'date', description: sentence(param.description), ...withDefault };
  }
}

/** A page's whole query as one object schema, a property per parameter, in the order declared. */
export function pageQuerySchema(declaration: PageQuery): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(declaration).map(([name, param]) => [name, queryParamSchema(param)])),
    additionalProperties: false,
  };
}

// ─── Going to an address ─────────────────────────────────────────────────────

/** A page's query in the navigation action's input: the routes it is on, and what it takes. */
export interface NavigationQuery {
  routes: readonly string[];
  /** An object schema, a property per parameter (`pageQuerySchema`). */
  schema: JsonSchema;
}

/** The key on each alternative of `app.navigate`'s `query` naming the routes it belongs to (`json-schema.json`). */
export const NAVIGATION_QUERY_ROUTES = 'x-routes';

/** The queries the navigation action's input declares, by the routes they belong to. */
export function navigationQueries(input: unknown): NavigationQuery[] {
  const query = (input as JsonSchema | undefined)?.properties?.query;
  return (query?.anyOf ?? [])
    .filter(alt => Array.isArray(alt[NAVIGATION_QUERY_ROUTES]) && alt.properties)
    .map(alt => ({ routes: alt[NAVIGATION_QUERY_ROUTES]!, schema: alt }));
}

/** What `app.navigate` is asked for: an address, the `:parameters` of a route written as its pattern, and the query. */
export interface NavigationRequest {
  path?: unknown;
  params?: unknown;
  query?: unknown;
}

export type NavigationTarget =
  | { ok: true; address: string; route: string }
  | { ok: false; code: 'INVALID_PATH' | 'UNKNOWN_ROUTE' | 'INVALID_PARAMS' | 'INVALID_QUERY' | 'UNKNOWN_QUERY'; message: string };

/** A route pattern as a matcher for an encoded path: `:param` is one segment. */
function routePattern(route: string): RegExp {
  const escaped = route
    .split('/')
    .map(seg => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}/?$`);
}

/** The most specific route a path is on: the most literal segments, then the fewest parameters. */
function routeOf(routes: readonly string[], path: string): string | null {
  let best: { route: string; score: number } | null = null;
  for (const route of routes) {
    if (route.includes('*') || !routePattern(route).test(path)) continue;
    const score = route.split('/').filter(s => s && !s.startsWith(':')).length * 10 - (route.match(/:/g)?.length ?? 0);
    if (!best || score > best.score) best = { route, score };
  }
  return best?.route ?? null;
}

const fail = (code: Extract<NavigationTarget, { ok: false }>['code'], message: string): NavigationTarget => ({ ok: false, code, message });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * The in-app address a navigation request goes to, built from its parts and
 * encoded, or why it cannot be gone to.
 *
 * - The path is one of the build's routes: it starts with one `/`, has no
 *   backslash, no control character, no empty, `.` or `..` segment, so it
 *   can never leave the app (`//host`, `/\host`) or climb out of a route.
 * - A segment written as `:name` is filled from `params`, encoded; a segment
 *   written out is encoded as it reads.
 * - The query (in `path` after `?`, in `query`, or both, never disagreeing)
 *   is checked against the query the route's page declares, when it declares
 *   one: a parameter it does not take, or a value it does not accept, is
 *   refused, naming what it takes. A page that declares none takes it as is.
 */
export function navigationTarget(
  request: NavigationRequest,
  routes: readonly string[],
  queries: readonly NavigationQuery[] = [],
): NavigationTarget {
  const raw = typeof request.path === 'string' ? request.path.trim() : '';
  if (!raw.startsWith('/')) return fail('INVALID_PATH', 'A page’s address starts with /');
  // eslint-disable-next-line no-control-regex
  if (raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    return fail('INVALID_PATH', `${JSON.stringify(raw)} is not an address in this app: it starts with one / and has no backslash`);
  }
  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : raw.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);

  // The path, a segment at a time.
  if (request.params !== undefined && request.params !== null && !isRecord(request.params)) {
    return fail('INVALID_PARAMS', 'params is an object: each :parameter of the route by name');
  }
  const params = (request.params ?? {}) as Record<string, unknown>;
  const used = new Set<string>();
  const segments = pathPart === '/' ? [] : pathPart.replace(/\/$/, '').split('/').slice(1);
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      const value = params[name];
      if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
        return fail('INVALID_PARAMS', `${pathPart} needs params.${name}: the ${name} to put in place of :${name}`);
      }
      used.add(name);
      encoded.push(encodeURIComponent(String(value).trim()));
      continue;
    }
    const text = decoded(segment);
    if (text === null) return fail('INVALID_PATH', `${pathPart} has a malformed escape in "${segment}"`);
    if (text === '' || text === '.' || text === '..' || text.includes('/') || text.includes('\\')) {
      return fail('INVALID_PATH', `${pathPart} has an empty, "." or ".." segment: write the page’s own address`);
    }
    encoded.push(encodeURIComponent(text));
  }
  const unused = Object.keys(params).filter(name => !used.has(name));
  if (unused.length) {
    return fail('INVALID_PARAMS', `${pathPart} has no ${unused.map(n => `:${n}`).join(', ')}: params fill a route’s :parameters when the path is written as its route`);
  }
  const path = `/${encoded.join('/')}`;
  const route = routeOf(routes, path);
  if (!route) return fail('UNKNOWN_ROUTE', `${path} is not a page of this app: the pages are ${routes.join(', ')}`);

  // The query, from the path and from `query`.
  if (request.query !== undefined && request.query !== null && !isRecord(request.query)) {
    return fail('INVALID_QUERY', 'query is an object: each parameter by name');
  }
  const asked = new Map<string, unknown>();
  new URLSearchParams(search).forEach((value, name) => {
    const before = asked.get(name);
    asked.set(name, before === undefined ? value : `${String(before)},${value}`);
  });
  for (const [name, value] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const before = asked.get(name);
    if (before !== undefined && String(before) !== (Array.isArray(value) ? value.join(',') : String(value))) {
      return fail('INVALID_QUERY', `?${name} is ${JSON.stringify(before)} in the path and ${JSON.stringify(value)} in query: give it once`);
    }
    asked.set(name, value);
  }

  const declared = queries.find(q => q.routes.includes(route));
  const pairs: [string, string][] = [];
  if (declared) {
    const properties = declared.schema.properties ?? {};
    const takes = Object.keys(properties);
    const unknown = [...asked.keys()].filter(name => !(name in properties));
    if (unknown.length) {
      return fail(
        'UNKNOWN_QUERY',
        `${route} does not take ${unknown.map(n => `?${n}`).join(', ')}: it takes ${takes.map(n => `?${n}`).join(', ')}`,
      );
    }
    // In the order the page declares them, so the same filters are always the same address.
    for (const name of takes) {
      if (!asked.has(name)) continue;
      const schema = properties[name];
      const value = coerced(schema, asked.get(name));
      const problem = validateValue(schema, value, `?${name}`);
      if (problem) return fail('INVALID_QUERY', `${problem}${schema.description ? ` (${schema.description})` : ''}`);
      const text = queryText(value);
      if (text === null) return fail('INVALID_QUERY', `?${name}: a value of several cannot hold a comma`);
      if (text !== '') pairs.push([name, text]);
    }
  } else {
    for (const [name, value] of asked) {
      if (isRecord(value)) return fail('INVALID_QUERY', `?${name} is a value, not an object`);
      const text = Array.isArray(value) ? value.map(String).join(',') : String(value);
      pairs.push([name, text]);
    }
  }

  const query = new URLSearchParams(pairs).toString();
  const fragment = hash ? `#${encodeURIComponent(decoded(hash) ?? hash)}` : '';
  return { ok: true, address: `${path}${query ? `?${query}` : ''}${fragment}`, route };
}

/** A value as the model gave it, read as the parameter's type: `"2"` for an integer, `"1"` for a flag, `"a,b"` for a list. */
function coerced(schema: JsonSchema, value: unknown): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
    case 'boolean':
      if (value === '1' || value === 'true') return true;
      if (value === '0' || value === 'false') return false;
      return value;
    case 'array': {
      const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
      return list.map(v => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : v)).filter(v => v !== '');
    }
    case 'string':
      return typeof value === 'number' ? String(value) : value;
    default:
      return value;
  }
}

/** A checked value as the address writes it, or null when a list's value holds a comma. */
function queryText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map(String);
    return parts.some(p => p.includes(',')) ? null : parts.join(',');
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** Whether two addresses are the same page with the same query, however each is encoded or ordered. */
export function sameAddress(a: string, b: string): boolean {
  const read = (address: string) => {
    const url = new URL(address, 'http://app.invalid');
    const params: [string, string][] = [];
    url.searchParams.forEach((value, name) => params.push([name, value]));
    params.sort(([x, xv], [y, yv]) => x.localeCompare(y) || xv.localeCompare(yv));
    return `${decoded(url.pathname)?.replace(/\/$/, '') ?? url.pathname}?${JSON.stringify(params)}#${decoded(url.hash) ?? url.hash}`;
  };
  try {
    return read(a) === read(b);
  } catch {
    return false;
  }
}
