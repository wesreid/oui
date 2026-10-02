/**
 * The client events every realtime server accepts: joining and leaving rooms,
 * relaying an allow-listed event, and answering a UI action (ADR-0209). A
 * product declares its own events beside these (`config.clientEvents`).
 */
import Joi from 'joi';
import type { OUIActionResult } from 'oui-spec/spec';
import { defineClientEvent, type ClientEvent, type ClientEventContext } from './chain.js';
import { joinRefusal } from '../rooms/join.js';
import type { RoomTokenSigner } from '../rooms/room-token.js';
import type { OUIResultStore } from '../oui/results.js';
import { OUI_WIRE } from '@ouispec/agent-events';
import type { RelayRule, RoomPolicy } from '../types.js';
import { declaredRefusal, type DeclaredEvents } from '../events/declared.js';

// A client re-sends every room it holds on reconnect, in one subscribe.
const MAX_ROOMS = 100;
export const MAX_RELAY_ROOMS = 5;

export interface BuiltinClientEventDeps {
  roomPolicy: RoomPolicy;
  roomTokens: RoomTokenSigner;
  relay: Readonly<Record<string, RelayRule>>;
  /** The product's event declarations, when given: a relayed event is held to its declaration. */
  declared: DeclaredEvents | null;
  /** Resolved on use: the store exists once Redis is connected. */
  results: () => OUIResultStore;
}

type SubscribePayload = string | string[] | { rooms: string | string[]; tokens: Record<string, string> };

function normalizeSubscribe(payload: SubscribePayload): { rooms: string[]; tokens: Record<string, string> } {
  if (typeof payload === 'string') return { rooms: [payload], tokens: {} };
  if (Array.isArray(payload)) return { rooms: payload, tokens: {} };
  return { rooms: Array.isArray(payload.rooms) ? payload.rooms : [payload.rooms], tokens: payload.tokens ?? {} };
}

interface RelayPayload {
  event: string;
  data: unknown;
  rooms: string[];
}

/**
 * Why a relay is refused, or null when it is allowed: only an allow-listed
 * event, with valid data, into rooms of its kind that this socket has joined
 * (joining is where access to the resource is checked). With declarations,
 * the event's declaration decides its rooms and data as well as the rule.
 */
export function relayRefusal(
  relay: Readonly<Record<string, RelayRule>>,
  socketRooms: ReadonlySet<string>,
  payload: RelayPayload,
  declared: DeclaredEvents | null = null,
): string | null {
  const rule = relay[payload.event];
  if (!rule) return `event "${payload.event}" may not be relayed by a client`;
  if (declared) {
    const refusal = declaredRefusal(declared, payload.event, payload.data, payload.rooms, 'data');
    if (refusal) return refusal;
  }
  if (rule.data) {
    const { error } = rule.data.validate(payload.data, { convert: false });
    if (error) return `invalid "${payload.event}" data: ${error.message}`;
  }
  for (const room of payload.rooms) {
    if (rule.roomPrefix && !room.startsWith(`${rule.roomPrefix}:`)) return `"${payload.event}" may only go to ${rule.roomPrefix}: rooms`;
    if (!socketRooms.has(room)) return `not a member of ${room}`;
  }
  return null;
}

