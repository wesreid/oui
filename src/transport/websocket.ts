import type { OUITransport, OUITransportConfig, OUIActionHandler, OUIObservationHandler } from './types.js';
import type { OUISurface, OUIObservationUpdate } from '../spec/index.js';

/**
 * WebSocket transport using Socket.IO.
 * Maps OUI protocol events to socket events with a configurable namespace prefix.
 *
 * Events emitted:
 *   {ns}:dispatch        — action dispatch (server → client)
 *   {ns}:observation     — observation update (client → server)
 *   {ns}:surface:register   — surface registration (client → server)
 *   {ns}:surface:deregister — surface deregistration (client → server)
 */
export function createWebSocketTransport(
  socket: SocketLike,
  config?: OUITransportConfig,
): OUITransport {
  const ns = config?.namespace ?? 'oui';
  const buffer: Array<{ event: string; data: unknown }> = [];
  const maxBuffer = config?.maxBufferSize ?? 100;
  const shouldBuffer = config?.bufferWhileDisconnected ?? true;

  let connected = socket.connected ?? false;
  const connectionHandlers: Array<(c: boolean) => void> = [];

  // Track connection state
  socket.on('connect', () => {
    connected = true;
    connectionHandlers.forEach(h => h(true));
    // Flush buffer
    if (shouldBuffer) {
      while (buffer.length > 0) {
        const msg = buffer.shift()!;
        socket.emit(msg.event, msg.data);
      }
    }
  });

  socket.on('disconnect', () => {
    connected = false;
    connectionHandlers.forEach(h => h(false));
  });

  function emit(event: string, data: unknown) {
    if (connected) {
      socket.emit(event, data);
    } else if (shouldBuffer && buffer.length < maxBuffer) {
      buffer.push({ event, data });
    }
  }

  return {
    // ─── Dispatch Channel ───────────────────────────────────────
    dispatch(surfaceId, actionId, params) {
      emit(`${ns}:dispatch`, { surfaceId, actionId, params, timestamp: Date.now() });
    },

    onAction(handler: OUIActionHandler) {
      const listener = (data: { surfaceId: string; actionId: string; params: Record<string, unknown> }) => {
        handler(data.surfaceId, data.actionId, data.params);
      };
      socket.on(`${ns}:dispatch`, listener);
      return () => socket.off(`${ns}:dispatch`, listener);
    },

    // ─── Observation Channel ────────────────────────────────────
    pushObservation(update: OUIObservationUpdate) {
      emit(`${ns}:observation`, update);
    },

    onObservation(handler: OUIObservationHandler) {
      const listener = (data: OUIObservationUpdate) => handler(data);
      socket.on(`${ns}:observation`, listener);
      return () => socket.off(`${ns}:observation`, listener);
    },

    // ─── Surface Lifecycle ──────────────────────────────────────
    registerSurface(surface: OUISurface) {
      emit(`${ns}:surface:register`, { surface, timestamp: Date.now() });
    },

    deregisterSurface(surfaceId: string) {
      emit(`${ns}:surface:deregister`, { surfaceId, timestamp: Date.now() });
    },

    onSurfaceRegister(handler: (surface: OUISurface) => void) {
      const listener = (data: { surface: OUISurface }) => handler(data.surface);
      socket.on(`${ns}:surface:register`, listener);
      return () => socket.off(`${ns}:surface:register`, listener);
    },

    onSurfaceDeregister(handler: (surfaceId: string) => void) {
      const listener = (data: { surfaceId: string }) => handler(data.surfaceId);
      socket.on(`${ns}:surface:deregister`, listener);
      return () => socket.off(`${ns}:surface:deregister`, listener);
    },

    // ─── Connection ─────────────────────────────────────────────
    get connected() { return connected; },

    async connect() {
      if (connected) return;
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`OUI transport connect timeout (${config?.connectTimeoutMs ?? 10000}ms)`));
        }, config?.connectTimeoutMs ?? 10000);

        socket.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });

        if (typeof socket.connect === 'function') {
          socket.connect();
        }
      });
    },

    disconnect() {
      if (typeof socket.disconnect === 'function') {
        socket.disconnect();
      }
    },

    onConnectionChange(handler: (c: boolean) => void) {
      connectionHandlers.push(handler);
      return () => {
        const idx = connectionHandlers.indexOf(handler);
        if (idx >= 0) connectionHandlers.splice(idx, 1);
      };
    },
  };
}

/**
 * Minimal socket interface — compatible with Socket.IO client or server socket.
 * Only the methods OUI actually uses.
 */
export interface SocketLike {
  readonly connected?: boolean;
  emit(event: string, data: unknown): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
  connect?(): void;
  disconnect?(): void;
}
