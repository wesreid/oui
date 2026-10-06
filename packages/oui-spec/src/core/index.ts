// Re-export spec types for convenience
export type {
  OUISurface,
  OUIAction,
  OUIObservation,
  OUIActivation,
  OUIActionRequest,
  OUIActionResult,
  OUIObservationUpdate,
  OUIObservationSnapshot,
  OUISurfaceSnapshot,
  OUISurfaceRegistration,
  OUISurfaceDeregistration,
  OUIProtocolEvent,
  OUIActionPolling,
  JSONSchema,
} from "../spec/index.js";

export { OUI_PROTOCOL_EVENTS } from "../spec/index.js";

// Core utilities
export {
  defineSurface,
  type SurfaceDefinition,
  type ActionDefinition,
  type ActionPollingConfig,
  type ActionHandlerResult,
  type ObservationDefinition,
  type DefinedSurface,
} from "./define-surface.js";
export { createOUI } from "./create-oui.js";
export {
  createSurfaceRuntime,
  ATTACHMENT_LIST_MAX,
} from "./surface-runtime.js";
export { acceptCurrentTurn } from "./accept-turn.js";
export type {
  SurfaceForm,
  SurfaceRuntime,
  SurfaceRuntimeOptions,
  AttachmentResolver,
  AttachmentText,
  SettleOptions,
  MountedSurface,
} from "./surface-runtime.js";
export type { OUIConfig, OUIInstance, OwnedTransport } from "./create-oui.js";
export type {
  OUIConfigError,
  DuplicateIds,
  ValidateSurfaceIds,
} from "./validate.js";
export type { OUIBranded } from "./brand.js";
