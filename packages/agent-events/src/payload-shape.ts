/**
 * The fields of a payload schema: what the platform reads to know that a
 * correlation, result or reason field exists and is always sent.
 */
import type { JsonSchema } from './types.js';

export interface PayloadShape {
  /** Every declared property, through `$ref` and `allOf`. */
  properties: ReadonlyMap<string, JsonSchema>;
  /** The properties every payload carries. */
  required: ReadonlySet<string>;
}

const DEF_REF = /^#\/\$defs\/([^/]+)$/;

/** The `$defs` name a `$ref` points to, or null when it does not point into `$defs`. */
export function defName(ref: string): string | null {
  return DEF_REF.exec(ref)?.[1] ?? null;
}

/**
 * Collect the object shape of `schema`, following `$ref`s into `defs` and
 * merging `allOf`. Throws naming the reference when one does not resolve.
 */
export function payloadShape(schema: JsonSchema, defs: Readonly<Record<string, JsonSchema>> | undefined): PayloadShape {
  const properties = new Map<string, JsonSchema>();
  const required = new Set<string>();
  const seen = new Set<string>();

  function visit(s: JsonSchema): void {
    if (typeof s.$ref === 'string') {
      const name = defName(s.$ref);
      const target = name ? defs?.[name] : undefined;
      if (!name || !target) throw new Error(`$ref '${s.$ref}' does not name an entry of $defs`);
      if (seen.has(name)) throw new Error(`$ref '${s.$ref}' refers back to itself`);
      seen.add(name);
      visit(target);
      seen.delete(name);
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) properties.set(key, value);
    for (const key of s.required ?? []) required.add(key);
    for (const part of s.allOf ?? []) visit(part);
  }

  visit(schema);
  return { properties, required };
}

/** Whether `schema` describes an object: `type: 'object'`, or a `$ref`/`allOf` that does. */
export function isObjectSchema(schema: JsonSchema, defs: Readonly<Record<string, JsonSchema>> | undefined): boolean {
  if (schema.type === 'object') return true;
  if (typeof schema.$ref === 'string') {
    const name = defName(schema.$ref);
    const target = name ? defs?.[name] : undefined;
    return !!target && isObjectSchema(target, defs);
  }
  return (schema.allOf ?? []).some((part) => isObjectSchema(part, defs));
}
