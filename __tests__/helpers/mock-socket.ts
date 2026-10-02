import type { SocketLike } from '../../src/transport/websocket.js';

type Listener = (...args: any[]) => void;

export interface MockSocket extends SocketLike {
  connected: boolean;
  emitted: Array<{ event: string; data: unknown; ack?: (response: unknown) => void }>;
  /** Deliver an event from the remote side. */
  receive(event: string, data?: unknown): void;
  /** Deliver an event from the remote side that asks for an acknowledgment. */
  receiveWithAck(event: string, data: unknown, ack: (response: unknown) => void): void;
  listenerCount(event?: string): number;
  disconnectCalls: number;
}

export function createMockSocket(opts: { connected?: boolean } = {}): MockSocket {
  const listeners = new Map<string, Listener[]>();
  const socket: MockSocket = {
    connected: opts.connected ?? true,
    emitted: [],
    disconnectCalls: 0,
    emit(event, data, ack?: (response: unknown) => void) {
      socket.emitted.push(typeof ack === 'function' ? { event, data, ack } : { event, data });
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    off(event, handler) {
      const arr = listeners.get(event);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    once(event, handler) {
      const wrapped: Listener = (...args) => {
        socket.off(event, wrapped);
        handler(...args);
      };
      socket.on(event, wrapped);
    },
    disconnect() {
      socket.disconnectCalls++;
    },
    receive(event, data) {
      for (const h of [...(listeners.get(event) ?? [])]) h(data);
    },
    receiveWithAck(event, data, ack) {
      for (const h of [...(listeners.get(event) ?? [])]) h(data, ack);
    },
    listenerCount(event) {
      if (event) return listeners.get(event)?.length ?? 0;
      let n = 0;
      for (const arr of listeners.values()) n += arr.length;
      return n;
    },
  };
  return socket;
}

/** Resolve after the given milliseconds (real timers). */
export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
