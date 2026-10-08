/**
 * The realtime server: one implementation for every product (ADR-0227 §2.1).
 *
 * It carries turn events and the product's declared events to rooms, holds
 * UI action results for the agent worker (ADR-0209), keeps the approvals an
 * irreversible action waits on (ADR-0228), keeps the conversations a person on
 * the staff holds (ADR-0260), signs and checks room tokens, and accepts only
 * declared client events. The product supplies the
 * seams (types.ts); nothing here belongs to one product.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { RealtimeServerConfig } from './types.js';
import { assertRealtimeServerConfig } from './config.js';
import { createConsoleLogger, type RealtimeLogger } from './logger.js';
import { registerClientEvents, assertUniqueClientEvents, type AuthenticatedSocket } from './client-events/chain.js';
import { createBuiltinClientEvents } from './client-events/builtin.js';
import { createRoomTokenSigner, type RoomTokenSigner } from './rooms/room-token.js';
import { createOUIResultStore, type OUIResultStore } from './oui/results.js';
import { createApprovalTokenSigner } from './approvals/token.js';
import { createApprovalStore, type ApprovalStore } from './approvals/store.js';
import { createTurnStopStore, type TurnStopStore } from './turns/stops.js';
import { createConversationHoldStore, type ConversationHoldStore } from './conversations/holds.js';
import { conversationsRouter } from './conversations/routes.js';
import { createTurnStopEvent } from './turns/client-event.js';
import { turnStopsRouter } from './turns/routes.js';
import { createApprovalDecideEvent } from './approvals/client-event.js';
import { approvalRouter } from './approvals/routes.js';
import { createDeclaredEvents } from './events/declared.js';
import { createSettlementStore, type SettlementStore } from './events/settlements.js';
import {
  createInternalKeyCheck,
  emitRouter,
  healthRouter,
  ouiResultsRouter,
  roomTokenRouter,
  settlementsRouter,
  type RouteDeps,
} from './http/routes.js';

export interface RealtimeServerInstance {
  io: Server;
  httpServer: http.Server;
  /** The port the server listens on (the one picked, when configured with 0). */
  port: number;
  /** Signs and checks room tokens with the configured secret. */
  roomTokens: RoomTokenSigner;
  /** The UI action result store. */
  results: OUIResultStore;
  /** The approval store (ADR-0228). */
  approvals: ApprovalStore;
  /** Job settlements, when the server has event declarations. */
  settlements: SettlementStore | null;
  /** Stop requests for turns (ADR-0252). */
  stops: TurnStopStore;
  /** Conversations a person on the staff holds (ADR-0260). */
  holds: ConversationHoldStore;
  close(): Promise<void>;
}

function connectRedis(config: RealtimeServerConfig['redis'], label: string, logger: RealtimeLogger): Redis {
  const client = new Redis({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    tls: config.tls ? {} : undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 10_000);
      logger.warn({ label, attempt: times, nextRetryMs: delay }, 'Redis retry');
      return delay;
    },
  });
  client.on('error', (err) => logger.error({ err, label }, 'Redis client error'));
  return client;
}

export async function createRealtimeServer(config: RealtimeServerConfig): Promise<RealtimeServerInstance> {
  assertRealtimeServerConfig(config);
  const logger = config.logger ?? createConsoleLogger();
  const roomTokens = createRoomTokenSigner(config.roomTokens);
  const approvalTokens = createApprovalTokenSigner(config.approvals);
  // Compiled before anything connects: a payload schema that cannot compile
  // fails start-up, naming the event.
  const declared = config.events ? createDeclaredEvents(config.events) : null;

  // Redis first: without it there is no result store and no fan-out, so the
  // server does not accept connections it cannot serve.
  const pub = connectRedis(config.redis, 'pub', logger);
  const sub = connectRedis(config.redis, 'sub', logger);
  // Subscriber mode takes over a connection, and `sub` belongs to the socket.io
  // adapter, so UI action results get a subscriber of their own.
  const resultsSub = connectRedis(config.redis, 'oui-results-sub', logger);
  const redisClients = [pub, sub, resultsSub];
  try {
    await Promise.all(redisClients.map((c) => c.connect()));
  } catch (err) {
    redisClients.forEach((c) => c.disconnect());
    throw new Error(
      `[agent-sdk-realtime] Redis at ${config.redis.host}:${config.redis.port} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const results = createOUIResultStore(pub, resultsSub, logger);
  const approvals = createApprovalStore(pub, approvalTokens, logger);
  const holds = createConversationHoldStore(pub, logger);
  // A hold is a stop for every turn of its conversation (ADR-0260 §2.3).
  const stops = createTurnStopStore(pub, resultsSub, logger, holds);
  const settlements = declared ? createSettlementStore(pub, resultsSub, logger) : null;

  const clientEvents = [
    ...createBuiltinClientEvents({
      roomPolicy: config.roomPolicy,
      roomTokens,
      relay: config.relay ?? {},
      declared,
      results: () => results,
    }),
    createApprovalDecideEvent(() => approvals),
    createTurnStopEvent(config.roomPolicy, () => stops),
    ...(config.clientEvents ?? []),
  ];
  assertUniqueClientEvents(clientEvents);

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, methods: ['GET', 'POST'], credentials: true },
    pingInterval: config.pingInterval ?? 25_000,
    pingTimeout: config.pingTimeout ?? 20_000,
  });
  io.adapter(createAdapter(pub, sub));

  const deps: RouteDeps = {
    io,
    roomPolicy: config.roomPolicy,
    roomTokens,
    results: () => results,
    declared,
    settlements: () => settlements,
    isInternalKey: createInternalKeyCheck(config.internalApiKey),
    logger,
  };
  app.use(healthRouter(deps));
  app.use(emitRouter(deps));
  app.use(roomTokenRouter(deps));
  app.use(ouiResultsRouter(deps));
  app.use(approvalRouter({ approvals, isInternalKey: deps.isInternalKey }));
  app.use(settlementsRouter(deps));
  app.use(turnStopsRouter({ stops: () => stops, isInternalKey: deps.isInternalKey, logger }));
  app.use(conversationsRouter({ io, roomPolicy: config.roomPolicy, holds: () => holds, isInternalKey: deps.isInternalKey, logger }));

  // Authentication, once per socket, through the product's verifier.
  io.use(async (socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers.authorization as string | undefined)?.replace(/^Bearer\s+/i, '');
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }
    try {
      const user = await config.auth.verify(token);
      if (!user || typeof user.userId !== 'string' || !user.userId) throw new Error('verifier returned no userId');
      (socket as AuthenticatedSocket).data = { user };
      next();
    } catch (err) {
      logger.warn({ err, socketId: socket.id }, 'Socket authentication failed');
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (raw) => {
    const socket = raw as AuthenticatedSocket;
    const { user } = socket.data;
    const identityRooms = config.roomPolicy.identityRooms(user);
    for (const room of identityRooms) socket.join(room);
    logger.info({ socketId: socket.id, userId: user.userId, accountId: user.accountId, rooms: identityRooms }, 'Client connected');

    registerClientEvents(io, socket, clientEvents, logger);

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, userId: user.userId, reason }, 'Client disconnected');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  logger.info({ port, declaredEvents: config.events?.names().length ?? null }, 'Realtime server listening');

  return {
    io,
    httpServer,
    port,
    roomTokens,
    results,
    approvals,
    settlements,
    stops,
    holds,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all(redisClients.map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}
