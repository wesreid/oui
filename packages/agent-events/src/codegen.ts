/**
 * @ouispec/agent-events/codegen — the TypeScript a product's code
 * uses, generated from its declaration document: a type per payload, the
 * name → payload map, the names, room constructors and patterns, the job
 * kinds, and the document itself.
 *
 * The document is the authority and the types follow it, never the other way
 * round: an event added to the document is a type on the next generation, and
 * a name the document lacks does not type-check.
 */
import {
  doc,
  literal,
  propertyKey,
  renderNamed as renderSchemaNamed,
  type RenderOptions,
} from '@ouispec/contract/codegen';

import { createEventCatalog, defaultTypeName } from './catalog.js';
import { defName } from './payload-shape.js';
import { mapRoomPattern, roomPatternsRegExp, roomPlaceholders } from './rooms.js';
import type { EventDeclarationDocument, JsonSchema } from './types.js';

export interface TypeScriptNames {
  eventMap: string;
  eventName: string;
  eventPayload: string;
  eventNames: string;
  isEventName: string;
  rooms: string;
  roomPatterns: string;
  roomRegex: string;
  isValidRoom: string;
  jobKinds: string;
  declarations: string;
}

export const DEFAULT_TYPESCRIPT_NAMES: TypeScriptNames = {
  eventMap: 'EventMap',
  eventName: 'EventName',
  eventPayload: 'EventPayload',
  eventNames: 'EVENT_NAMES',
  isEventName: 'isEventName',
  rooms: 'Room',
  roomPatterns: 'ROOM_PATTERNS',
  roomRegex: 'ROOM_REGEX',
  isValidRoom: 'isValidRoom',
  jobKinds: 'JOB_KINDS',
  declarations: 'EVENT_DECLARATIONS',
};

export interface TypeScriptOptions {
  /** Text for the banner under the GENERATED line: where the document lives and how to regenerate. */
  source: string;
  /** Names for the generated declarations, beside the payload types. */
  names?: Partial<TypeScriptNames>;
  /** The module `EventDeclarationDocument` is imported from. */
  typesFrom?: string;
}

const key = propertyKey;

/** How a payload's `$ref` names its type: the `$defs` entry it points to. */
function refName(ref: string): string {
  const name = defName(ref);
  if (!name) throw new Error(`[agent-sdk-events] codegen: $ref '${ref}' does not name an entry of $defs`);
  return name;
}

/** Payload types are the product's to use as it likes: arrays render mutable, as `Array<T>`. */
const PAYLOAD_RENDERING: RenderOptions = { refName, arrays: 'Array', maps: 'index', indexSignature: 'unknown' };

const renderNamed = (name: string, schema: JsonSchema, description: string | undefined) =>
  renderSchemaNamed(name, schema, description, PAYLOAD_RENDERING);

/** Render the TypeScript for one declaration document. Throws when the document is invalid. */
export function renderTypeScript(document: EventDeclarationDocument, options: TypeScriptOptions): string {
  const catalog = createEventCatalog(document);
  const n: TypeScriptNames = { ...DEFAULT_TYPESCRIPT_NAMES, ...options.names };
  const typesFrom = options.typesFrom ?? '@ouispec/agent-events';
  const events = Object.keys(document.events).map((name) => catalog.get(name)!);
  const rooms = Object.entries(document.rooms);

  let out = `// GENERATED FILE — DO NOT EDIT.\n//\n${options.source
    .split('\n')
    .map((l) => `// ${l}`.trimEnd())
    .join('\n')}\n\nimport type { EventDeclarationDocument } from '${typesFrom}';\n`;

  out += '\n// ─── Shared payload shapes ($defs) ───────────────────────────────────────────\n\n';
  for (const [name, schema] of Object.entries(document.$defs ?? {})) out += `${renderNamed(name, schema, undefined)}\n`;

  out += '// ─── Payloads ────────────────────────────────────────────────────────────────\n\n';
  for (const event of events) {
    out += `${renderNamed(event.typeName, event.payload, `\`${event.name}\` (${event.role}). ${event.description}`)}\n`;
  }

  out += '// ─── Events ──────────────────────────────────────────────────────────────────\n\n';
  out += `/** Every event ${document.product} declares, mapped to its payload. */\n`;
  out += `export interface ${n.eventMap} {\n${events.map((e) => `  '${e.name}': ${e.typeName};`).join('\n')}\n}\n\n`;
  out += `export type ${n.eventName} = keyof ${n.eventMap};\n\n`;
  out += `export type ${n.eventPayload}<E extends ${n.eventName}> = ${n.eventMap}[E];\n\n`;
  out += `/** Every declared name, in declaration order. */\n`;
  out += `export const ${n.eventNames} = [\n${events.map((e) => `  '${e.name}',`).join('\n')}\n] as const satisfies readonly ${n.eventName}[];\n\n`;
  out += `export function ${n.isEventName}(value: string): value is ${n.eventName} {\n  return (${n.eventNames} as readonly string[]).includes(value);\n}\n`;

  out += '\n// ─── Rooms ───────────────────────────────────────────────────────────────────\n\n';
  out += `/** Every declared room, as its pattern. */\n`;
  out += `export const ${n.roomPatterns} = {\n${rooms.map(([name, r]) => `  ${key(name)}: '${r.pattern}',`).join('\n')}\n} as const;\n\n`;
  out += `/** A constructor for every declared room. */\n`;
  out += `export const ${n.rooms} = {\n`;
  for (const [name, room] of rooms) {
    const params = roomPlaceholders(room.pattern);
    const body = params.length
      ? `\`${mapRoomPattern(room.pattern, (t) => t.replace(/[`$\\]/g, '\\$&'), (p) => `\${${p}}`)}\``
      : `'${room.pattern}'`;
    out += `${doc(room.description, '  ')}  ${key(name)}: (${params.map((p) => `${p}: string`).join(', ')}) => ${body},\n`;
  }
  out += `} as const;\n\n`;
  out += `/** Exactly the declared rooms. */\n`;
  out += `export const ${n.roomRegex} = /${roomPatternsRegExp(rooms.map(([, r]) => r.pattern)).source.replace(/\//g, '\\/')}/;\n\n`;
  out += `export function ${n.isValidRoom}(room: string): boolean {\n  return ${n.roomRegex}.test(room);\n}\n`;

  out += '\n// ─── Jobs ────────────────────────────────────────────────────────────────────\n\n';
  out += `/** Every kind of job the events settle: its completion, its failure and the field its id is in. */\n`;
  out += `export const ${n.jobKinds} = {\n`;
  for (const kind of catalog.jobKinds()) {
    out += `  ${key(kind.kind)}: {\n`;
    out += `    completion: '${kind.completion.name}',\n`;
    out += `    failure: ${kind.failure ? `'${kind.failure.name}'` : 'null'},\n`;
    out += `    correlation: '${kind.correlation}',\n`;
    out += `    description: ${literal(kind.completion.description)},\n`;
    out += `  },\n`;
  }
  out += `} as const;\n`;

  out += '\n// ─── The document ────────────────────────────────────────────────────────────\n\n';
  out += `/** The declaration document these types were generated from. */\n`;
  out += `export const ${n.declarations}: EventDeclarationDocument = ${JSON.stringify(document, null, 2)};\n`;
  return out;
}

export { defaultTypeName };
