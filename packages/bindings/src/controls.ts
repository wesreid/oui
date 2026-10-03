/**
 * What each kind of design-system control lets someone do, and the input
 * schema that follows from its props (ADR-0220 §2.2).
 *
 * `deriveInputSchema` is the one derivation. A control runs it in the browser
 * on its live props; the generator runs it at build time on the props it can
 * read statically. So the schema a tool takes is never written by hand: a
 * slider's range is its `min` and `max`, a select's options are its options.
 */

import type {
  AnyControlKind,
  ControlKind,
  ControlKindRegistration,
  ControlTable,
  JsonSchema,
  RegisteredControlKind,
  SchemaProps,
} from '@ouispec/contract';

import { stableStringify } from './json-schema.js';

// The kinds, the props a schema is derived from, a registration and a control
// table are the contract's (`control-kind-registration.json`,
// `control-table.json`), generated from its schemas.
export type {
  AnyControlKind,
  ControlDescriptor,
  ControlKind,
  ControlKindRegistration,
  ControlOption,
  ControlTable,
  ControlTableFile,
  EntriesDescriptor,
  KindSchemaDerivation,
  OptionsSource,
  RegisteredControlKind,
  SchemaPropName,
  SchemaPropSources,
  SchemaProps,
  SlotDescriptor,
} from '@ouispec/contract';

/**
 * Every built-in kind (`ControlKind`, documented in the contract). Closed: a
 * design system adds a kind only by registering it (`registerControlKind`),
 * under an `x-` name, in its control table.
 */
export const CONTROL_KINDS: readonly ControlKind[] = [
  'button',
  'toggle',
  'text',
  'number',
  'choice',
  'multi-choice',
  'color',
  'font',
  'tabs',
  'date',
  'date-range',
  'dialog',
];

/** What each kind's action does, as knowledge and tool descriptions say it. */
export const CONTROL_VERBS: Readonly<Record<ControlKind, string>> = {
  button: 'Press',
  toggle: 'Turn on or off',
  text: 'Type into',
  number: 'Set',
  choice: 'Choose',
  'multi-choice': 'Choose any of',
  color: 'Set the colour of',
  font: 'Choose the face of',
  tabs: 'Select a tab of',
  date: 'Set the date of',
  'date-range': 'Set the dates of',
  dialog: 'Close',
};

const INPUT_FORMATS: Readonly<Record<string, string>> = {
  email: 'email',
  url: 'uri',
  date: 'date',
  time: 'time',
};

/** The schema of a control's value, from its kind and props. */
/**
 * How many of a choice's options its schema's description names. The enum
 * always lists every value; the description is prose for the assistant, and a
 * control with hundreds of options (a language picker) would otherwise fill
 * the page state the assistant reads with option names and crowd out what the
 * page shows.
 */
export const MAX_DESCRIBED_OPTIONS = 20;

