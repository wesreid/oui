/**
 * `agent:turn_stop` (ADR-0252 §2.1): the person's Stop, on their own
 * authenticated socket.
 *
 * Who is asking is the socket's verified identity, never one the payload
 * names. The socket must be in the turn's room, which it can only have joined
 * with the room token the host minted for that turn, and that room must be one
 * that needs a token: a room anyone may join proves nothing. The stop is then
 * kept under that user, and the turn's worker reads only its own user's stop,
 * so a stop from anyone else is never heard.
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
