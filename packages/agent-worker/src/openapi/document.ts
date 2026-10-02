/**
 * The parts of an OpenAPI 3.0 or 3.1 document the tool loader reads, and the
 * conversion of its schemas into the JSON Schema a tool declares.
 */

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export const HTTP_METHODS: readonly HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export type JsonSchema = Record<string, unknown>;
export type Reference = { $ref: string };

/** A security requirement object: scheme name → the scopes or roles it must carry. */
export type SecurityRequirement = Record<string, string[]>;

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  style?: string;
  explode?: boolean;
  schema?: JsonSchema;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<OpenApiParameter | Reference>;
  requestBody?: OpenApiRequestBody | Reference;
  responses?: Record<string, unknown>;
  security?: SecurityRequirement[];
  [extension: `x-${string}`]: unknown;
}

export type OpenApiPathItem = {
  summary?: string;
  description?: string;
  parameters?: Array<OpenApiParameter | Reference>;
} & Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: string;
  info?: { title?: string; version?: string; [key: string]: unknown };
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, OpenApiParameter | Reference>;
    requestBodies?: Record<string, OpenApiRequestBody | Reference>;
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

/** Thrown for anything the loader refuses; the message names the operation. */
export class OpenApiToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiToolError';
  }
}

function isReference(value: unknown): value is Reference {
  return !!value && typeof value === 'object' && typeof (value as Reference).$ref === 'string';
}

/**
 * Resolves `#/...` references in one document. `where` names the operation in
 * errors. A reference outside the document, or one that does not resolve, is refused.
 */
export function createResolver(doc: OpenApiDocument) {
  function lookup(ref: string, where: string): unknown {
    if (!ref.startsWith('#/')) throw new OpenApiToolError(`${where}: $ref "${ref}" is not in this document`);
    let node: unknown = doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !(key in (node as object))) {
        throw new OpenApiToolError(`${where}: $ref "${ref}" does not resolve`);
      }
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }

  /** Follow references until a value that is not one. */
  function deref<T>(value: T | Reference, where: string): T {
    const seen = new Set<string>();
    let current: unknown = value;
    while (isReference(current)) {
      if (seen.has(current.$ref)) throw new OpenApiToolError(`${where}: ${current.$ref} refers to itself`);
      seen.add(current.$ref);
      current = lookup(current.$ref, where);
    }
    return current as T;
  }

  return { deref, lookup };
}

export type Resolver = ReturnType<typeof createResolver>;

/** Keywords OpenAPI adds to a schema that are not JSON Schema, and mean nothing to a tool's input. */
const OPENAPI_ONLY_KEYWORDS = new Set(['discriminator', 'xml', 'externalDocs', 'example', 'nullable']);

/** Keywords whose value is one schema. */
const SUBSCHEMA_KEYWORDS = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'additionalItems'];
/** Keywords whose value is a list of schemas. */
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords whose value maps names to schemas. */
const SUBSCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'];

/**
 * An OpenAPI schema as the JSON Schema of a tool's input: every reference inlined,
 * 3.0's `nullable` as a `null` type, `example` as `examples`, and properties the
 * server sets (`readOnly`) left out, since a caller never sends them.
 *
 * A schema that refers to itself cannot be inlined and is refused.
 */
export function toInputSchema(schema: unknown, resolver: Resolver, where: string, stack: string[] = []): JsonSchema {
  if (isReference(schema)) {
    const ref = schema.$ref;
    if (stack.includes(ref)) throw new OpenApiToolError(`${where}: ${ref} refers to itself, so it cannot be inlined into a tool's input`);
    return toInputSchema(resolver.lookup(ref, where), resolver, where, [...stack, ref]);
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return typeof schema === 'boolean' ? (schema ? {} : { not: {} }) : {};
  }

  const source = schema as JsonSchema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    if (OPENAPI_ONLY_KEYWORDS.has(key) || key.startsWith('x-')) continue;
    if (SUBSCHEMA_KEYWORDS.includes(key) && value && typeof value === 'object') {
      out[key] = toInputSchema(value, resolver, where, stack);
    } else if (SUBSCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((entry) => toInputSchema(entry, resolver, where, stack));
    } else if (SUBSCHEMA_MAP_KEYWORDS.includes(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, toInputSchema(entry, resolver, where, stack)]),
      );
    } else {
      out[key] = value;
    }
  }

  if (source.example !== undefined && out.examples === undefined) out.examples = [source.example];

  // 3.0: `nullable: true` beside a type allows null too.
  if (source.nullable === true && out.type !== undefined) {
    const types = Array.isArray(out.type) ? (out.type as unknown[]) : [out.type];
    if (!types.includes('null')) out.type = [...types, 'null'];
  }

  // The server sets read-only properties; a caller never sends them.
  if (out.properties && typeof out.properties === 'object') {
    const properties = source.properties as Record<string, unknown>;
    const readOnly = Object.keys(properties).filter((name) => {
      const entry = isReference(properties[name]) ? resolver.deref(properties[name], where) : properties[name];
      return !!entry && typeof entry === 'object' && (entry as JsonSchema).readOnly === true;
    });
    if (readOnly.length > 0) {
      out.properties = Object.fromEntries(
        Object.entries(out.properties as Record<string, unknown>).filter(([name]) => !readOnly.includes(name)),
      );
      if (Array.isArray(out.required)) {
        out.required = (out.required as string[]).filter((name) => !readOnly.includes(name));
        if ((out.required as string[]).length === 0) delete out.required;
      }
    }
  }
  return out;
}
