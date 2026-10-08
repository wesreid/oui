/**
 * Test support for products and their tests: a fixture product's API, with an
 * OpenAPI document and a server that enforces its own auth and permissions;
 * and recorded model responses, kept and replayed through a provider's real
 * package.
 */
export {
  startDeskApi,
  deskOpenApiDocument,
  deskAgentHeaders,
  DESK_USERS,
  DESK_SESSIONS,
  DESK_AGENT_OPERATIONS,
  DESK_PA_OPERATIONS,
} from './openapi-fixture.js';
export type { DeskApi, DeskApiOptions, DeskRequest, DeskUser } from './openapi-fixture.js';
export { DESK_EVENTS, deskEvents } from './desk-events.js';
export { recordingFetch, replayingFetch, ReplayExhaustedError, ReplayMismatchError } from './cassette.js';
export type { RecordedExchange } from './cassette.js';
