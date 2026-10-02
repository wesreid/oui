/**
 * Client events: what a browser may send the server, declared and guarded.
 *
 * An HTTP API never runs a handler that is not declared: every route has a
 * schema and a chain of middleware (authentication, account, permission) in
 * front of it. A bare `socket.on(...)` has none of that, and trusts its
 * payload. That is how a `relay` handler once sent whatever event a client
 * named to whatever room it named, so any signed-in user could send
 * `oui:dispatch` into another account's tabs (ADR-0227, W0).
 *
 * Every client event goes through one chain, the socket counterpart of a
 * route module:
 *
 *   1. declared — an event with no definition is refused and logged;
 *   2. rate limit — per socket, per event (token bucket);
 *   3. size, then schema — bounded bytes of JSON, then the event's schema;
 *   4. authorize — the definition's own rule, against the socket's verified
 *      identity (never an identity the payload claims);
 *   5. handle.
 *
 * Authentication happens once, at connection, through the product's
 * `AuthAdapter`.
 */
import type { Server, Socket } from 'socket.io';
import type { AuthResult, PayloadSchema } from '../types.js';
import type { RealtimeLogger } from '../logger.js';

export interface AuthenticatedSocket extends Socket {
  data: { user: AuthResult };
}

export interface ClientEventContext {
  io: Server;
  socket: AuthenticatedSocket;
  user: AuthResult;
  logger: RealtimeLogger;
}

export type Authorization = { ok: true } | { ok: false; reason: string };

export type Ack = (response: unknown) => void;

export interface ClientEventDefinition<P = unknown> {
  /** The event name the client emits. */
  name: string;
  /** Validates the payload. Unknown keys should be refused. */
  schema: PayloadSchema;
  /** Largest payload accepted, in bytes of JSON. */
  maxBytes: number;
  /** Token bucket per socket: sustained events per second, and burst. */
  rate: { perSecond: number; burst: number };
  /** May this socket's user do this, with this payload? Omit only when the handler scopes itself to the user. */
  authorize?: (ctx: ClientEventContext, payload: P) => Authorization;
  /** What a refusal is answered with, when the client passed an ack. */
  refusal?: (reason: string) => unknown;
  handle: (ctx: ClientEventContext, payload: P, ack?: Ack) => void | Promise<void>;
}

/** A declared event, with its payload type sealed inside: what the connection handler attaches. */
export interface ClientEvent {
  readonly name: string;
  /** The guarded socket.io listener for one socket. */
  listener(ctx: ClientEventContext): (raw: unknown, ack?: unknown) => void;
}

/** Declares a client event; the generic keeps `schema`, `authorize` and `handle` in step. */
export function defineClientEvent<P>(
  definition: ClientEventDefinition<P>,
): ClientEvent & { definition: ClientEventDefinition<P> } {
  return { name: definition.name, definition, listener: (ctx) => guard(ctx, definition) };
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ─── The chain ───────────────────────────────────────────────────────────────

function payloadBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? null));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Runs one event through the chain and returns a handler socket.io can call. */
function guard<P>(ctx: ClientEventContext, definition: ClientEventDefinition<P>) {
  const bucket = new TokenBucket(definition.rate.perSecond, definition.rate.burst);
  const { socket, user, logger } = ctx;
  const refuse = (reason: string, ack: Ack | undefined) => {
    logger.warn(
      { socketId: socket.id, userId: user.userId, accountId: user.accountId, event: definition.name, reason },
      'Client event refused',
    );
    ack?.(definition.refusal ? definition.refusal(reason) : { ok: false, error: reason });
  };

  return (raw: unknown, maybeAck?: unknown) => {
    const ack = typeof maybeAck === 'function' ? (maybeAck as Ack) : undefined;

    if (!bucket.take()) return refuse('rate limit exceeded', ack);
    if (payloadBytes(raw) > definition.maxBytes) return refuse(`payload larger than ${definition.maxBytes} bytes`, ack);

    const { value, error } = definition.schema.validate(raw, { abortEarly: true, convert: false });
    if (error) return refuse(`invalid payload: ${error.message}`, ack);

    if (definition.authorize) {
      const decision = definition.authorize(ctx, value as P);
      if (!decision.ok) return refuse(decision.reason, ack);
    }

    Promise.resolve(definition.handle(ctx, value as P, ack)).catch((err: unknown) => {
      logger.error({ err, socketId: socket.id, userId: user.userId, event: definition.name }, 'Client event handler failed');
      ack?.({ ok: false, error: 'internal error' });
    });
  };
}

/** Refuses two declarations of one name: which one would run is otherwise an accident of order. */
export function assertUniqueClientEvents(events: readonly ClientEvent[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.name)) throw new Error(`[agent-sdk-realtime] Client event "${event.name}" is declared twice`);
    seen.add(event.name);
  }
}

/**
 * Attaches the declared events to a connected socket. Anything else the client
 * sends is refused and logged, so a probe for an undeclared event is visible.
 */
export function registerClientEvents(
  io: Server,
  socket: AuthenticatedSocket,
  events: readonly ClientEvent[],
  logger: RealtimeLogger,
): void {
  assertUniqueClientEvents(events);
  const ctx: ClientEventContext = { io, socket, user: socket.data.user, logger };
  const declared = new Set(events.map((e) => e.name));
  for (const event of events) socket.on(event.name, event.listener(ctx));

  let undeclaredLogged = 0;
  socket.onAny((event: string) => {
    if (declared.has(event)) return;
    // Bounded per socket: a flood of junk must not become a flood of logs.
    if (undeclaredLogged++ < 20) {
      logger.warn({ socketId: socket.id, userId: ctx.user.userId, event }, 'Undeclared client event refused');
    }
  });
}
