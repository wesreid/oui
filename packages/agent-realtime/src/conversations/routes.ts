/**
 * A conversation's hold and its messages, for the product's API (ADR-0260
 * §2.2). Every route takes the internal key: the product calls them from its
 * own routes, after its own check that this person may do this. The server
 * records and enforces; it never decides staff permissions.
 *
 *   GET  /internal/conversations/:id/hold            who holds it: 200 with the hold, 204 nobody
 *   POST /internal/conversations/:id/hold            { holder, rooms }  take it over
 *   POST /internal/conversations/:id/hold/release    { userId?, rooms } hand it back
 *   POST /internal/conversations/:id/messages        { message, rooms } announce a stored message
 *
 * The events these send (`agent:conversation_taken_over`,
 * `agent:conversation_handed_back`, `agent:conversation_message`) are sent by
 * these routes only: `/api/emit` refuses them, so an event never says a
 * conversation changed hands when its hold did not, and a staff message is
 * announced only while its speaker holds the conversation.
 *
 * Bodies are held to the contract's schemas (`conversation-takeover.json`).
 * 400 for a body or room that does not conform, 401 without the key, 409 when
 * the hold refuses (someone else holds it, or the speaker does not), 503
 * before Redis is connected.
 */
import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import {
  CONVERSATION_EVENTS,
  type AnnounceMessageRequest,
  type ConversationHandedBackEvent,
  type ConversationMessageEvent,
  type ConversationTakenOverEvent,
  type HandBackRequest,
  type TakeOverRequest,
} from '@ouispec/agent-core';
import { contractProblems, type ContractRef } from '@ouispec/contract/validate';
import type { RoomPolicy } from '../types.js';
import type { RealtimeLogger } from '../logger.js';
import type { ConversationHoldStore } from './holds.js';

export interface ConversationRouteDeps {
  io: Server;
  roomPolicy: RoomPolicy;
  /** Null until Redis is connected. */
  holds: () => ConversationHoldStore | null;
  isInternalKey: (presented: string | undefined) => boolean;
  logger: RealtimeLogger;
}

/** The events only these routes send. */
export const SERVER_SENT_CONVERSATION_EVENTS: ReadonlySet<string> = new Set(Object.values(CONVERSATION_EVENTS));

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function conversationsRouter(deps: ConversationRouteDeps): Router {
  const router = Router();

  /** The store and the conversation id, or null after answering why the request cannot be served. */
  function begin(req: Request, res: Response): { store: ConversationHoldStore; conversationId: string } | null {
    if (!deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return null;
    }
    const conversationId = req.params.conversationId as string;
    if (!ID.test(conversationId)) {
      res.status(400).json({ error: 'conversationId must be 1 to 200 letters, digits, and . _ : -' });
      return null;
    }
    const store = deps.holds();
    if (!store) {
      res.status(503).json({ error: 'Conversation hold store not connected' });
      return null;
    }
    return { store, conversationId };
  }

  /** The body, held to its contract schema and its rooms to the room policy; or null after a 400. */
  function body<T extends { rooms: readonly string[] }>(req: Request, res: Response, ref: ContractRef): T | null {
    const problems = contractProblems(ref, req.body ?? {});
    if (problems.length > 0) {
      res.status(400).json({ error: `invalid body: ${problems.join('; ')}` });
      return null;
    }
    const value = req.body as T;
    const invalid = value.rooms.filter((room) => !deps.roomPolicy.isValidRoom(room));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid room names: ${invalid.join(', ')}` });
      return null;
    }
    return value;
  }

  const send = (rooms: readonly string[], event: string, payload: unknown) => deps.io.to([...rooms]).emit(event, payload);

  router.get('/internal/conversations/:conversationId/hold', async (req, res) => {
    const ok = begin(req, res);
    if (!ok) return;
    try {
      const hold = await ok.store.get(ok.conversationId);
      if (!hold) {
        res.status(204).end();
        return;
      }
      res.json(hold);
    } catch (err) {
      deps.logger.error({ err, conversationId: ok.conversationId }, 'Conversation hold lookup failed');
      res.status(500).json({ error: 'Conversation hold lookup failed' });
    }
  });

  router.post('/internal/conversations/:conversationId/hold', async (req, res) => {
    const ok = begin(req, res);
    if (!ok) return;
    const request = body<TakeOverRequest>(req, res, 'TakeOverRequest');
    if (!request) return;
    try {
      const result = await ok.store.take(ok.conversationId, request.holder);
      if (!result.ok) {
        res.status(409).json(result);
        return;
      }
      if (result.change === 'taken_over') {
        send(request.rooms, CONVERSATION_EVENTS.TAKEN_OVER, {
          conversationId: ok.conversationId,
          hold: result.hold,
          at: Date.now(),
        } satisfies ConversationTakenOverEvent);
      }
      res.json(result);
    } catch (err) {
      deps.logger.error({ err, conversationId: ok.conversationId }, 'Conversation take-over failed');
      res.status(500).json({ error: 'Conversation take-over failed' });
    }
  });

  router.post('/internal/conversations/:conversationId/hold/release', async (req, res) => {
    const ok = begin(req, res);
    if (!ok) return;
    const request = body<HandBackRequest>(req, res, 'HandBackRequest');
    if (!request) return;
    try {
      const result = await ok.store.release(ok.conversationId, request.userId);
      if (!result.ok) {
        res.status(409).json(result);
        return;
      }
      if (result.change === 'handed_back') {
        send(request.rooms, CONVERSATION_EVENTS.HANDED_BACK, {
          conversationId: ok.conversationId,
          hold: result.hold,
          by: result.by,
          at: Date.now(),
        } satisfies ConversationHandedBackEvent);
      }
      res.json(result);
    } catch (err) {
      deps.logger.error({ err, conversationId: ok.conversationId }, 'Conversation hand-back failed');
      res.status(500).json({ error: 'Conversation hand-back failed' });
    }
  });

  router.post('/internal/conversations/:conversationId/messages', async (req, res) => {
    const ok = begin(req, res);
    if (!ok) return;
    const request = body<AnnounceMessageRequest>(req, res, 'AnnounceMessageRequest');
    if (!request) return;
    const { message } = request;
    try {
      if (message.role === 'staff') {
        if (!message.speaker) {
          res.status(400).json({ error: 'a staff message names its speaker' });
          return;
        }
        // Only the person holding the conversation speaks for the business in it.
        const hold = await ok.store.get(ok.conversationId);
        if (!hold || hold.holder.userId !== message.speaker.userId) {
          const reason = hold ? 'not_holder' : 'not_held';
          deps.logger.warn({ conversationId: ok.conversationId, speaker: message.speaker.userId, reason }, 'Staff message refused');
          res.status(409).json({ ok: false, reason });
          return;
        }
      }
      send(request.rooms, CONVERSATION_EVENTS.MESSAGE, {
        conversationId: ok.conversationId,
        message,
        at: Date.now(),
      } satisfies ConversationMessageEvent);
      deps.logger.info({ conversationId: ok.conversationId, messageId: message.id, role: message.role }, 'Conversation message announced');
      res.json({ ok: true });
    } catch (err) {
      deps.logger.error({ err, conversationId: ok.conversationId }, 'Conversation message announce failed');
      res.status(500).json({ error: 'Conversation message announce failed' });
    }
  });

  return router;
}