export function deriveValueSchema(kind: AnyControlKind, props: SchemaProps = {}): JsonSchema | null {
  if (isRegisteredKind(kind)) return registeredValueSchema(kind, props);
  switch (kind) {
    case 'button':
    case 'dialog':
      return null;
    case 'toggle':
      return { type: 'boolean', description: 'true to turn it on, false to turn it off' };
    case 'text': {
      if (props.inputType === 'number') return numberSchema(props);
      const format = props.inputType ? INPUT_FORMATS[props.inputType] : undefined;
      return {
        type: 'string',
        description: 'The text to put in the field, replacing what is there',
        ...(props.minLength !== undefined ? { minLength: props.minLength } : {}),
        ...(props.maxLength !== undefined ? { maxLength: props.maxLength } : {}),
        ...(props.pattern !== undefined ? { pattern: props.pattern } : {}),
        ...(format ? { format } : {}),
      };
    }
    case 'number':
      return numberSchema(props);
    case 'multi-choice': {
      const options = (props.options ?? []).filter(o => !o.disabled);
      const values = options.map(o => o.value);
      const described = options.map(o => (String(o.value) === o.title ? o.title : `${o.value} = ${o.title}`));
      return {
        type: 'array',
        description:
          'The options to choose, replacing the ones chosen now; [] for none' +
          (described.length ? `: ${described.join('; ')}` : ''),
        items: {
          type: values.every(v => typeof v === 'number') && values.length > 0 ? 'number' : 'string',
          ...(values.length ? { enum: values } : {}),
        },
        uniqueItems: true,
      };
    }
    case 'choice':
    case 'tabs': {
      const options = (props.options ?? []).filter(o => !o.disabled);
      const values = options.map(o => o.value);
      // Named in the description up to a limit; every value stays in the enum.
      const described = options
        .slice(0, MAX_DESCRIBED_OPTIONS)
        .map(o => (String(o.value) === o.title ? o.title : `${o.value} = ${o.title}`));
      const unnamed = options.length - described.length;
      const schema: JsonSchema = {
        type: values.every(v => typeof v === 'number') && values.length > 0 ? 'number' : 'string',
        description:
          (kind === 'tabs' ? 'The tab to select' : 'The option to choose') +
          (described.length ? `: ${described.join('; ')}` : '') +
          (unnamed > 0 ? `; and ${unnamed} more, any of which may be chosen` : ''),
        ...(values.length ? { enum: props.clearable ? [...values, null] : values } : {}),
      };
      if (props.clearable) {
        return { ...schema, type: [schema.type as 'string' | 'number', 'null'] };
      }
      return schema;
    }
    case 'color': {
      const kinds = props.paintKinds ?? ['solid'];
      const gradients = kinds.filter(k => k !== 'solid');
      const css: JsonSchema = {
        type: 'string',
        description: 'A CSS colour, e.g. "#eb0a1e" or "rgba(0,0,0,0.5)"',
      };
      const variants: JsonSchema[] = [css];
      const stopKinds = gradients.filter(k => k !== 'freeform-gradient' && k !== 'pattern');
      if (stopKinds.length) {
        variants.push({
          type: 'object',
          description:
            `A gradient paint: kind ${stopKinds.join(' or ')}, its stops from offset 0 to 1, and its angle in degrees ` +
            '(a linear gradient’s direction; an angular gradient’s start, clockwise from the right, -90 the top)',
          properties: {
            kind: { type: 'string', enum: stopKinds },
            angle: { type: 'number', 'x-unit': '°' },
            stops: {
              type: 'array',
              minItems: 2,
              items: {
                type: 'object',
                properties: {
                  offset: { type: 'number', minimum: 0, maximum: 1 },
                  color: css,
                },
                required: ['offset', 'color'],
              },
            },
          },
          required: ['kind', 'stops'],
        });
      }
      if (gradients.includes('freeform-gradient')) {
        variants.push({
          type: 'object',
          description:
            'A freeform gradient: colours at points, blending smoothly between them. Each point is placed as fractions ' +
            'of the painted shape ([0, 0] its top left, [1, 1] its bottom right), with a CSS colour and a spread (how far ' +
            'its colour reaches against the others’; 1 the default). `lines` optionally chains point indices into curves the colour runs along.',
          properties: {
            kind: { type: 'string', enum: ['freeform-gradient'] },
            points: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  at: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 },
                  color: css,
                  spread: { type: 'number', minimum: 0.01 },
                },
                required: ['at', 'color'],
              },
            },
            lines: { type: 'array', items: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2 } },
          },
          required: ['kind', 'points'],
        });
      }
      if (gradients.includes('pattern')) {
        // The document's patterns are the control's options: one is named by its id (ADR-0247 §2.2).
        const patterns = (props.options ?? []).filter(o => !o.disabled);
        variants.push({
          type: 'object',
          description:
            'A pattern paint: one of the document’s patterns repeated across what is painted, by its id' +
            (patterns.length ? ` (${patterns.map(o => `${JSON.stringify(o.value)} is ${o.title}`).join('; ')})` : '') +
            ', with its scale as a percentage of the tile, its rotation in degrees clockwise, and where its first tile sits',
          properties: {
            kind: { type: 'string', enum: ['pattern'] },
            pattern: { type: 'string', ...(patterns.length ? { enum: patterns.map(o => String(o.value)) } : {}) },
            scale: { type: 'number', minimum: 1, 'x-unit': '%' },
            rotation: { type: 'number', 'x-unit': '°' },
            offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            opacity: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['kind', 'pattern'],
        });
      }
      if (props.allowNone) variants.push({ type: 'null', description: 'No paint' });
      return variants.length === 1 ? css : { anyOf: variants, description: 'The paint to set' };
    }
    case 'font':
      return {
        type: 'object',
        description: 'The face to set: a family by name, and optionally one of its styles and axis values',
        properties: {
          family: {
            type: 'string',
            description: 'The family name as the picker lists it',
            ...(props.options?.length && props.options.length <= MAX_ITEM_ENUM
              ? { enum: props.options.map(o => o.title) }
              : {}),
          },
          style: { type: 'string', description: 'A named style of the family, e.g. "Bold Italic"' },
          variation: {
            type: 'object',
            description: 'Variable-font axis values by tag, e.g. {"wght": 650}',
            additionalProperties: { type: 'number' },
          },
        },
        required: ['family'],
      };
    case 'date':
      return { type: 'string', format: 'date', description: 'A date, YYYY-MM-DD' };
    case 'date-range':
      return {
        type: 'object',
        description: 'A range of dates, YYYY-MM-DD: its first day and its last, the start on or before the end',
        properties: {
          start: { type: 'string', format: 'date', description: 'The first day' },
          end: { type: 'string', format: 'date', description: 'The last day' },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      };
  }
}

