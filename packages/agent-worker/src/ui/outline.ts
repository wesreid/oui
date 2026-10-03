/**
 * A definition the model can read (ADR-0245 §2.3).
 *
 * An action's input schema can be a whole catalogue: an effect action's union
 * of sixty effects is 94 KB. Handed over whole it would fill the model's
 * context for one call, so a schema past a size is given in outline: each
 * property on a line with its type, range and unit, a nested object closed
 * with its property count, a union listed by what tells its members apart. The
 * model then opens the part it needs by path.
 *
 * Computed from the schema alone, by rule: the same schema always outlines the
 * same way, and no catalogue is reshaped to fit.
 */

/** A schema's JSON up to this many characters is returned whole. */
export const WHOLE_SCHEMA_CHARS = 4_000;
/**
 * A part asked for by its path is returned whole up to this many characters.
 * The model named the part because an outline abbreviated it: answering with
 * another abbreviation leaves it nothing to open. A command list of 48 came
 * back as its first 12 twice, and the command the task needed was never seen.
 */
export const WHOLE_PART_CHARS = 12_000;
/** The most rows one answer lists of an object's properties, a union's members or an enumeration's values. */
const OUTLINE_ROWS = 80;
/** An enumeration's line names this many values; a longer one is opened by its path. */
const ENUM_LINE_VALUES = 12;
/** The longest description kept on an outline line. */
const LINE_DESCRIPTION_CHARS = 110;

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);
const propertiesOf = (schema: Schema): Record<string, Schema> =>
  isSchema(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
const unionOf = (schema: Schema): Schema[] | null => {
  const members = (schema.oneOf ?? schema.anyOf) as unknown;
  return Array.isArray(members) && members.length > 0 && members.every(isSchema) ? (members as Schema[]) : null;
};

/** The one value a schema allows, when it allows one. */
function constantOf(schema: Schema | undefined): string | number | boolean | undefined {
  if (!schema) return undefined;
  const c = schema.const;
  if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return c;
  const e = schema.enum;
  return Array.isArray(e) && e.length === 1 ? (e[0] as string | number | boolean) : undefined;
}

/** The property every member of a union fixes to its own constant: what tells them apart. */
export function discriminatorOf(members: readonly Schema[]): string | null {
  for (const name of Object.keys(propertiesOf(members[0] ?? {}))) {
    const constants = members.map((m) => constantOf(propertiesOf(m)[name]));
    if (constants.every((c) => c !== undefined) && new Set(constants).size === members.length) return name;
  }
  return null;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** What a product's contract says of a value beside its type: its unit, its space, what it refers to. */
function annotations(schema: Schema): string {
  const notes = Object.keys(schema)
    .filter((k) => k.startsWith('x-') && ['string', 'number', 'boolean'].includes(typeof schema[k]))
    .sort()
    .map((k) => `${k.slice(2)}: ${String(schema[k])}`);
  return notes.length ? ` [${notes.join(', ')}]` : '';
}

/** A value's type in a few words. */
function typeLine(schema: Schema): string {
  const constant = constantOf(schema);
  if (constant !== undefined && !Array.isArray(schema.enum)) return JSON.stringify(constant);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    const shown = values.slice(0, ENUM_LINE_VALUES).map((v) => JSON.stringify(v)).join(' | ');
    return values.length > ENUM_LINE_VALUES ? `${shown} | … (${values.length} values)` : shown;
  }
  const union = unionOf(schema);
  if (union) {
    const by = discriminatorOf(union);
    return `one of ${union.length}${by ? ` by ${by}` : ''}`;
  }
  const type = Array.isArray(schema.type) ? (schema.type as string[]).join('|') : ((schema.type as string | undefined) ?? '');
  if (type === 'number' || type === 'integer') {
    const { minimum: min, maximum: max } = schema as { minimum?: number; maximum?: number };
    const range =
      min !== undefined && max !== undefined ? ` ${min}–${max}` : min !== undefined ? ` ≥${min}` : max !== undefined ? ` ≤${max}` : '';
    return `${type}${range}`;
  }
  if (type === 'string') {
    const limits = [
      schema.format ? `format ${String(schema.format)}` : '',
      schema.maxLength !== undefined ? `≤${String(schema.maxLength)} chars` : '',
      schema.pattern ? `pattern ${String(schema.pattern)}` : '',
    ].filter(Boolean);
    return limits.length ? `string (${limits.join(', ')})` : 'string';
  }
  if (type === 'array') return isSchema(schema.items) ? `list of ${typeLine(schema.items)}` : 'list';
  if (type === 'object' || isSchema(schema.properties)) {
    const n = Object.keys(propertiesOf(schema)).length;
    return n > 0 ? `object (${n} properties)` : 'object';
  }
  return type || 'any';
}

/** The values of an enumeration too long for its line. */
const longEnumOf = (schema: Schema): unknown[] | null =>
  Array.isArray(schema.enum) && schema.enum.length > ENUM_LINE_VALUES ? (schema.enum as unknown[]) : null;

/** Whether a property's schema holds more than its line shows. */
function opens(schema: Schema): boolean {
  if (unionOf(schema)) return true;
  if (longEnumOf(schema)) return true;
  if (Object.keys(propertiesOf(schema)).length > 0) return true;
  return isSchema(schema.items) && opens(schema.items);
}

/**
 * The schema `path` names inside `schema`, or why nothing is there.
 *
 * A path is steps joined by ".": a property name; `name=value` for the member
 * of a union whose discriminator is that value; `#n` for a union's nth member
 * (from 1) when nothing tells them apart; `[]` for a list's items.
 */
export function schemaAt(schema: Schema, path: string): { schema: Schema } | { error: string } {
  let at = schema;
  const walked: string[] = [];
  for (const step of path.split('.').filter((s) => s.length > 0)) {
    const here = walked.length ? `"${walked.join('.')}"` : 'the input';
    const union = unionOf(at);
    if (step === '[]') {
      if (!isSchema(at.items)) return { error: `${here} is not a list, so it has no "[]"` };
      at = at.items;
    } else if (/^#\d+$/.test(step)) {
      const member = union?.[Number(step.slice(1)) - 1];
      if (!member) return { error: `${here} has no member ${step}${union ? `: it has ${union.length}` : ''}` };
      at = member;
    } else if (step.includes('=')) {
      const [name, ...rest] = step.split('=');
      const value = rest.join('=');
      const member = union?.find((m) => String(constantOf(propertiesOf(m)[name])) === value);
      if (!member) {
        const by = union ? discriminatorOf(union) : null;
        const values = union && by ? union.map((m) => String(constantOf(propertiesOf(m)[by]))) : [];
        return {
          error: union
            ? `${here} has no member with ${name} = "${value}"${by ? `. Its members are told apart by ${by}: ${clip(values.join(', '), 600)}` : ''}`
            : `${here} is not a union, so "${step}" names nothing in it`,
        };
      }
      at = member;
    } else {
      const next = propertiesOf(at)[step];
      if (!next) {
        const names = Object.keys(propertiesOf(at));
        return {
          error: union
            ? `${here} is a union: open one of its members first (${discriminatorOf(union) ?? '#n'}=…), then "${step}"`
            : `${here} has no property "${step}"${names.length ? `. It has: ${clip(names.join(', '), 600)}` : ''}`,
        };
      }
      at = next;
    }
    walked.push(step);
  }
  return { schema: at };
}

function join(path: string, step: string): string {
  return path ? `${path}.${step}` : step;
}

/** One property on a line: its name, whether it is required, its type, what the contract says of it, what it is. */
function propertyLine(name: string, schema: Schema, required: boolean, path: string): string {
  const description = typeof schema.description === 'string' ? ` — ${clip(schema.description, LINE_DESCRIPTION_CHARS)}` : '';
  const more = opens(schema) ? ` (open: path "${join(path, name)}")` : '';
  return `- ${name}${required ? ' (required)' : ''}: ${typeLine(schema)}${annotations(schema)}${description}${more}`;
}

/** A schema's outline in two parts: what it is, and its rows (properties, a union's members, or an enumeration's values), a line each. */
function outlineOf(schema: Schema, path: string): { head: string[]; rows: string[]; what: string } {
  const longEnum = longEnumOf(schema);
  const head = [
    // An enumeration listed below is not also cut short on its head line.
    (longEnum ? `one of ${longEnum.length} values` : typeLine(schema)) + annotations(schema),
    typeof schema.description === 'string' ? clip(schema.description, longEnum ? 2_000 : 300) : '',
  ]
    .filter(Boolean)
    .join(' — ');

  const union = unionOf(schema);
  if (union) {
    const by = discriminatorOf(union);
    return {
      head: [
        head,
        by ? `Members, by ${by} (open one with path "${join(path, `${by}=<value>`)}"):` : `Members (open one with path "${join(path, '#<n>')}"):`,
      ],
      rows: union.map((member, i) => {
        const label = by ? String(constantOf(propertiesOf(member)[by])) : `#${i + 1}`;
        const title = typeof member.title === 'string' ? member.title : typeof member.description === 'string' ? member.description : '';
        const fields = Object.keys(propertiesOf(member)).filter((n) => n !== by);
        return `- ${label}${title ? ` — ${clip(title, LINE_DESCRIPTION_CHARS)}` : ''}${fields.length ? ` (${fields.length} more fields)` : ''}`;
      }),
      what: 'members',
    };
  }

  const properties = propertiesOf(schema);
  const names = Object.keys(properties);
  if (names.length > 0) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const ordered = [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))];
    return {
      head: [head, `Properties (${names.length}):`],
      rows: ordered.map((name) => propertyLine(name, properties[name], required.has(name), path)),
      what: 'properties',
    };
  }
  if (longEnum) {
    return { head: [head, 'Values:'], rows: longEnum.map((value) => `- ${JSON.stringify(value)}`), what: 'values' };
  }
  if (isSchema(schema.items) && opens(schema.items)) {
    return { head: [head, `Each item (open with path "${join(path, '[]')}"): ${typeLine(schema.items)}`], rows: [], what: 'rows' };
  }
  return { head: [head], rows: [], what: 'rows' };
}

