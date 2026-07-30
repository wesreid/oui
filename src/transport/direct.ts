import type { OUITransport, OUIActionHandler, OUIObservationHandler } from './types.js';
import type { OUISurface, OUIObservationUpdate } from '../spec/index.js';

/**
 * Direct transport — for same-process communication.
 * Used for API surfaces (where the agent runtime and surface are in the same Lambda)
 * and for testing (where you want synchronous, in-memory communication).
 *
 * Creates a paired (server, client) transport where messages sent on one
 * side are immediately received on the other.
 */
export function createDirectTransportPair(): { server: OUITransport; client: OUITransport } {
  const actionHandlers: OUIActionHandler[] = [];
  const observationHandlers: OUIObservationHandler[] = [];
  const surfaceRegisterHandlers: Array<(s: OUISurface) => void> = [];
  const surfaceDeregisterHandlers: Array<(id: string) => void> = [];

  const server: OUITransport = {
    dispatch(surfaceId, actionId, params) {
      // Server dispatches → client receives
      actionHandlers.forEach(h => h(surfaceId, actionId, params));
    },
    onAction() { return () => {}; }, // Server doesn't receive dispatches
    pushObservation() {}, // Server doesn't push observations
    onObservation(handler) {
      observationHandlers.push(handler);
      return () => { const i = observationHandlers.indexOf(handler); if (i >= 0) observationHandlers.splice(i, 1); };
    },
    registerSurface() {},
    deregisterSurface() {},
    onSurfaceRegister(handler) {
      surfaceRegisterHandlers.push(handler);
      return () => { const i = surfaceRegisterHandlers.indexOf(handler); if (i >= 0) surfaceRegisterHandlers.splice(i, 1); };
    },
    onSurfaceDeregister(handler) {
      surfaceDeregisterHandlers.push(handler);
      return () => { const i = surfaceDeregisterHandlers.indexOf(handler); if (i >= 0) surfaceDeregisterHandlers.splice(i, 1); };
    },
    get connected() { return true; },
    async connect() {},
    disconnect() {},
    onConnectionChange() { return () => {}; },
  };

  const client: OUITransport = {
    dispatch() {}, // Client doesn't dispatch
    onAction(handler) {
      actionHandlers.push(handler);
      return () => { const i = actionHandlers.indexOf(handler); if (i >= 0) actionHandlers.splice(i, 1); };
    },
    pushObservation(update: OUIObservationUpdate) {
      // Client pushes → server receives
      observationHandlers.forEach(h => h(update));
    },
    onObservation() { return () => {}; }, // Client doesn't receive observations
    registerSurface(surface) {
      surfaceRegisterHandlers.forEach(h => h(surface));
    },
    deregisterSurface(surfaceId) {
      surfaceDeregisterHandlers.forEach(h => h(surfaceId));
    },
    onSurfaceRegister() { return () => {}; },
    onSurfaceDeregister() { return () => {}; },
    get connected() { return true; },
    async connect() {},
    disconnect() {},
    onConnectionChange() { return () => {}; },
  };

  return { server, client };
}
