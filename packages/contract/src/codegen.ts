/**
 * @ouispec/contract/codegen — TypeScript from JSON Schema.
 *
 * One renderer for every type the platform generates from a schema: the
 * contract's own types (this package's `src/generated/contract.ts`) and a
 * product's event payload types (`@ouispec/agent-events/codegen`).
 * The schema is the authority and the types follow it, never the other way
 * round.
 *
 * It renders the keywords that shape a value (`$ref`, `const`, `enum`,
 * `type`, `properties`, `required`, `additionalProperties`, `items`, `allOf`,
 * `anyOf`, `oneOf`) and treats the rest as validation only. Where JSON Schema
 * cannot say what TypeScript can (a template literal, `keyof`), a schema
 * states the type in its `$comment` as `ts: <type>`, which every validator
 * ignores.
 */

/** The schema keywords the renderer reads. Any other keyword is validation only. */
export interface RenderableSchema {
  $ref?: string;
  $comment?: string;
  type?: string | readonly string[];
  description?: string;
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, RenderableSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | RenderableSchema;
  items?: RenderableSchema;
  allOf?: readonly RenderableSchema[];
  anyOf?: readonly RenderableSchema[];
  oneOf?: readonly RenderableSchema[];
  [keyword: string]: unknown;
}

export interface RenderOptions {
  /** The type name a `$ref` names. Throws for one that names nothing. */
  refName(ref: string): string;
  /**
   * How an array renders: `Array<T>`, or `readonly T[]` for a contract whose
   * values are read, never changed, by whoever receives them. Default `Array`.
   */
  arrays?: 'Array' | 'readonly';
  /**
   * An object with no properties of its own but a schema for every other key:
   * as an index signature member (`{ [key: string]: T }`), or as
   * `Readonly<Record<string, T>>`. Default `index`.
   */
  maps?: 'index' | 'Record';
  /**
   * The index signature of an object that has both properties and a schema
   * for every other key: `unknown`, or every type a key can hold (TypeScript
   * requires each property to fit it). Default `unknown`.
   */
  indexSignature?: 'unknown' | 'union';
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TS_COMMENT = /^ts:\s*(.+)$/s;

/** A property name as TypeScript writes it: bare when it can be, quoted otherwise. */
export const propertyKey = (name: string): string => (IDENTIFIER.test(name) ? name : `'${name}'`);

/** A JSON value as a TypeScript literal type. */
export const literal = (value: unknown): string =>
  typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(value);

/** Break a paragraph into lines of at most `width` characters, at spaces. */
function wrap(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

/** A doc comment, wrapped to 96 columns, or nothing when there is no text. */
export function doc(text: string | undefined, indent: string): string {
  if (!text) return '';
  const width = 96 - indent.length;
  const safe = text.replace(/\*\//g, '*\\/');
  if (!safe.includes('\n') && safe.length <= width - 7) return `${indent}/** ${safe} */\n`;
  // Tables and fenced code keep their lines; prose wraps.
  let fenced = false;
  const lines = safe.split('\n').flatMap((p) => {
    if (p.startsWith('```')) fenced = !fenced;
    if (fenced || p.startsWith('```') || p.startsWith('|')) return [p];
    return p ? wrap(p, width - 3) : [''];
  });
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ''}`).join('\n')}\n${indent} */\n`;
}

/** The type a schema states in its `$comment`, if it states one. */
export function statedType(schema: RenderableSchema): string | null {
  return typeof schema.$comment === 'string' ? (TS_COMMENT.exec(schema.$comment.trim())?.[1].trim() ?? null) : null;
}

/** Whether a type expression has a `|` or `&` outside any brackets, so it needs parentheses as an element type. */
function isCompound(type: string): boolean {
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === '{' || c === '(' || c === '<' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === '>' || c === ']') depth--;
    else if (depth === 0 && (c === '|' || c === '&') && type[i - 1] === ' ') return true;
  }
  return false;
}

function arrayOf(element: string, options: RenderOptions): string {
  if ((options.arrays ?? 'Array') === 'Array') return `Array<${element}>`;
  return `readonly ${isCompound(element) ? `(${element})` : element}[]`;
}

