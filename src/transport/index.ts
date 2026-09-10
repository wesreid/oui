/**
 * Transport exports.
 *
 * `createOUI` is the supported integration path and builds the transport for
 * you. The constructors below remain exported for tests and for embedding OUI
 * in a runtime that owns its own wiring — but note that they return a plain
 * `OUITransport`, not the branded `OwnedTransport` that OUI's own APIs accept.
 * Reaching for one of these to integrate an application is what produced a
 * hand-rolled second implementation of the wire the first time around.
 */
export type {
  OUITransport,
  OUIActionHandler,
  OUIObservationHandler,
  OUITransportConfig,
} from "./types.js";

export { createWebSocketTransport } from "./websocket.js";
export type { SocketLike } from "./websocket.js";

export { createDirectTransportPair } from "./direct.js";