export interface SchemaView {
  /** The schema's JSON when it is small enough, else its outline. */
  text: string;
  /** Whether `text` is the whole schema. */
  whole: boolean;
}

/**
 * What an action takes, or the part of it `path` names.
 *
 * Whole when its JSON is small enough: `maxChars` for an action's whole input,
 * and the larger `WHOLE_PART_CHARS` for a part asked for by its path, which
 * the model named because an outline had cut it short. Otherwise in outline:
 * what it is, then its rows — properties, a union's members, an enumeration's
 * values — as many as the size holds from row `from`, saying how many there
 * are and where the next begin. No row is dropped without the answer saying
 * how to read it.
 */
export function describeSchema(
  schema: Record<string, unknown> | undefined,
  options: { path?: string; maxChars?: number; from?: number } = {},
): SchemaView | { error: string } {
  const path = options.path ?? '';
  const maxChars = options.maxChars ?? WHOLE_SCHEMA_CHARS;
  const found = schemaAt(schema ?? { type: 'object', properties: {} }, path);
  if ('error' in found) return found;
  const from = Math.max(1, Math.floor(options.from ?? 1));
  const json = JSON.stringify(found.schema);
  if (from === 1 && json.length <= (path ? Math.max(maxChars, WHOLE_PART_CHARS) : maxChars)) return { text: json, whole: true };

  const { head, rows, what } = outlineOf(found.schema, path);
  if (from > Math.max(rows.length, 1)) {
    return { error: `${path ? `"${path}"` : 'The input'} has ${rows.length} ${what}: there is none at ${from}` };
  }
  // The rows that fit from `from`: at least one, at most a page, within the size.
  const paging = (to: number) =>
    from === 1 && to === rows.length ? '' : `\n${what[0].toUpperCase()}${what.slice(1)} ${from}–${to} of ${rows.length}.${to < rows.length ? ` For the next, call again with from: ${to + 1}.` : ''}`;
  let to = Math.min(rows.length, from - 1 + OUTLINE_ROWS);
  const text = (end: number) => [...head, ...rows.slice(from - 1, end)].join('\n') + paging(end);
  while (to > from && text(to).length > maxChars) to--;
  return { text: text(to), whole: false };
}
