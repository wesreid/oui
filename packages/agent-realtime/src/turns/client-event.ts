/**
 * `agent:turn_stop` (ADR-0252 §2.1): the person's Stop, on their own
 * authenticated socket.
 *
 * What makes a stop the owner's is the key it is kept under, not the room.
 * Who is asking is the socket's verified identity, never one the payload
 * names; the stop is kept under that user; and a turn's worker reads only the
 * stop of its turn's own user. So a stop from anyone else is never heard, and
 * cannot stand in the way of the owner's.
 *
 * The room check is narrower than it may look. The server does not know which
 * room belongs to which turn (each host names its own), so it cannot check
 * that `room` is this turn's. It checks only that the socket is in the room it
 * names and that the room is one that needs a token. A socket in any
 * token-guarded room can therefore write a stop for any turn id, but only
 * under its own user, where no other user's worker will read it. The check
 * keeps the event to sockets that hold a room token at all, and nothing more.
 */
import Joi from 'joi';
import { TURN_STOP_EVENT, type TurnStopPayload, type TurnStopResult } from '@ouispec/agent-core';
import { defineClientEvent, type ClientEvent } from '../client-events/chain.js';
import type { RoomPolicy } from '../types.js';
import type { TurnStopStore } from './stops.js';

const turnStopSchema = Joi.object({
  turnId: Joi.string().min(1).max(128).required(),
  room: Joi.string().min(1).max(200).required(),
});

export function createTurnStopEvent(roomPolicy: RoomPolicy, stops: () => TurnStopStore): ClientEvent {
  return defineClientEvent<TurnStopPayload>({
    name: TURN_STOP_EVENT,
    schema: turnStopSchema,
    maxBytes: 1024,
    // A person presses Stop; a burst is a script.
    rate: { perSecond: 2, burst: 5 },
    authorize: ({ socket }, payload) =>
      roomPolicy.isValidRoom(payload.room) && roomPolicy.requiresToken(payload.room) && socket.rooms.has(payload.room)
        ? { ok: true }
        : { ok: false, reason: `not in the turn's room` },
    refusal: (reason): TurnStopResult => ({
      ok: false,
      reason: reason === `not in the turn's room` ? 'not_in_turn_room' : 'invalid',
    }),
    handle: async ({ user }, payload, ack) => {
      const { first } = await stops().request(payload.turnId, user.userId, 'user_stop');
      const result: TurnStopResult = { ok: true, stop: first ? 'requested' : 'already' };
      ack?.(result);
    },
  });
}