/** A schema as a TypeScript type expression. */
export function renderType(schema: RenderableSchema, indent: string, options: RenderOptions): string {
  const stated = statedType(schema);
  if (stated) return stated;
  if (typeof schema.$ref === 'string') return options.refName(schema.$ref);
  if ('const' in schema) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(' | ');
  if (schema.allOf?.length) {
    const parts = schema.allOf.map((s) => renderType(s, indent, options));
    const own = schema.properties ? [renderObject(schema, indent, options)] : [];
    return [...parts, ...own].join(' & ');
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((s) => renderType(s, indent, options)).join(' | ');
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type as string];
  if (types.length === 0) return schema.properties ? renderObject(schema, indent, options) : 'unknown';
  return types
    .map((type) => {
      switch (type) {
        case 'string':
          return 'string';
        case 'number':
        case 'integer':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array':
          return schema.items ? arrayOf(renderType(schema.items, indent, options), options) : arrayOf('unknown', options).replace('Array<unknown>', 'unknown[]');
        case 'object':
          return schema.properties || schema.additionalProperties ? renderObject(schema, indent, options) : 'Record<string, unknown>';
        default:
          return 'unknown';
      }
    })
    .join(' | ');
}

const isOpen = (extra: RenderableSchema['additionalProperties']) =>
  extra === true || (!!extra && typeof extra === 'object' && Object.keys(extra).length === 0);

/** The members of an object schema, one per line. */
export function renderMembers(schema: RenderableSchema, indent: string, options: RenderOptions): string {
  const required = new Set(schema.required ?? []);
  let out = '';
  const held: string[] = [];
  let optional = false;
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const type = renderType(prop, indent, options);
    held.push(type);
    if (!required.has(name)) optional = true;
    out += doc(prop.description, indent);
    out += `${indent}${propertyKey(name)}${required.has(name) ? '' : '?'}: ${type};\n`;
  }
  const extra = schema.additionalProperties;
  if (isOpen(extra)) {
    out += `${indent}[key: string]: unknown;\n`;
  } else if (extra && typeof extra === 'object') {
    let index: string;
    if (!schema.properties) index = renderType(extra, indent, options);
    else if ((options.indexSignature ?? 'unknown') === 'unknown') index = 'unknown';
    else index = [...new Set([renderType(extra, indent, options), ...held, ...(optional ? ['undefined'] : [])])].join(' | ');
    out += `${indent}[key: string]: ${index};\n`;
  }
  return out;
}

/** An object schema as an object type. */
export function renderObject(schema: RenderableSchema, indent: string, options: RenderOptions): string {
  const extra = schema.additionalProperties;
  if (
    options.maps === 'Record' &&
    !schema.properties &&
    extra !== undefined &&
    extra !== false
  ) {
    return `Readonly<Record<string, ${isOpen(extra) ? 'unknown' : renderType(extra as RenderableSchema, indent, options)}>>`;
  }
  const inner = `${indent}  `;
  const members = renderMembers(schema, inner, options);
  return members ? `{\n${members}${indent}}` : 'Record<string, never>';
}

/** One named type: an alias, an interface, or an interface extending its `$ref`s. */
export function renderNamed(
  name: string,
  schema: RenderableSchema,
  description: string | undefined,
  options: RenderOptions,
): string {
  const head = doc(description ?? schema.description, '');
  const stated = statedType(schema);
  if (stated) return `${head}export type ${name} = ${stated};\n`;
  const onlyRef = typeof schema.$ref === 'string' && !schema.properties && !schema.allOf;
  if (onlyRef) return `${head}export type ${name} = ${options.refName(schema.$ref!)};\n`;

  const parts = schema.allOf ?? [];
  const isRefPart = (p: RenderableSchema) => typeof p.$ref === 'string' && Object.keys(p).every((k) => k === '$ref' || k === 'description');
  const refs = parts.filter(isRefPart).map((p) => options.refName(p.$ref!));
  const rest = parts.filter((p) => !isRefPart(p));
  const own: RenderableSchema = {
    properties: { ...Object.assign({}, ...rest.map((p) => p.properties ?? {})), ...schema.properties },
    required: [...rest.flatMap((p) => p.required ?? []), ...(schema.required ?? [])],
    additionalProperties: schema.additionalProperties ?? rest.find((p) => p.additionalProperties !== undefined)?.additionalProperties,
  };
  const isObject = schema.type === 'object' || refs.length > 0 || rest.length > 0 || !!schema.properties;
  if (!isObject || schema.anyOf || schema.oneOf || rest.some((p) => p.anyOf || p.oneOf || p.$ref)) {
    return `${head}export type ${name} = ${renderType(schema, '', options)};\n`;
  }
  if (options.maps === 'Record' && !schema.properties && refs.length === 0 && rest.length === 0) {
    return `${head}export type ${name} = ${renderObject(schema, '', options)};\n`;
  }
  const members = renderMembers(own, '  ', options);
  return `${head}export interface ${name}${refs.length ? ` extends ${refs.join(', ')}` : ''} {\n${members}}\n`;
}
