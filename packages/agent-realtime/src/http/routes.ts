/**
 * The server's HTTP endpoints. Every `/internal/*` and `/api/emit` route
 * requires the internal key (`x-api-key`); they are for the product's backend
 * and its agent worker, never a browser.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import type { RoomPolicy } from '../types.js';
import type { RoomTokenSigner } from '../rooms/room-token.js';
import type { OUIResultStore } from '../oui/results.js';
import type { RealtimeLogger } from '../logger.js';
import { declaredRefusal, type DeclaredEvents } from '../events/declared.js';
import type { SettlementStore } from '../events/settlements.js';

/** The longest a single result wait may hold a request open. Callers ask again until their own deadline. */
export const MAX_RESULT_WAIT_MS = 25_000;

/** The longest `/api/emit` waits for the receivers' receipts (`ackTimeoutMs`). */
export const MAX_RECEIPT_WAIT_MS = 5_000;

/** What `/api/emit` reports when asked for receipts: how many receivers acknowledged, and how many accepted. */
export interface EmitReceipts {
  acknowledged: number;
  accepted: number;
}

/** A constant-time check of the internal key. */
export function createInternalKeyCheck(internalApiKey: string): (presented: string | undefined) => boolean {
  const expected = crypto.createHash('sha256').update(internalApiKey).digest();
  return (presented) => {
    if (typeof presented !== 'string' || presented.length === 0) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), expected);
  };
}

export interface RouteDeps {
  io: Server;
  roomPolicy: RoomPolicy;
  roomTokens: RoomTokenSigner;
  /** Null until Redis is connected. */
  results: () => OUIResultStore | null;
  /** The product's event declarations; null when none were given. */
  declared: DeclaredEvents | null;
  /** Null when there are no declarations. */
  settlements: () => SettlementStore | null;
  isInternalKey: (presented: string | undefined) => boolean;
  logger: RealtimeLogger;
}

function refuseWithoutKey(deps: RouteDeps, req: Request, res: Response): boolean {
  if (deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) return false;
  res.status(401).json({ error: 'Invalid or missing API key' });
  return true;
}

export function healthRouter(deps: Pick<RouteDeps, 'io' | 'results'>): Router {
  const router = Router();
  const startedAt = Date.now();
  router.get('/health', (_req, res) => {
    const results = deps.results();
    res.status(results ? 200 : 503).json({
      status: results ? 'ok' : 'starting',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      connections: deps.io.engine.clientsCount,
      pendingResultWaits: results?.pendingCount() ?? 0,
      timestamp: new Date().toISOString(),
    });
  });
  return router;
}

/**
 * POST /api/emit — `{ event, data, rooms? }`. Sends a server event to rooms,
 * or to every socket when `rooms` is empty or absent. How the product's
 * backend and worker reach clients (turn events, UI action dispatches, job
 * events).
 *
 * With event declarations: only a declared event, with a payload its schema
 * accepts, into rooms it is declared for (never a broadcast); anything else is
 * a 400, logged. A completion or failure is then kept as its job's settlement.
 *
 * With `ackTimeoutMs` (rooms only, at most MAX_RECEIPT_WAIT_MS): the event asks
 * its receivers for a receipt, and the response says how many acknowledged it
 * within that time and how many accepted it (`receipts`). A UI action request
 * is answered `{ ok: true }` by a tab that received it (oui-spec §7.3.7), so the
 * worker can tell a request that reached the page from one that reached
 * nobody, and send it again only then.
 */
