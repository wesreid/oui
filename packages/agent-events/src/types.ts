/**
 * The event declaration document: what a product says about every event its
 * backend emits over realtime (ADR-0227 §2.2, §2.4).
 *
 * The platform follows it: the realtime server emits and relays declared
 * events only, the worker's async tools wait on a declared completion event,
 * and the UI's job tracker is built from it. A name absent from it fails the
 * build. The JSON Schema of this document is `EVENT_DECLARATIONS_SCHEMA`
 * (published as `@ouispec/agent-events/schema.json`).
 */

import type { EventPayloadSchema } from '@ouispec/contract';

// The document's shapes are the contract's (`event-declarations.json`),
// generated from its schema.
export type {
  EventDeclaration,
  EventDeclarationDocument,
  EventRole,
  FailureReason,
  JsonType,
  RoomDeclaration,
} from '@ouispec/contract';

/**
 * A JSON Schema (draft 2020-12). A payload may use any keyword; the platform
 * reads `$ref` (to the document's `$defs`), `allOf`, `type`, `properties` and
 * `required` to find the fields it correlates and reports on, and validates
 * the rest with a full validator.
 */
export type JsonSchema = EventPayloadSchema;

export const EVENT_DECLARATIONS_VERSION = 1;

/** The room an agent turn's events go to; each host names it in the turn. */
export const TURN_ROOM = 'turn';