export function createBuiltinClientEvents(deps: BuiltinClientEventDeps): ClientEvent[] {
  const { roomPolicy, roomTokens, relay } = deps;

  const room = Joi.string()
    .max(200)
    .custom((value: string, helpers) => (roomPolicy.isValidRoom(value) ? value : helpers.error('any.invalid')));

  // ─── subscribe ─────────────────────────────────────────────────────────────
  // The bare forms (`'room'`, `['room']`) and the token-bearing form
  // (`{ rooms, tokens }`). Each room is judged on its own, so one refused room
  // does not refuse the others; the ack names each.
  const subscribe = defineClientEvent<SubscribePayload>({
    name: 'subscribe',
    schema: Joi.alternatives().try(
      room.required(),
      Joi.array().items(room.required()).min(1).max(MAX_ROOMS),
      Joi.object({
        rooms: Joi.alternatives().try(room.required(), Joi.array().items(room.required()).min(1).max(MAX_ROOMS)).required(),
        tokens: Joi.object().pattern(room, Joi.string().max(2048)).default({}),
      }),
    ),
    maxBytes: 64 * 1024,
    rate: { perSecond: 10, burst: 40 },
    handle: ({ socket, user, logger }, payload, ack) => {
      const { rooms, tokens } = normalizeSubscribe(payload);
      const joined: string[] = [];
      const denied: string[] = [];
      const reasons: Record<string, string> = {};
      for (const r of rooms) {
        const refusal = joinRefusal(roomPolicy, roomTokens, r, user, tokens[r]);
        if (refusal) {
          denied.push(r);
          reasons[r] = refusal;
        } else {
          socket.join(r);
          joined.push(r);
        }
      }
      if (denied.length > 0) logger.warn({ socketId: socket.id, userId: user.userId, denied: reasons }, 'Room subscription denied');
      if (joined.length > 0) logger.info({ socketId: socket.id, userId: user.userId, joined }, 'Subscribed to rooms');
      ack?.({ ok: denied.length === 0, joined, denied: denied.length > 0 ? denied : undefined });
    },
  });

  // ─── unsubscribe ───────────────────────────────────────────────────────────
  const unsubscribe = defineClientEvent<string | string[]>({
    name: 'unsubscribe',
    schema: Joi.alternatives().try(room.required(), Joi.array().items(room.required()).min(1).max(MAX_ROOMS)),
    maxBytes: 16 * 1024,
    rate: { perSecond: 10, burst: 40 },
    handle: ({ socket, user, logger }, payload, ack) => {
      const rooms = Array.isArray(payload) ? payload : [payload];
      // The rooms a socket is placed in by its identity cannot be left.
      const fixed = new Set(roomPolicy.identityRooms(user));
      for (const r of rooms) if (!fixed.has(r)) socket.leave(r);
      logger.info({ socketId: socket.id, rooms }, 'Unsubscribed from rooms');
      ack?.({ ok: true });
    },
  });

  // ─── relay ─────────────────────────────────────────────────────────────────
  const relayEvent = defineClientEvent<RelayPayload>({
    name: 'relay',
    schema: Joi.object({
      event: Joi.string().max(100).required(),
      data: Joi.any(),
      rooms: Joi.array().items(room.required()).min(1).max(MAX_RELAY_ROOMS).required(),
    }),
    maxBytes: 8 * 1024,
    rate: { perSecond: 5, burst: 20 },
    authorize: ({ socket }: ClientEventContext, payload) => {
      const refusal = relayRefusal(relay, socket.rooms, payload, deps.declared);
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    },
    handle: ({ io, socket, user, logger }, payload, ack) => {
      // To every member, the sender included: a tab updates its own view from
      // the relayed event, as every other tab does.
      io.to(payload.rooms).emit(payload.event, payload.data);
      logger.debug({ socketId: socket.id, userId: user.userId, event: payload.event, rooms: payload.rooms }, 'Relayed event');
      ack?.({ ok: true });
    },
  });

  // ─── OUI action result (ADR-0209) ──────────────────────────────────────────
  const ouiActionResult = defineClientEvent<OUIActionResult>({
    name: OUI_WIRE.result,
    schema: Joi.object({
      requestId: Joi.string().max(200).required(),
      success: Joi.boolean().required(),
    }).unknown(true),
    maxBytes: 512 * 1024,
    rate: { perSecond: 20, burst: 60 },
    // Scoped by construction: the answer is kept under this socket's user, and
    // the worker only ever collects answers for the turn's own user.
    //
    // Acknowledged either way (oui-spec §7.3.6): a refusal — too large,
    // invalid, over the rate — is acknowledged by the chain with its reason, so
    // the tab sends the answer again trimmed instead of the worker waiting out
    // its deadline for an answer that was dropped.
    handle: async ({ socket, user, logger }, result, ack) => {
      const kept = await deps.results().store(user.userId, result);
      if (kept) {
        logger.info(
          {
            socketId: socket.id,
            userId: user.userId,
            requestId: result.requestId,
            success: result.success,
            interim: result.interim ?? false,
            ...(result.delivery ? { trimmed: result.delivery.omitted, refusedBecause: result.delivery.reason } : {}),
          },
          'OUI result received',
        );
      }
      ack?.({ ok: true, kept });
    },
  });

  return [subscribe, unsubscribe, relayEvent, ouiActionResult];
}
