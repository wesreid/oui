import type {
  OUITransport,
  OUIActionHandler,
  OUIObservationHandler,
  OUIResultHandler,
} from "./types.js";
import type { OUISurface, OUIObservationUpdate } from "../spec/index.js";

/**
 * Direct transport — for same-process communication.
 * Used for API surfaces (where the agent runtime and surface are in the same Lambda)
 * and for testing (where you want synchronous, in-memory communication).
 *
 * Creates a paired (server, client) transport where messages sent on one
 * side are immediately received on the other.
 */
export function createDirectTransportPair(): {
  server: OUITransport;
  client: OUITransport;
} {
  const actionHandlers: OUIActionHandler[] = [];
  const resultHandlers: OUIResultHandler[] = [];
  const observationHandlers: OUIObservationHandler[] = [];
  const surfaceRegisterHandlers: Array<(s: OUISurface) => void> = [];
  const surfaceDeregisterHandlers: Array<(id: string) => void> = [];

  function subscribe<T>(list: T[], handler: T): () => void {
    list.push(handler);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  const noop = () => {};
  const unsubscribed = () => noop;

  const server: OUITransport = {
    dispatch(request) {
      // Server dispatches → client receives
      actionHandlers.forEach((h) => h(request));
    },
    onAction: unsubscribed, // Server doesn't receive dispatches
    sendResult: noop, // Server doesn't answer requests
    onResult(handler) {
      return subscribe(resultHandlers, handler);
    },
    pushObservation: noop, // Server doesn't push observations
    onObservation(handler) {
      return subscribe(observationHandlers, handler);
    },
    registerSurface: noop,
    deregisterSurface: noop,
    onSurfaceRegister(handler) {
      return subscribe(surfaceRegisterHandlers, handler);
    },
    onSurfaceDeregister(handler) {
      return subscribe(surfaceDeregisterHandlers, handler);
    },
    get connected() {
      return true;
    },
    async connect() {},
    disconnect: noop,
    onConnectionChange: unsubscribed,
    dispose: noop,
  };

  const client: OUITransport = {
    dispatch: noop, // Client doesn't dispatch
    onAction(handler) {
      return subscribe(actionHandlers, handler);
    },
    sendResult(result) {
      // Client answers → server receives
      resultHandlers.forEach((h) => h(result));
    },
    onResult: unsubscribed, // Client doesn't receive results
    pushObservation(update: OUIObservationUpdate) {
      // Client pushes → server receives
      observationHandlers.forEach((h) => h(update));
    },
    onObservation: unsubscribed, // Client doesn't receive observations
    registerSurface(surface) {
      surfaceRegisterHandlers.forEach((h) => h(surface));
    },
    deregisterSurface(surfaceId) {
      surfaceDeregisterHandlers.forEach((h) => h(surfaceId));
    },
    onSurfaceRegister: unsubscribed,
    onSurfaceDeregister: unsubscribed,
    get connected() {
      return true;
    },
    async connect() {},
    disconnect: noop,
    onConnectionChange: unsubscribed,
    dispose: noop,
  };

  return { server, client };
}
