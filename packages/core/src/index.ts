// Re-export spec types for convenience
export type {
  OUISurface,
  OUIAction,
  OUIObservation,
  OUIActivation,
  OUIActionRequest,
  OUIActionResult,
  OUIObservationUpdate,
  OUISurfaceRegistration,
  OUISurfaceDeregistration,
  OUIProtocolEvent,
  JSONSchema,
} from '@oui/spec';

export { OUI_PROTOCOL_EVENTS } from '@oui/spec';

// Core utilities
export {
  defineSurface,
  type SurfaceDefinition,
  type ActionDefinition,
  type ActionPollingConfig,
  type ActionHandlerResult,
  type ObservationDefinition,
  type DefinedSurface,
} from './define-surface.js';
