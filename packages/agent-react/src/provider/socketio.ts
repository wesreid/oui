import { io } from 'socket.io-client';
import type { AgentRealtimeConfig, SocketLike } from '@ouispec/agent-core';

/**
 * The default socket: a Socket.IO client that reconnects forever and asks
 * `getToken` for a fresh token on every connection. It is created unconnected;
 * the provider connects it.
 */
export const createSocketIOSocket: NonNullable<AgentRealtimeConfig['createSocket']> = ({ url, getToken }) =>
  io(url, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    auth: async (cb) => {
      const token = await getToken();
      cb({ token });
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 30_000,
    reconnectionAttempts: Infinity,
  }) satisfies SocketLike;
