import type { JsonSchema, JsonSchemaType } from '@ouispec/contract';

/**
 * The subset of JSON Schema (draft 2020-12) every capability declares its
 * input and values in: the contract's (`json-schema.json`).
 */
export type { JsonSchema, JsonSchemaType };

const typesOf = (schema: JsonSchema): readonly JsonSchemaType[] =>
  schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : schema.type;

/**
 * Whether `live` asks for no more than `declared` does: the same type, a range
 * inside the declared one, options drawn from the declared options, and the
 * same properties. A live control may narrow what the build declared (the
 * options loaded from the API today) but never widen it or change its type,
 * because the build's declaration is what was reviewed.
 */
export function isNarrowing(live: JsonSchema, declared: JsonSchema): boolean {
  const liveTypes = typesOf(live);
  const declaredTypes = typesOf(declared);
  if (declaredTypes.length > 0 && !liveTypes.every(t => declaredTypes.includes(t))) return false;
  if (declaredTypes.length > 0 && liveTypes.length === 0) return false;

  if (declared.minimum !== undefined && (live.minimum === undefined || live.minimum < declared.minimum))
    return false;
  if (declared.maximum !== undefined && (live.maximum === undefined || live.maximum > declared.maximum))
    return false;
  if (declared.enum !== undefined) {
    if (live.enum === undefined || !live.enum.every(v => declared.enum!.includes(v))) return false;
  }
  if (declared.const !== undefined && live.const !== declared.const) return false;

  if (declared.properties || live.properties) {
    const declaredProps = declared.properties ?? {};
    const liveProps = live.properties ?? {};
    for (const key of Object.keys(liveProps)) {
      if (!(key in declaredProps)) return false;
      if (!isNarrowing(liveProps[key], declaredProps[key])) return false;
    }
    for (const key of declared.required ?? []) {
      if (!(key in liveProps)) return false;
    }
  }
  if (declared.items && live.items && !isNarrowing(live.items, declared.items)) return false;
  return true;
}

/** The keywords that combine schemas, which a tool's input may not have at its top level. */
export const TOOL_INPUT_COMBINERS = ['oneOf', 'anyOf', 'allOf'] as const;

/**
 * Why `schema` cannot be a tool's input, or none. A tool's input is one JSON
 * object schema: its type is `"object"` and only that, and it is not a union
 * or an intersection of schemas. A model provider refuses the whole request
 * when one tool's input is otherwise (Bedrock and the Anthropic API: "input_schema
 * does not support oneOf, allOf, or anyOf at the top level"), so one such action
 * takes down every turn its surface is offered in. Alternatives belong inside a
 * property, and a value's own form is checked when the action runs.
 */
export function toolInputProblems(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ['its input is not a JSON schema object'];
  const record = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (record.type !== 'object') {
    problems.push(
      record.type === undefined
        ? 'its input has no type; a tool’s input must be "type": "object"'
        : `its input's type is ${JSON.stringify(record.type)}; a tool’s input must be "type": "object"`,
    );
  }
  for (const keyword of TOOL_INPUT_COMBINERS) {
    if (keyword in record) {
      problems.push(
        `its input has ${keyword} at the top level, which model providers refuse; put the alternatives inside a property and check them when it runs`,
      );
    }
  }
  return problems;
}

/** Deterministic JSON: object keys sorted, so the same value always gives the same bytes. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Why `value` does not satisfy `schema`, or null. Covers what controls and
 * room fields declare: type, enum, const, range, length, pattern, required
 * properties, array items (and their uniqueness), dates, and `anyOf`/`oneOf`
 * alternatives.
 */
export function validateValue(schema: JsonSchema, value: unknown, path = 'value'): string | null {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    const problems = alternatives.map(s => validateValue(s, value, path));
    return problems.some(p => p === null)
      ? null
      : `${path} matches none of the accepted forms (${problems.join('; ')})`;
  }
  const types = typesOf(schema);
  if (types.length > 0 && !types.some(t => isType(t, value))) {
    return `${path} must be ${types.join(' or ')}`;
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    return `${path} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`;
  }
  if (schema.const !== undefined && value !== schema.const)
    return `${path} must be ${JSON.stringify(schema.const)}`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum)
      return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} must be at most ${schema.maxLength} characters`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${path} must match ${schema.pattern}`;
    }
    if (schema.format === 'date' && !isCalendarDate(value)) return `${path} must be a date, YYYY-MM-DD`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return `${path} needs at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `${path} takes at most ${schema.maxItems} items`;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length)
      return `${path} lists an item twice`;
    if (schema.items) {
      for (const [i, item] of value.entries()) {
        const problem = validateValue(schema.items, item, `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, v] of Object.entries(record)) {
      const prop = schema.properties?.[key];
      if (prop) {
        const problem = validateValue(prop, v, `${path}.${key}`);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return `${path} has no property "${key}"`;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const problem = validateValue(schema.additionalProperties, v, `${path}.${key}`);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** A real day written YYYY-MM-DD: 2026-02-30 is not one. */
function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

function isType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}
