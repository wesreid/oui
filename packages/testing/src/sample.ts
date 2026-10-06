/**
 * A value the assistant could set a control to: valid against the control's
 * live schema, and different from what it shows now where the schema allows,
 * so running it is a change the control's callback must see.
 */
import { validateValue, type JsonSchema } from '@ouispec/bindings';

const SAMPLE_TEXT = 'Set by the OUI conformance kit';

/** A valid value for `schema` other than `current` when there is one; `undefined` when the kit cannot make one. */
export function sampleValue(schema: JsonSchema, current?: unknown): unknown {
  for (const candidate of candidates(schema, current)) {
    if (candidate !== undefined && !validateValue(schema, candidate)) return candidate;
  }
  return undefined;
}

function candidates(schema: JsonSchema, current: unknown): unknown[] {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    const nonNull = alternatives.filter(a => a.type !== 'null');
    return [...nonNull, ...alternatives].flatMap(a => candidates(a, current));
  }
  if (schema.const !== undefined) return [schema.const];
  // An attached file: a control is run with what the page resolves its id to (OUI spec §7.3.11).
  if (schema.format === 'oui-attachment') {
    const declared = (schema as Record<string, unknown>)['x-oui-attachment'] as { as?: string; mediaTypes?: string[] } | undefined;
    return [declared?.as === 'text' ? SAMPLE_TEXT : sampleFile(declared?.mediaTypes)];
  }
  if (schema.enum) {
    const values = schema.enum.filter(v => v !== null);
    return [...values.filter(v => v !== current), ...values, ...(schema.enum.includes(null) ? [null] : [])];
  }
  const types = schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : [...schema.type];
  const ordered = [...types.filter(t => t !== 'null'), ...types.filter(t => t === 'null')];
  if (!ordered.length) return [SAMPLE_TEXT];
  return ordered.flatMap(type => byType(type, schema, current));
}

function byType(type: string, schema: JsonSchema, current: unknown): unknown[] {
  switch (type) {
    case 'boolean':
      return typeof current === 'boolean' ? [!current] : [true, false];
    case 'number':
    case 'integer':
      return numbers(schema, current, type === 'integer');
    case 'string':
      return strings(schema, current);
    case 'array':
      return [array(schema, current)];
    case 'object':
      return [object(schema)];
    case 'null':
      return [null];
    default:
      return [];
  }
}

function numbers(schema: JsonSchema, current: unknown, integer: boolean): number[] {
  const min = schema.minimum;
  const max = schema.maximum;
  const step = schema.multipleOf ?? (integer ? 1 : undefined);
  const snap = (n: number) => (step ? Math.round(n / step) * step : n);
  const picks = [
    min !== undefined && max !== undefined ? snap(min + (max - min) / 2) : undefined,
    min !== undefined ? snap(min + (step ?? 1)) : undefined,
    max !== undefined ? snap(max - (step ?? 1)) : undefined,
    min,
    max,
    1,
    0,
    2,
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return [...picks.filter(n => n !== current), ...picks];
}

function strings(schema: JsonSchema, current: unknown): string[] {
  switch (schema.format) {
    case 'date':
      return current === '2026-10-02' ? ['2026-10-03'] : ['2026-10-02'];
    case 'uri':
      return ['https://example.com/oui-conformance-kit'];
    case 'email':
      return ['kit@example.com'];
    case 'time':
      return ['12:30'];
  }
  // A colour control's value is a CSS colour (`deriveValueSchema`'s `color` kind says so).
  if (/colou?r/i.test(schema.description ?? '')) return current === '#336699' ? ['#993366'] : ['#336699'];
  let text = current === SAMPLE_TEXT ? `${SAMPLE_TEXT}, again` : SAMPLE_TEXT;
  if (schema.maxLength !== undefined) text = text.slice(0, schema.maxLength);
  if (schema.minLength !== undefined && text.length < schema.minLength) text = text.padEnd(schema.minLength, 'k');
  return [text, 'kit'];
}

function array(schema: JsonSchema, current: unknown): unknown[] {
  const items = schema.items ?? {};
  const want = Math.max(1, schema.minItems ?? 1);
  if (items.enum) {
    const values = items.enum.filter(v => v !== null);
    const now = Array.isArray(current) ? current : [];
    const fresh = values.filter(v => !now.includes(v));
    return [...fresh, ...values].slice(0, Math.min(want, values.length) || 1);
  }
  const out: unknown[] = [];
  for (let i = 0; i < want; i++) out.push(sampleValue(items));
  return out;
}

function object(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties?.[key];
    out[key] = prop ? sampleValue(prop) : SAMPLE_TEXT;
  }
  return out;
}

/** A small file of the first type an input accepts, as the person's own file choice would give it. */
function sampleFile(mediaTypes: readonly string[] | undefined): File {
  const type = mediaTypes?.find((t) => !t.endsWith('/*')) ?? (mediaTypes?.[0]?.replace('/*', '/png') || 'application/octet-stream');
  const ext = type.split('/')[1]?.split('+')[0] ?? 'bin';
  const bytes = new Uint8Array([79, 85, 73]);
  const name = `oui-kit-sample.${ext}`;
  // Where there is no File global (Node 18), a named Blob stands for one, as a page reads it.
  return typeof File === 'function'
    ? new File([bytes], name, { type })
    : (Object.assign(new Blob([bytes], { type }), { name, lastModified: 0 }) as unknown as File);
}
