/**
 * OUI's own names for its wire events, read from OUI's transport rather than
 * written here: OUI owns its wire, and a copy of a name is how two ends drift
 * apart. The dispatch is declared among the platform's events; the result is
 * a client event the realtime server receives.
 */
import { createWebSocketTransport, type SocketLike } from 'oui-spec/transport';

export interface OuiWire {
  /** What the agent side emits to deliver a UI action request. */
  dispatch: string;
  /** What a tab emits to answer one. */
  result: string;
}

function captureWire(): OuiWire {
  let dispatch: string | null = null;
  let result: string | null = null;
  const capture: SocketLike = {
    connected: true,
    emit(event) {
      dispatch = event;
    },
    on(event) {
      result = event;
    },
    off() {},
    once() {},
  };
  const transport = createWebSocketTransport(capture);
  transport.dispatch({ requestId: 'capture', surfaceId: 'capture', actionId: 'capture', params: {}, timestamp: 0 });
  // The transport registers its connection listeners first; the last listener
  // registered is the result listener added here.
  transport.onResult(() => {});
  transport.dispose();
  if (!dispatch || !result) throw new Error('[agent-sdk-events] oui-spec transport emitted no dispatch or registered no result listener');
  return { dispatch, result };
}

export const OUI_WIRE: OuiWire = captureWire();