// ─── Registered kinds ────────────────────────────────────────────────────────

const REGISTERED_KIND = /^x-[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const registeredKinds = new Map<string, ControlKindRegistration>();

export function isRegisteredKind(kind: string): kind is RegisteredControlKind {
  return kind.startsWith('x-');
}

/** Why a registration is not valid, or null. */
export function controlKindRegistrationProblem(registration: unknown): string | null {
  const r = registration as Partial<ControlKindRegistration> | null;
  if (!r || typeof r !== 'object') return 'a control kind registration is an object';
  if (typeof r.kind !== 'string' || !REGISTERED_KIND.test(r.kind))
    return `a registered control kind is named x-<lower-kebab>, not ${JSON.stringify(r.kind)}`;
  if (typeof r.verb !== 'string' || !r.verb.trim()) return `${r.kind} needs the verb its tools start with`;
  const d = r.deriveSchema;
  if (!d || typeof d !== 'object' || !d.schema || typeof d.schema !== 'object')
    return `${r.kind} needs deriveSchema.schema, the value's schema`;
  for (const [pointer, prop] of Object.entries(d.props ?? {})) {
    if (!pointer.startsWith('/')) return `${r.kind}: "${pointer}" is not a JSON Pointer into its schema`;
    if (typeof prop !== 'string') return `${r.kind}: "${pointer}" names no prop`;
  }
  return null;
}

/**
 * Register a design system's control kind, so controls of that kind derive
 * their value schema and verb. Registering the same kind again with the same
 * definition does nothing; with another definition it throws, as does an
 * invalid registration.
 */
export function registerControlKind(registration: ControlKindRegistration): void {
  const problem = controlKindRegistrationProblem(registration);
  if (problem) throw new Error(problem);
  const existing = registeredKinds.get(registration.kind);
  // The same definition, whatever its key order: a shipped table's `$kinds` are written with sorted keys.
  if (existing && stableStringify(existing) !== stableStringify(registration)) {
    throw new Error(`${registration.kind} is already registered with another definition`);
  }
  registeredKinds.set(registration.kind, registration);
}

export function registeredControlKind(kind: string): ControlKindRegistration | undefined {
  return registeredKinds.get(kind);
}

/** What using a control of this kind does, as a tool description starts. */
export function controlVerb(kind: AnyControlKind): string {
  if (!isRegisteredKind(kind)) return CONTROL_VERBS[kind];
  const registration = registeredKinds.get(kind);
  if (!registration) throw new Error(`Control kind ${kind} is not registered`);
  return registration.verb;
}

function registeredValueSchema(kind: RegisteredControlKind, props: SchemaProps): JsonSchema {
  const registration = registeredKinds.get(kind);
  if (!registration) throw new Error(`Control kind ${kind} is not registered`);
  const schema = structuredClone(registration.deriveSchema.schema) as Record<string, unknown>;
  for (const [pointer, prop] of Object.entries(registration.deriveSchema.props ?? {})) {
    const value =
      prop === 'options'
        ? props.options?.filter(o => !o.disabled).map(o => o.value)
        : (props as Record<string, unknown>)[prop];
    if (value !== undefined) setAtPointer(schema, pointer, value);
  }
  return schema as JsonSchema;
}

/** Set `value` at a JSON Pointer, making the objects on its way. */
function setAtPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const keys = pointer
    .slice(1)
    .split('/')
    .map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

function numberSchema(props: SchemaProps): JsonSchema {
  const unit = props.unit ? ` in ${props.unit}` : '';
  const range =
    props.min !== undefined && props.max !== undefined
      ? `, from ${props.min} to ${props.max}${props.wrap ? ' (it wraps past either end)' : ''}`
      : '';
  return {
    type: 'number',
    description: `The value${unit}${range}`,
    ...(props.min !== undefined ? { minimum: props.min } : {}),
    ...(props.max !== undefined ? { maximum: props.max } : {}),
    ...(props.step !== undefined && props.step > 0 ? { multipleOf: props.step } : {}),
    ...(props.unit ? { 'x-unit': props.unit } : {}),
  };
}

/** The item parameter an action takes when its control is one of a list's rows. */
export const ITEM_PROPERTY = 'item';

export function itemSchema(items?: readonly { key: string; title: string }[]): JsonSchema {
  return {
    type: 'string',
    description:
      'Which one: the id or the exact title of a row the page shows' +
      (items && items.length ? ` (${items.length} on screen now)` : ''),
    ...(items && items.length && items.length <= MAX_ITEM_ENUM ? { enum: items.map(i => i.key) } : {}),
  };
}

/** Beyond this many rows, the item parameter names none of them; the page observation lists them. */
export const MAX_ITEM_ENUM = 100;

/**
 * The input schema of the action a control makes: `{ value }` for a field,
 * nothing for a button or dialog, and an `item` when it is one of a list's rows.
 */
export function deriveInputSchema(
  kind: AnyControlKind,
  props: SchemaProps = {},
  options: { itemized?: boolean; items?: readonly { key: string; title: string }[] } = {},
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const value = deriveValueSchema(kind, props);
  if (value) {
    properties.value = value;
    required.push('value');
  }
  if (options.itemized) {
    properties[ITEM_PROPERTY] = itemSchema(options.items);
    required.push(ITEM_PROPERTY);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

// ─── The design system's controls ────────────────────────────────────────────

/** Where a control table file lists the kinds its design system registers. */
export const CONTROL_TABLE_KINDS_KEY = '$kinds';

/** A control table file's controls and the kinds it registers. */
export function readControlTable(file: unknown): { controls: ControlTable; kinds: readonly ControlKindRegistration[] } {
  const { [CONTROL_TABLE_KINDS_KEY]: kinds, ...controls } = (file ?? {}) as Record<string, unknown>;
  return {
    controls: controls as ControlTable,
    kinds: Array.isArray(kinds) ? (kinds as ControlKindRegistration[]) : [],
  };
}
