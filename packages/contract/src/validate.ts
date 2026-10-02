/**
 * @ouispec/contract/validate — checks a value against the
 * contract's schemas with a full JSON Schema (2020-12) validator: a control
 * table, a mapping, a catalog, a manifest, knowledge, `oui.config.json`, an
 * approval message or an event declaration document. For build steps, tests
 * and servers; the browser needs only the types.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';

import { CONTRACT_SCHEMAS, CONTRACT_TYPES, type ContractSchemaFile, type ContractTypeName } from './generated/schemas.js';

type FormatsPlugin = (ajv: Ajv2020) => Ajv2020;
// ajv-formats is CommonJS; under ESM interop its function is on `default`.
const addFormats: FormatsPlugin =
  (formatsPlugin as unknown as { default?: FormatsPlugin }).default ?? (formatsPlugin as unknown as FormatsPlugin);

/** A schema of the contract, by file (`control-table.json`) or by the type generated from it (`ControlDescriptor`). */
export type ContractRef = ContractSchemaFile | ContractTypeName;

export interface ContractValidator {
  /** Every way `value` breaks the schema, each with its JSON pointer. Empty when it conforms. */
  problems(ref: ContractRef, value: unknown): string[];
  /** Throws a `ContractError` listing every problem, naming `what`. */
  assert(ref: ContractRef, value: unknown, what: string): void;
}

export class ContractError extends Error {
  constructor(
    readonly what: string,
    readonly ref: ContractRef,
    readonly problems: readonly string[],
  ) {
    super(`${what} does not match the OUI contract's ${ref}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ContractError';
  }
}

/** The schema `$id` (and pointer) a reference names. */
export function contractSchemaId(ref: ContractRef): string {
  const target: string = ref in CONTRACT_TYPES ? CONTRACT_TYPES[ref as ContractTypeName] : ref;
  const [file, pointer] = target.split('#');
  const schema = CONTRACT_SCHEMAS[file as ContractSchemaFile];
  if (!schema) throw new Error(`"${ref}" is not a schema or type of the OUI contract`);
  return pointer ? `${schema.$id}#${pointer}` : schema.$id;
}

function describe(error: ErrorObject): string {
  const at = error.instancePath || '/';
  switch (error.keyword) {
    case 'additionalProperties':
      return `${at} has "${(error.params as { additionalProperty: string }).additionalProperty}", which the contract does not define`;
    case 'unevaluatedProperties':
      return `${at} has "${(error.params as { unevaluatedProperty: string }).unevaluatedProperty}", which the contract does not define`;
    case 'enum':
      return `${at} must be one of ${(error.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
    default:
      return `${at} ${error.message ?? 'is invalid'}`;
  }
}

/** Compile every schema of the contract once. */
export function createContractValidator(): ContractValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const schema of Object.values(CONTRACT_SCHEMAS)) ajv.addSchema(schema as object);
  const compiled = new Map<string, ValidateFunction>();
  const validator = (ref: ContractRef): ValidateFunction => {
    const id = contractSchemaId(ref);
    let fn = compiled.get(id);
    if (!fn) {
      fn = ajv.getSchema(id);
      if (!fn) throw new Error(`the OUI contract has no schema at ${id}`);
      compiled.set(id, fn);
    }
    return fn;
  };
  const problems = (ref: ContractRef, value: unknown): string[] => {
    const validate = validator(ref);
    if (validate(value)) return [];
    // A `oneOf`'s branches each report why they do not match; the most specific
    // reasons are the deepest ones.
    const errors = validate.errors ?? [];
    return [...new Set(errors.map(describe))];
  };
  return {
    problems,
    assert(ref, value, what) {
      const found = problems(ref, value);
      if (found.length) throw new ContractError(what, ref, found);
    },
  };
}

let shared: ContractValidator | null = null;

/** Every way `value` breaks the contract's `ref`. Compiles the schemas on first use. */
export function contractProblems(ref: ContractRef, value: unknown): string[] {
  shared ??= createContractValidator();
  return shared.problems(ref, value);
}
