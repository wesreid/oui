/**
 * Test support for products and their tests: a fixture product's API, with an
 * OpenAPI document and a server that enforces its own auth and permissions.
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
