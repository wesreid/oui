/**
 * Validate a tool call's input against the tool's declared input schema before it runs.
 *
 * The orchestrator hands tools to the model as raw JSON Schema (`jsonSchema(rawSchema)`),
 * which carries no validator, and a tool call's arguments are whatever the model
 * produced. Without this check a host's tool receives undeclared and mistyped fields:
 * a generated entity update tool passed every key the model supplied straight to a
 * database write.
 *
 * Validation is by the schema as declared. A tool that must refuse undeclared
 * properties says so with `additionalProperties: false`, as the schema loader and the
 * entity tool generator now do.
 */
import { ATTACHMENT_ID_PATTERN, OUI_ATTACHMENT_FORMAT } from 'oui-spec/spec';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import formatsPlugin from 'ajv-formats';

type FormatsPlugin = (ajv: Ajv) => Ajv;
// ajv-formats is CommonJS; under ESM interop its function is on `default`.
const addFormats: FormatsPlugin =
  (formatsPlugin as unknown as { default?: FormatsPlugin }).default ??
  (formatsPlugin as unknown as FormatsPlugin);

/**
 * Top-level keys removed before compiling:
 * - `sideEffects`: the SDK's own flag, stored on the input schema; not JSON Schema.
 * - `$schema`: hosts emit different drafts (e.g. 2020-12 from zod); the keywords tools
 *   use are the same across them, and an unknown draft must not stop a tool working.
 * - `$id`: two tools declaring the same id would collide in the compiler.
 */
const NON_VALIDATION_KEYS = ['sideEffects', '$schema', '$id'] as const;

export type ToolInputValidation =
  | {
      ok: true;
      value: Record<string, unknown>;
      /**
       * Properties that arrived as JSON text and were read as the list or
       * object the text holds, because the schema takes one there. The caller
       * tells the model, so it sends the value itself next time.
       */
      coerced?: string[];
    }
  | { ok: false; errors: string[] };

export type ToolInputValidator = (input: unknown) => ToolInputValidation;

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false });
addFormats(ajv);
// An input that takes a file the person attached is given the file's id (OUI spec §7.3.11).
ajv.addFormat(OUI_ATTACHMENT_FORMAT, ATTACHMENT_ID_PATTERN);

function describeError(error: ErrorObject): string {
  const at = error.instancePath || '(input)';
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'additionalProperties') {
    return `${at} has a property this tool does not accept: "${String(params.additionalProperty)}"`;
  }
  if (error.keyword === 'required') {
    return `${at} is missing required property "${String(params.missingProperty)}"`;
  }
  return `${at} ${error.message ?? 'is invalid'}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Whether a property's schema takes a list or an object, and so never a string that only spells one. */
function takesStructure(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('string')) return false;
  if (types.includes('array') || types.includes('object')) return true;
  if (isRecord(schema.items) || isRecord(schema.properties)) return true;
  const members = (schema.oneOf ?? schema.anyOf) as unknown;
  return Array.isArray(members) && members.length > 0 && members.every(takesStructure);
}

/**
 * `value` with each property that the schema takes as a list or an object, and
 * that arrived as a string of JSON spelling one, replaced by what the string
 * holds. Models do this under load: `"ids": "[\"a\",\"b\"]"` for `"ids": ["a","b"]`
 * (three calls of one session, each refused and retried). Only such a property
 * is read this way: a string where the schema takes a string is left alone.
 */
function structuresFromText(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
): { value: Record<string, unknown>; coerced: string[] } {
  const out: Record<string, unknown> = { ...value };
  const coerced: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || !takesStructure(properties[key])) continue;
    const text = entry.trim();
    if (!text.startsWith('[') && !text.startsWith('{')) continue;
    try {
      const read: unknown = JSON.parse(text);
      if (read && typeof read === 'object') {
        out[key] = read;
        coerced.push(key);
      }
    } catch {
      // Not JSON: the validator says what is wrong with it as it is.
    }
  }
  return { value: out, coerced };
}

/**
 * Compile a validator for a tool's input schema.
 *
 * A schema that cannot be compiled yields a validator that rejects every call: a tool
 * whose input cannot be checked does not run.
 */
export function createToolInputValidator(
  inputSchema: Record<string, unknown> | undefined,
): ToolInputValidator {
  const schema: Record<string, unknown> = { ...(inputSchema ?? { type: 'object', properties: {} }) };
  for (const key of NON_VALIDATION_KEYS) delete schema[key];

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return () => ({ ok: false, errors: [`this tool's input schema is invalid (${reason})`] });
  }

  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [],
  );

  return (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['(input) must be an object'] };
    }
    // Models often send null for an optional argument they mean to leave out.
    const value: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (entry === null && !required.has(key)) continue;
      value[key] = entry;
    }
    if (validate(value)) return { ok: true, value };
    const errors = (validate.errors ?? []).map(describeError);
    // A list or an object sent as JSON text is read as what it spells, when that makes the input valid.
    const read = structuresFromText(value, isRecord(schema.properties) ? schema.properties : {});
    if (read.coerced.length > 0 && validate(read.value)) return { ok: true, value: read.value, coerced: read.coerced };
    return { ok: false, errors };
  };
}
