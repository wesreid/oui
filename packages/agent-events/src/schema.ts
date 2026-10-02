/**
 * The JSON Schema of an event declaration document, version 1.
 *
 * It is part of the OUI contract (`@ouispec/contract`,
 * `schemas/event-declarations.json`) and published here too, as
 * `@ouispec/agent-events/schema.json`: editors and other languages
 * validate a document against it. The catalog validates every document
 * against this same object (json-schema-lite.ts) before it checks what a
 * schema cannot say: that a room, a `$ref` or a correlation field exists, and
 * that each job kind has one completion.
 */
import { CONTRACT_SCHEMAS } from '@ouispec/contract';

import { EVENT_DECLARATIONS_VERSION } from './types.js';

export const EVENT_DECLARATIONS_SCHEMA_ID = `https://schemas.closurestudio.ai/agent-sdk/event-declarations/v${EVENT_DECLARATIONS_VERSION}.json`;

interface DeclarationSchemaShape {
  $id: string;
  properties: Record<'events' | 'rooms', { propertyNames: { pattern: string } }>;
  $defs: { RoomDeclaration: { properties: { pattern: { pattern: string } } } };
}

export const EVENT_DECLARATIONS_SCHEMA = CONTRACT_SCHEMAS['event-declarations.json'];
const shape = EVENT_DECLARATIONS_SCHEMA as unknown as DeclarationSchemaShape;
if (shape.$id !== EVENT_DECLARATIONS_SCHEMA_ID) {
  throw new Error(`[agent-sdk-events] the contract's event declaration schema is ${shape.$id}, not version ${EVENT_DECLARATIONS_VERSION}`);
}

/** An event name: lower-case segments, usually joined by `:` (`generation:completed`, `avatar:frame-reselect`). */
export const EVENT_NAME_PATTERN = shape.properties.events.propertyNames.pattern;
/** A room name in the document: `user`, `agentTurn`. */
export const ROOM_NAME_PATTERN = shape.properties.rooms.propertyNames.pattern;
/** A room pattern: literal `a-z 0-9 _ - :` with `{placeholder}`s. */
export const ROOM_PATTERN_PATTERN = shape.$defs.RoomDeclaration.properties.pattern.pattern;
