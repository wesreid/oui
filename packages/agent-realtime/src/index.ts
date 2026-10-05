/**
 * @ouispec/agent-realtime — the realtime server for agent turns and
 * UI actions.
 *
 * The product supplies: an auth verifier, a room policy, the internal key, the
 * room-token secret, the approval signing key, Redis and its CORS origins,
 * and optionally its event declarations (ADR-0227 §2.2).
 * The server handles: declared client events, room tokens, the UI action
 * result store, the approval store, the emit API (held to the declarations),
 * job settlements, and fan-out across instances.
 */

export type {
  RealtimeServerConfig,
  AuthAdapter,
  AuthResult,
  RoomPolicy,
  RelayRule,
  PayloadSchema,
  RedisConfig,
  RoomTokenConfig,
  ApprovalsConfig,
} from './types.js';
export { createRealtimeServer } from './server.js';
export type { RealtimeServerInstance } from './server.js';
export { assertRealtimeServerConfig } from './config.js';

export { defineClientEvent, registerClientEvents } from './client-events/chain.js';
export type {
  ClientEvent,
  ClientEventDefinition,
  ClientEventContext,
  Authorization,
  AuthenticatedSocket,
} from './client-events/chain.js';
export { relayRefusal } from './client-events/builtin.js';

export { createRoomTokenSigner, DEFAULT_ROOM_TOKEN_TTL_MS } from './rooms/room-token.js';
export type { RoomTokenSigner, RoomTokenPayload } from './rooms/room-token.js';
export { joinRefusal } from './rooms/join.js';

export { createOUIResultStore, RESULT_TTL_SEC, FINAL_RESULT_TTL_SEC } from './oui/results.js';
export type { OUIResultStore } from './oui/results.js';
export type { ResultsRedis, ResultsSubscriber } from './redis-waits.js';
export { createSettlementStore, SETTLEMENT_TTL_SEC } from './events/settlements.js';
export type { SettlementStore } from './events/settlements.js';
export { createTurnStopStore, TURN_STOP_TTL_SEC } from './turns/stops.js';
export type { TurnStopStore } from './turns/stops.js';
export { createTurnStopEvent } from './turns/client-event.js';
export { turnStopsRouter, MAX_STOP_WAIT_MS } from './turns/routes.js';
export { MAX_RESULT_WAIT_MS } from './http/routes.js';

export { createConsoleLogger } from './logger.js';
export type { RealtimeLogger } from './logger.js';

export { createApprovalStore, DECLINED_TTL_SEC } from './approvals/store.js';
export type { ApprovalStore, ApprovalRedis } from './approvals/store.js';
export { createApprovalTokenSigner, MIN_APPROVAL_KEY_LENGTH } from './approvals/token.js';
export type { ApprovalTokenSigner, ApprovalTokenCheck } from './approvals/token.js';
