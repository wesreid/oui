/**
 * What the provider shares with the SDK's own hooks and nothing else: its
 * configuration, its socket and how it joins a room. Not exported from the
 * package: an app reads the provider through `useAgent`.
 */
import { createContext } from 'react';
import type { AgentClientConfig, SocketLike } from '@ouispec/agent-core';
import type { DebugLogLevel, DebugLogNamespace } from './types.js';

export interface AgentInternals {
  config(): AgentClientConfig;
  /** The provider's socket, or null before it is made. */
  socket(): SocketLike | null;
  /** Whether the socket is connected now: a change re-renders the hooks that read it. */
  connected: boolean;
  /** Joins a room with its token, saying in the debug log whether the server let it. */
  joinRoom(socket: SocketLike, room: string, roomToken?: string): void;
  log(level: DebugLogLevel, ns: DebugLogNamespace, message: string, data?: unknown): void;
}

export const AgentInternalsContext = createContext<AgentInternals | null>(null);
