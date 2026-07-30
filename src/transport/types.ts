import type { OUISurface, OUIObservationUpdate } from '../spec/index.js';

/**
 * OUI Transport — the wire protocol between agent runtime and surfaces.
 *
 * Two one-way channels:
 * - Dispatch channel (server → client): sends action instructions
 * - Observation channel (client → server): pushes state updates
 *
 * NO request/response. NO correlation IDs. NO waiting.
 * The Lambda dispatches and terminates. The browser processes and pushes state.
 */
export interface OUITransport {
  // ─── Dispatch Channel (server → client) ─────────────────────────────

  /** Dispatch an action to a surface (one-way, fire-and-forget) */
  dispatch(surfaceId: string, actionId: string, params: Record<string, unknown>): void;

  /** Receive dispatched actions (surface/client side) */
  onAction(handler: OUIActionHandler): () => void;

  // ─── Observation Channel (client → server) ──────────────────────────

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
  disconnect(): void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
}

/** Handler for incoming action dispatches (client side) */
export type OUIActionHandler = (
  surfaceId: string,
  actionId: string,
  params: Record<string, unknown>,
) => void;

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

  /** Whether to buffer dispatches while disconnected */
  bufferWhileDisconnected?: boolean;

  /** Max buffer size (messages dropped after this) */
  maxBufferSize?: number;
}
