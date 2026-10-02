/**
 * Real servers on one real Redis, and what a test does with them: connect a
 * browser, call an internal endpoint, mint a room token, emit, subscribe,
 * wait for an event. Shared by every integration suite.
 */
import { expect } from 'vitest';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createRealtimeServer, type RealtimeServerInstance } from '../server.js';
import type { RealtimeServerConfig } from '../types.js';
import { startTestRedis, type TestRedis } from '../testing/index.js';
import { fixtureRelay, fixtureRoomPolicy, recordingLogger, TEST_APPROVAL_KEY, TEST_TOKEN_SECRET } from './fixtures.js';

export interface Harness {
  logger: ReturnType<typeof recordingLogger>;
  /** A server on the harness's Redis, with the fixture seams plus `overrides`. */
  start(overrides?: Partial<RealtimeServerConfig>): Promise<RealtimeServerInstance>;
  connect(server: RealtimeServerInstance, token?: string): Promise<Socket>;
  internal(server: RealtimeServerInstance, path: string, init?: { method?: string; body?: unknown; key?: string }): Promise<Response>;
  mintToken(server: RealtimeServerInstance, userId: string, room: string): Promise<string>;
  emit(server: RealtimeServerInstance, event: string, data: unknown, rooms?: string[]): Promise<Response>;
  subscribe(socket: Socket, payload: unknown): Promise<{ ok: boolean; joined: string[]; denied?: string[] }>;
  close(): Promise<void>;
}

export const url = (s: RealtimeServerInstance) => `http://127.0.0.1:${s.port}`;

/** The next `event` the socket receives. */
export function next<T = unknown>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export async function createHarness(options: {
  key: string;
  users: Record<string, { userId: string; accountId?: string; platformAdmin?: boolean }>;
}): Promise<Harness> {
  const redis: TestRedis = await startTestRedis();
  const logger = recordingLogger();
  const servers: RealtimeServerInstance[] = [];
  const clients: Socket[] = [];

  const internal: Harness['internal'] = (server, path, init = {}) =>
    fetch(`${url(server)}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-api-key': init.key ?? options.key },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  return {
    logger,
    async start(overrides = {}) {
      const server = await createRealtimeServer({
        auth: {
          async verify(token) {
            const user = options.users[token];
            if (!user) throw new Error('unknown token');
            return user;
          },
        },
        roomPolicy: fixtureRoomPolicy,
        internalApiKey: options.key,
        roomTokens: { secret: TEST_TOKEN_SECRET },
        approvals: { signingKey: TEST_APPROVAL_KEY },
        redis: redis.config,
        corsOrigins: ['http://localhost'],
        port: 0,
        relay: fixtureRelay,
        logger,
        ...overrides,
      });
      servers.push(server);
      return server;
    },
    async connect(server, token) {
      const socket = connectClient(url(server), { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
      clients.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err) => reject(err));
      });
      return socket;
    },
    internal,
    async mintToken(server, userId, room) {
      const res = await internal(server, '/internal/room-token', { body: { userId, room } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    },
    emit: (server, event, data, rooms) => internal(server, '/api/emit', { body: { event, data, rooms } }),
    subscribe: (socket, payload) => new Promise((resolve) => socket.emit('subscribe', payload, resolve)),
    async close() {
      clients.forEach((c) => c.disconnect());
      await Promise.all(servers.map((s) => s.close()));
      await redis.stop();
    },
  };
}
