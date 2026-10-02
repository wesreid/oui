import type { SocketLike } from '@ouispec/agent-core';

type Handler = (...args: unknown[]) => void;

/** A socket the tests drive by hand: it records what the provider emits and fires what the server would send. */
export interface FakeSocket extends SocketLike {
  id: string;
  connected: boolean;
  handlers: Map<string, Handler[]>;
  emitted: Array<{ event: string; args: unknown[] }>;
  fire(event: string, ...args: unknown[]): void;
}

export function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const s: FakeSocket = {
    id: 's1',
    connected: false,
    handlers,
    emitted: [],
    on(event, h) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    off(event, h) {
      handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h));
    },
    once(event, h) {
      const wrapped: Handler = (...args) => {
        s.off(event, wrapped);
        h(...args);
      };
      s.on(event, wrapped);
    },
    emit(event, ...args) {
      s.emitted.push({ event, args });
    },
    connect() {
      s.connected = true;
      s.fire('connect');
    },
    disconnect() {
      s.connected = false;
    },
    fire(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
  return s;
}
