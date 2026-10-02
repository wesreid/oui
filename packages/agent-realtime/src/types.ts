/**
 * The realtime server's seams (ADR-0227 §2.2). The product supplies every one;
 * the server refuses to start, naming the seam, when one is missing. None has
 * a default taken from any one product.
 */
import type { EventCatalog } from '@ouispec/agent-events';
import type { ClientEvent } from './client-events/chain.js';
import type { RealtimeLogger } from './logger.js';

/**
 * Auth verifier: verifies the product's own user tokens. Called once per
 * socket, at connection; the identity it returns is the only identity any
 * client event is authorized against.
 */
export interface AuthAdapter {
  verify(token: string): Promise<AuthResult>;
}

export interface AuthResult {
  userId: string;
  accountId?: string;
  platformAdmin?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Room policy: which rooms exist, which a socket is placed in by its identity,
 * and who may join the rest.
 *
 * A room that `requiresToken` is joined only with a room token minted for this
 * user and this exact room (`POST /internal/room-token`). The product decides
 * who gets one, by running the resource's own read authorization before it
 * asks for the token — for Closure, studio-api's `POST /realtime/room-tokens`.
 * The server only signs and checks.
 */
export interface RoomPolicy {
  /** A well-formed room name this product uses. Anything else is refused everywhere. */
  isValidRoom(room: string): boolean;
  /** The rooms a socket joins on connect, from its identity alone. It can never leave them. */
  identityRooms(user: AuthResult): string[];
  /** True when joining `room` needs a room token; tokens are minted only for these rooms. */
  requiresToken(room: string): boolean;
  /** For a room that needs no token: may this identity join it? */
  canJoin(room: string, user: AuthResult): boolean;
}

/** What validates a payload. Joi schemas satisfy it. */
export interface PayloadSchema {
  validate(value: unknown, options?: Record<string, unknown>): { value?: unknown; error?: { message: string } };
}

/**
 * An event a client may relay. With `events`, the declaration supplies the
 * rooms it may go to and its data schema, and both fields may be left out;
 * without them, both are required.
 */
export interface RelayRule {
  /** The room prefix this event may be relayed to, e.g. 'avatar' for `avatar:{id}`. */
  roomPrefix?: string;
  /** The event's `data`. */
  data?: PayloadSchema;
}

export interface RedisConfig {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
}

export interface RoomTokenConfig {
  /**
   * Signs room tokens (HMAC-SHA256). At least 32 characters, one per
   * environment, from the product's secret store. It is not the internal key:
   * a token secret and an API key are different secrets.
   */
  secret: string;
  /** How long a token admits its holder. Default 15 minutes. */
  ttlMs?: number;
}

export interface ApprovalsConfig {
  /**
   * Signs approval tokens (HS256, ADR-0228 §2.3). At least 32 characters, one
   * per environment, from the product's secret store. It is neither the
   * internal key nor the room-token secret: an engine that verifies approval
   * tokens holds this key and nothing else.
   */
  signingKey: string;
}

/** Everything the server needs. Every field without a `?` is a required seam. */
export interface RealtimeServerConfig {
  auth: AuthAdapter;
  roomPolicy: RoomPolicy;
  /** Guards every internal endpoint: emit, room tokens, UI action results, approvals. */
  internalApiKey: string;
  roomTokens: RoomTokenConfig;
  /** The approval store: an irreversible action runs only on an approval the user gave (ADR-0228). */
  approvals: ApprovalsConfig;
  /**
   * UI action results and room fan-out across instances meet here, so a
   * worker's wait can be served by an instance other than the client's.
   */
  redis: RedisConfig;
  /** Browser origins allowed to connect. Pass `['*']` only deliberately. */
  corsOrigins: string[];
  /** The port to listen on. `0` picks a free one (see `RealtimeServerInstance.port`). */
  port: number;
  /**
   * The product's event declarations, with the platform's own
   * (`createEventCatalog(PLATFORM_EVENTS, productEvents)`, ADR-0227 §2.4).
   * Given them, `/api/emit` refuses an undeclared event, a payload its schema
   * rejects and a room it is not declared for; a client relays only a
   * declared notice; and every completion or failure is kept as its job's
   * settlement (`GET /internal/events/settlements/:kind/:id`).
   */
  events?: EventCatalog;
  /**
   * The only events a client may relay to other clients: the room prefix each
   * may go to, and its data schema. Anything not listed is refused, and a
   * client relays only into rooms its socket has joined. Server events (turn,
   * UI action and job events) must never be listed; with `events`, listing
   * one fails at start-up.
   */
  relay?: Readonly<Record<string, RelayRule>>;
  /**
   * The product's own client events, beside the built-in `subscribe`,
   * `unsubscribe`, `relay` and the OUI action result. Each goes through the
   * same chain (declared, rate-limited, schema-checked, authorized).
   */
  clientEvents?: readonly ClientEvent[];
  /** Structured logger; pino satisfies it. Default: JSON lines on the console. */
  logger?: RealtimeLogger;
  pingInterval?: number;
  pingTimeout?: number;
}
