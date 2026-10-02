/**
 * A validator for the keywords the declaration document's own schema uses,
 * so the catalog checks documents against the published schema itself, in a
 * browser too, without shipping a general JSON Schema validator.
 *
 * It refuses a schema that uses any other keyword rather than ignoring it: a
 * keyword this file skipped would be a rule the published schema states and
 * the catalog never checked. Payload schemas, which may use any keyword, are
 * validated by the full validator in `./validate`.
 */

type Schema = Readonly<Record<string, unknown>>;

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs', '$comment']);
const KEYWORDS = new Set([
  'type',
  'required',
  'properties',
  'additionalProperties',
  'propertyNames',
  'const',
  'enum',
  'pattern',
  'minLength',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$ref',
  'allOf',
  'if',
  'then',
  'else',
  'not',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function at(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}/${key}`;
}

/** Every way `value` breaks `schema`, each with its JSON path. Empty when it conforms. */
export function validateLite(root: Schema, value: unknown): string[] {
  const errors: string[] = [];

  function resolve(ref: string): Schema {
    const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
    const defs = root.$defs as Record<string, Schema> | undefined;
    const target = match ? defs?.[match[1]] : undefined;
    if (!target) throw new Error(`[agent-sdk-events] schema $ref ${ref} does not resolve`);
    return target;
  }

  function check(schema: Schema, v: unknown, path: string, out: string[]): void {
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
        throw new Error(`[agent-sdk-events] the declaration schema uses '${key}', which json-schema-lite does not check`);
      }
    }
    if (typeof schema.$ref === 'string') check(resolve(schema.$ref), v, path, out);

    if (typeof schema.type === 'string' && !matchesType(v, schema.type)) {
      out.push(`${path}: must be ${schema.type === 'object' ? 'an object' : `a ${schema.type}`}`);
      return;
    }
    if ('const' in schema && !same(v, schema.const)) out.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, v))) {
      out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }

    if (typeof v === 'string') {
      if (typeof schema.minLength === 'number' && v.length < schema.minLength) out.push(`${path}: must not be empty`);
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(v)) {
        out.push(`${path}: '${v}' does not match ${schema.pattern}`);
      }
    }

    if (Array.isArray(v)) {
      if (typeof schema.minItems === 'number' && v.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`);
      if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) out.push(`${path}: allows at most ${schema.maxItems} item(s)`);
      if (schema.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out.push(`${path}: items must be unique`);
      if (schema.items) v.forEach((item, i) => check(schema.items as Schema, item, at(path, i), out));
    }

    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in obj)) out.push(`${path}: '${key}' is required`);
      }
      const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, child] of Object.entries(obj)) {
        if (schema.propertyNames) {
          const nameErrors: string[] = [];
          check(schema.propertyNames as Schema, key, at(path, key), nameErrors);
          if (nameErrors.length > 0) out.push(`${at(path, key)}: the name '${key}' is not allowed (${(schema.propertyNames as Schema).pattern as string})`);
        }
        if (key in properties) check(properties[key], child, at(path, key), out);
        else if (schema.additionalProperties === false) out.push(`${path}: '${key}' is not an allowed property`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          check(schema.additionalProperties as Schema, child, at(path, key), out);
        }
      }
    }

    for (const sub of (schema.allOf as Schema[] | undefined) ?? []) check(sub, v, path, out);
    if (schema.if) {
      const probe: string[] = [];
      check(schema.if as Schema, v, path, probe);
      const branch = probe.length === 0 ? schema.then : schema.else;
      if (branch) check(branch as Schema, v, path, out);
    }
    if (schema.not) {
      const probe: string[] = [];
      check(schema.not as Schema, v, path, probe);
      if (probe.length === 0) out.push(`${path}: ${describeNot(schema.not as Schema)}`);
    }
  }

  check(root, value, '', errors);
  return errors;
}

/** `not: { required: [x] }` is how the schema forbids a field; say so plainly. */
function describeNot(not: Schema): string {
  const required = not.required as string[] | undefined;
  if (required?.length === 1 && Object.keys(not).length === 1) return `'${required[0]}' is not allowed here`;
  return `must not match ${JSON.stringify(not)}`;
}
