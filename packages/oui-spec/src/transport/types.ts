import type {
  OUISurface,
  OUIObservationUpdate,
  OUIActionRequest,
  OUIActionResult,
} from "../spec/index.js";

/**
 * OUI Transport — the wire protocol between agent runtime and surfaces.
 *
 * - Dispatch (runtime → client): an `OUIActionRequest`, carrying a `requestId`.
 * - Result (client → runtime): the `OUIActionResult` for that `requestId`.
 * - Observations (client → runtime): state updates pushed as they happen.
 * - Surface lifecycle (client → runtime): registration, for runtimes that keep
 *   a server-side registry. A runtime can instead take the client's snapshot.
 *
 * Every dispatch is answered by exactly one result. An earlier version of this
 * transport had no correlation id and no result channel, so an agent could
 * never learn whether its action ran, and was told it succeeded before the
 * client had done anything.
 */
export interface OUITransport {
  // ─── Dispatch (runtime → client) ────────────────────────────────────

  /** Send an action request to the client. */
  dispatch(request: OUIActionRequest): void;

  /** Receive action requests (client side). */
  onAction(handler: OUIActionHandler): () => void;

  // ─── Result (client → runtime) ──────────────────────────────────────

  /**
   * Answer an action request (client side). `onAcknowledged` is called with
   * the receiving side's acknowledgment: accepted, or refused with its reason
   * — too large, invalid, over a rate limit — so the client can answer again
   * in a form it accepts (§7.3.6). A receiver that does not acknowledge
   * answers never calls it.
   */
  sendResult(
    result: OUIActionResult,
    onAcknowledged?: (ack: OUIAcknowledgment) => void,
  ): void;

  /** Receive action results (runtime side). */
  onResult(handler: OUIResultHandler): () => void;

  // ─── Observation Channel (client → runtime) ─────────────────────────

  /** Push an observation update from the surface to the agent runtime */
  pushObservation(update: OUIObservationUpdate): void;

  /** Receive observation updates (runtime/server side) */
  onObservation(handler: OUIObservationHandler): () => void;

  // ─── Surface Lifecycle ──────────────────────────────────────────────

  /** Register a surface manifest (client → server) */
  registerSurface(surface: OUISurface): void;

  /** Deregister a surface (client → server) */
  deregisterSurface(surfaceId: string): void;

  /** Receive surface registrations (server side) */
  onSurfaceRegister(handler: (surface: OUISurface) => void): () => void;

  /** Receive surface deregistrations (server side) */
  onSurfaceDeregister(handler: (surfaceId: string) => void): () => void;

  // ─── Connection ─────────────────────────────────────────────────────

  readonly connected: boolean;
  connect(): Promise<void>;

  /** Disconnect the underlying socket. The integrator owns the socket: prefer `dispose`. */
  disconnect(): void;

  onConnectionChange(handler: (connected: boolean) => void): () => void;

  /**
   * Detach every listener this transport attached to its socket, and leave the
   * socket connected. A socket outlives the transports built on it; without
   * this, each one leaked its connection listeners onto the shared socket.
   */
  dispose(): void;
}

/**
 * Handler for incoming action requests (client side). `receipt`, when the
 * sender asked for one, acknowledges the request: received and accepted, or
 * refused with why (§7.3.7). The sender can then tell a request that reached a
 * client from one that reached nobody, and need not send it again.
 */
export type OUIActionHandler = (
  request: OUIActionRequest,
  receipt?: (ack: OUIAcknowledgment) => void,
) => void;

/** An acknowledgment: accepted, or refused with a reason. */
export type OUIAcknowledgment = { ok: true } | { ok: false; reason: string };

/** Handler for incoming action results (runtime side) */
export type OUIResultHandler = (result: OUIActionResult) => void;

/** Handler for incoming observation updates (server side) */
export type OUIObservationHandler = (update: OUIObservationUpdate) => void;

/**
 * Transport configuration options.
 */
export interface OUITransportConfig {
  /** Namespace prefix for events (default: 'oui') */
  namespace?: string;

  /** Connection timeout in ms */
  connectTimeoutMs?: number;

  /** Whether to buffer outbound messages while disconnected */
  bufferWhileDisconnected?: boolean;

  /** Max buffer size (messages dropped after this) */
  maxBufferSize?: number;
}
