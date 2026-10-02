/**
 * @ouispec/agent-events/validate — checks a payload against its
 * declared schema, with a full JSON Schema (2020-12) validator. For servers
 * and build checks; the catalog itself does not need it.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import type { EventCatalog } from './catalog.js';

type FormatsPlugin = (ajv: Ajv2020) => Ajv2020;
// ajv-formats is CommonJS; under ESM interop its function is on `default`.
const addFormats: FormatsPlugin =
  (formatsPlugin as unknown as { default?: FormatsPlugin }).default ?? (formatsPlugin as unknown as FormatsPlugin);

export interface PayloadValidator {
  /** Why `payload` is not a valid `event` payload; empty when it is. Throws for an undeclared event. */
  problems(event: string, payload: unknown): string[];
}

/** Compile every declared payload schema of the catalog once. */
export function createPayloadValidator(catalog: EventCatalog): PayloadValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();
  for (const name of catalog.names()) {
    const event = catalog.get(name)!;
    try {
      compiled.set(name, ajv.compile({ ...event.payload, $defs: { ...event.defs, ...(event.payload.$defs as object | undefined) } }));
    } catch (err) {
      throw new Error(
        `[agent-sdk-events] ${event.product}: events/${name} has a payload schema that cannot be compiled: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return {
    problems(event, payload) {
      const validate = compiled.get(event);
      if (!validate) {
        // Surface the same error every other lookup gives.
        catalog.require(event, 'payload validation');
        return [];
      }
      if (validate(payload)) return [];
      return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
    },
  };
}
