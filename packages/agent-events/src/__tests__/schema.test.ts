/**
 * The published JSON Schema and the catalog agree.
 *
 * The catalog checks documents against the schema object with a small
 * validator of the keywords the schema uses (json-schema-lite.ts). This runs
 * the same documents through a full 2020-12 validator and requires the same
 * verdict, so the file other languages validate with and the check the
 * packages run are one rule.
 */
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { EVENT_DECLARATIONS_SCHEMA, PLATFORM_EVENTS } from '../index.js';
import { validateLite } from '../json-schema-lite.js';
import { deskEvents } from './support/desk-events.js';

// strictRequired is off: `then: { required: ['completes'] }` names a property the event schema declares beside it.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(EVENT_DECLARATIONS_SCHEMA);

type Doc = Record<string, unknown> & { events: Record<string, Record<string, unknown>> };
const variants: Array<[string, (doc: Doc) => void]> = [
  ['valid as written', () => {}],
  ['no version', (d) => delete d.version],
  ['a later version', (d) => (d.version = 2)],
  ['an unknown top-level field', (d) => (d.extra = true)],
  ['an event name with a space', (d) => (d.events['report ready'] = d.events['report:ready'])],
  ['an event name without a namespace', (d) => (d.events.report_ready = d.events['report:ready'])],
  ['an upper-case event name', (d) => (d.events['Report:ready'] = d.events['report:ready'])],
  ['an unknown role', (d) => (d.events['report:ready'].role = 'done')],
  ['a completion without completes', (d) => delete d.events['report:ready'].completes],
  ['a completion with two correlation fields', (d) => (d.events['report:ready'].correlation = ['exportId', 'reportId'])],
  ['a progress event that completes', (d) => (d.events['report:progress'].completes = 'export')],
  ['a failure with a result', (d) => (d.events['report:failed'].result = ['error'])],
  ['a failure without a reason', (d) => delete d.events['report:failed'].reason],
  ['a completion with a reason', (d) => (d.events['report:ready'].reason = { field: 'url', fallback: 'x' })],
  ['an event without rooms', (d) => (d.events['report:ready'].rooms = [])],
  ['a room pattern with a space', (d) => ((d.rooms as Record<string, unknown>).member = { pattern: 'member {userId}' })],
  ['a room with an unknown field', (d) => ((d.rooms as Record<string, unknown>).member = { pattern: 'member:{userId}', id: 1 })],
  ['a lower-case $defs name', (d) => ((d.$defs as Record<string, unknown>).reportRef = { type: 'object' })],
  ['duplicate correlation fields', (d) => (d.events['report:progress'].correlation = ['exportId', 'exportId'])],
];

describe('the published schema and the catalog agree', () => {
  it.each(variants)('%s', (_label, change) => {
    const doc = JSON.parse(JSON.stringify(deskEvents())) as Doc;
    change(doc);
    const ajvValid = validate(doc);
    const liteProblems = validateLite(EVENT_DECLARATIONS_SCHEMA, doc);
    expect({ valid: liteProblems.length === 0 }).toEqual({ valid: ajvValid });
  });

  it('accepts the platform events', () => {
    expect(validate(PLATFORM_EVENTS)).toBe(true);
    expect(validateLite(EVENT_DECLARATIONS_SCHEMA, PLATFORM_EVENTS)).toEqual([]);
  });

  it('refuses a schema keyword the lite validator does not check, rather than skip it', () => {
    expect(() => validateLite({ type: 'string', format: 'uri' }, 'x')).toThrow("uses 'format'");
  });
});