export function emitRouter(deps: RouteDeps): Router {
  const router = Router();
  router.post('/api/emit', async (req: Request, res: Response) => {
    if (refuseWithoutKey(deps, req, res)) return;
    const { event, data, rooms, ackTimeoutMs } = (req.body ?? {}) as {
      event?: unknown;
      data?: unknown;
      rooms?: unknown;
      ackTimeoutMs?: unknown;
    };

    if (!event || typeof event !== 'string') {
      res.status(400).json({ error: 'event is required and must be a string' });
      return;
    }
    if (rooms !== undefined && (!Array.isArray(rooms) || rooms.some((r) => typeof r !== 'string'))) {
      res.status(400).json({ error: 'rooms must be an array of strings' });
      return;
    }
    if (
      ackTimeoutMs !== undefined &&
      (typeof ackTimeoutMs !== 'number' ||
        !Number.isInteger(ackTimeoutMs) ||
        ackTimeoutMs < 1 ||
        ackTimeoutMs > MAX_RECEIPT_WAIT_MS)
    ) {
      res.status(400).json({ error: `ackTimeoutMs must be a whole number of ms from 1 to ${MAX_RECEIPT_WAIT_MS}` });
      return;
    }
    const targets = (rooms as string[] | undefined) ?? [];
    if (ackTimeoutMs !== undefined && targets.length === 0) {
      res.status(400).json({ error: 'receipts (ackTimeoutMs) are asked of rooms, never of a broadcast' });
      return;
    }
    const invalid = targets.filter((r) => !deps.roomPolicy.isValidRoom(r));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid room names: ${invalid.join(', ')}` });
      return;
    }
    if (deps.declared) {
      const reason = declaredRefusal(deps.declared, event, data, targets, 'payload');
      if (reason) {
        deps.logger.warn({ event, rooms: targets, reason }, 'Emit refused');
        res.status(400).json({ error: reason });
        return;
      }
    }
    let receipts: EmitReceipts | null = null;
    if (targets.length > 0 && ackTimeoutMs !== undefined) {
      receipts = await emitWithReceipts(deps.io, targets, event, data, ackTimeoutMs as number);
      deps.logger.info({ event, rooms: targets, hasData: data != null, receipts }, 'Emitted to rooms');
    } else if (targets.length > 0) {
      deps.io.to(targets).emit(event, data);
      deps.logger.info({ event, rooms: targets, hasData: data != null }, 'Emitted to rooms');
    } else {
      deps.io.emit(event, data);
      deps.logger.info({ event, hasData: data != null }, 'Broadcast emitted');
    }
    const settlement = deps.declared?.catalog.settlement(event, data) ?? null;
    const store = deps.settlements();
    if (settlement && store) {
      try {
        await store.record(settlement);
      } catch (err) {
        // The event reached its rooms; only a worker's later wait on the job misses it.
        deps.logger.error({ err, event, kind: settlement.kind, id: settlement.id }, 'Settlement not kept');
        res.json({ ok: true, settled: false, ...(receipts ? { receipts } : {}) });
        return;
      }
    }
    res.json({ ok: true, ...(receipts ? { receipts } : {}) });
  });
  return router;
}

/**
 * Emit to rooms asking each receiver for an acknowledgment, and count them:
 * those that answered within `timeoutMs`, and of those, the ones that accepted
 * (anything but `{ ok: false }`). A receiver that does not acknowledge — an
 * older client — counts in neither, so its sender falls back to its own
 * schedule. Across instances through the Redis adapter's broadcast acks.
 */
function emitWithReceipts(io: Server, rooms: string[], event: string, data: unknown, timeoutMs: number): Promise<EmitReceipts> {
  return new Promise((resolve) => {
    io.to(rooms)
      .timeout(timeoutMs)
      .emit(event, data, (_err: Error | null, responses: unknown[] = []) => {
        const acks = Array.isArray(responses) ? responses : [];
        const accepted = acks.filter((r) => !(r && typeof r === 'object' && (r as { ok?: unknown }).ok === false)).length;
        resolve({ acknowledged: acks.length, accepted });
      });
  });
}

/**
 * POST /internal/room-token — `{ userId, room }` → `{ token }`.
 *
 * Signs a token that admits `userId` to `room`, for any room the policy marks
 * `requiresToken`. The product calls it only after its own authorization for
 * the resource accepted the user; this route decides nothing about access.
 */
export function roomTokenRouter(deps: RouteDeps): Router {
  const router = Router();
  router.post('/internal/room-token', (req: Request, res: Response) => {
    if (refuseWithoutKey(deps, req, res)) return;
    const { userId, room } = (req.body ?? {}) as { userId?: unknown; room?: unknown };

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId is required and must be a string' });
      return;
    }
    if (!room || typeof room !== 'string') {
      res.status(400).json({ error: 'room is required and must be a string' });
      return;
    }
    if (!deps.roomPolicy.isValidRoom(room)) {
      res.status(400).json({ error: `Invalid room name: ${room}` });
      return;
    }
    if (!deps.roomPolicy.requiresToken(room)) {
      res.status(400).json({ error: `${room} is joined by identity, not with a room token` });
      return;
    }
    const token = deps.roomTokens.sign(userId, room);
    deps.logger.info({ userId, room }, 'Room token issued');
    res.json({ token, expiresInMs: deps.roomTokens.ttlMs });
  });
  return router;
}

/**
 * GET /internal/oui/action-results/:requestId?userId=&waitMs=&final=1
 *
 * The client's answer to a UI action request (ADR-0209). Waits up to `waitMs`
 * (capped at 25 s) for it to arrive. With `final=1`, the final answer: for an
 * async action, the one sent when its work is done or has failed, never its
 * acknowledgment; for any other action, its one answer.
 *   200 — the OUIActionResult
 *   204 — no answer yet; ask again
 *   400 — userId missing or waitMs invalid
 *   401 — missing or wrong internal API key
 *   503 — the result store is not connected
 *
 * `userId` is the user the turn belongs to. An answer from any other user's
 * socket is never returned.
 */
export function ouiResultsRouter(deps: RouteDeps): Router {
  const router = Router();
  router.get('/internal/oui/action-results/:requestId', async (req: Request, res: Response) => {
    if (refuseWithoutKey(deps, req, res)) return;

    const requestId = req.params.requestId as string;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    const waitMs = req.query.waitMs === undefined ? 0 : Number(req.query.waitMs);
    const final = req.query.final === '1' || req.query.final === 'true';

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      res.status(400).json({ error: 'waitMs must be a non-negative number' });
      return;
    }
    const store = deps.results();
    if (!store) {
      res.status(503).json({ error: 'OUI result store not connected' });
      return;
    }
    try {
      const result = await store.await(requestId, userId, Math.min(waitMs, MAX_RESULT_WAIT_MS), { final });
      if (!result) {
        res.status(204).end();
        return;
      }
      res.json(result);
    } catch (err) {
      deps.logger.error({ err, requestId, userId }, 'OUI result lookup failed');
      res.status(500).json({ error: 'OUI result lookup failed' });
    }
  });
  return router;
}

/**
 * GET /internal/events/settlements/:kind/:id?waitMs=
 *
 * How a job of a declared kind ended: its first completion or failure, as
 * `{ kind, role, event, id, payload }`. Waits up to `waitMs` (capped at 25 s)
 * for it; a worker asks again until its own deadline.
 *   200 — the settlement
 *   204 — not settled yet
 *   400 — an undeclared kind, or waitMs invalid
 *   401 — missing or wrong internal API key
 *   404 — this server has no event declarations
 *   503 — the store is not connected
 */
export function settlementsRouter(deps: RouteDeps): Router {
  const router = Router();
  router.get('/internal/events/settlements/:kind/:id', async (req: Request, res: Response) => {
    if (refuseWithoutKey(deps, req, res)) return;
    if (!deps.declared) {
      res.status(404).json({ error: 'this server has no event declarations' });
      return;
    }
    const kind = req.params.kind as string;
    const id = req.params.id as string;
    const waitMs = req.query.waitMs === undefined ? 0 : Number(req.query.waitMs);
    if (!deps.declared.catalog.jobKind(kind)) {
      const declared = deps.declared.catalog.jobKinds().map((k) => k.kind);
      res.status(400).json({ error: `job kind '${kind}' is not declared (declared: ${declared.join(', ') || 'none'})` });
      return;
    }
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      res.status(400).json({ error: 'waitMs must be a non-negative number' });
      return;
    }
    const store = deps.settlements();
    if (!store) {
      res.status(503).json({ error: 'settlement store not connected' });
      return;
    }
    try {
      const settlement = await store.await(kind, id, Math.min(waitMs, MAX_RESULT_WAIT_MS));
      if (!settlement) {
        res.status(204).end();
        return;
      }
      res.json(settlement);
    } catch (err) {
      deps.logger.error({ err, kind, id }, 'Settlement lookup failed');
      res.status(500).json({ error: 'settlement lookup failed' });
    }
  });
  return router;
}
