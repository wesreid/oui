/**
 * @ouispec/agent-events — event contracts the product declares
 * (ADR-0227 §2.4).
 *
 * The product supplies a declaration document: each event's payload schema,
 * the rooms it goes to, its correlation fields and its role in a job. The
 * platform follows it:
 * - the realtime server emits and relays declared events only;
 * - the worker's async tools wait on a declared completion or failure;
 * - the UI's job tracker is built from it;
 * - a name it does not hold fails the build.
 *
 * Browser-safe. Payload validation is `./validate`; TypeScript generation is
 * `./codegen` and the `agent-sdk-events` CLI.
 */
export type {
  EventDeclarationDocument,
  EventDeclaration,
  EventRole,
  FailureReason,
  RoomDeclaration,
  JsonSchema,
  JsonType,
} from './types.js';
export { EVENT_DECLARATIONS_VERSION, TURN_ROOM, CONVERSATION_ROOM, HOST_NAMED_ROOMS } from './types.js';
export { EVENT_DECLARATIONS_SCHEMA, EVENT_DECLARATIONS_SCHEMA_ID, EVENT_NAME_PATTERN } from './schema.js';
export {
  createEventCatalog,
  validateEventDeclarations,
  defaultTypeName,
  EventDeclarationError,
  UndeclaredEventError,
  AsyncBindingError,
} from './catalog.js';
export type { EventCatalog, DeclaredEvent, DeclaredRoom, JobKind, AsyncBinding, AsyncBindingSpec } from './catalog.js';
export type { Settlement, SettlementOutcome, SettlementRequest, EventWaiter } from './settlement.js';
export { roomPlaceholders, roomPatternsRegExp, formatRoom, ROOM_ID_CHARS } from './rooms.js';
export { payloadShape } from './payload-shape.js';
export { PLATFORM_EVENTS, AGENT_TURN_EVENTS, AGENT_CONVERSATION_EVENTS } from './platform.js';
export { OUI_WIRE } from './oui-wire.js';
export type { OuiWire } from './oui-wire.js';
