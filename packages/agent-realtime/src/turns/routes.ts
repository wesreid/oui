/**
 * The worker's and the host's side of a turn stop (ADR-0252 §2.1). Both need
 * the internal API key.
 *
 * POST /internal/turns/:turnId/stop   { userId, reason }
 *   The host asks, for its user, that a turn stop: a newer message supersedes
 *   it, a chat is being deleted, or the tab could not reach its socket. The
 *   host has checked that the turn is `userId`'s.
 *   200 — { ok: true, stop: 'requested' | 'already', record }
 *   400 — userId missing, or reason not one of the stop reasons
 *
 * GET /internal/turns/:turnId/stop?userId=&waitMs=
 *   The stop asked for on a turn by its user, waiting up to `waitMs` (capped
 *   at 25 s) for one. A worker holds this open for the life of its turn.
 *   200 — the TurnStopRecord
 *   204 — no stop yet; ask again
 *   400 — userId missing or waitMs invalid
 *
 * Both: 401 without the key, 503 while the store is not connected.
 */
import { Router, type Request, type Response } from 'express';
import { isTurnStopReason } from '@ouispec/agent-core';
import type { RealtimeLogger } from '../logger.js';
import type { TurnStopStore } from './stops.js';

/** The longest one request waits for a stop. The worker asks again. */
export const MAX_STOP_WAIT_MS = 25_000;

export interface TurnStopRouteDeps {
  /** Null until Redis is connected. */
  stops: () => TurnStopStore | null;
  isInternalKey: (presented: string | undefined) => boolean;
  logger: RealtimeLogger;
}

export function turnStopsRouter(deps: TurnStopRouteDeps): Router {
  const router = Router();

  /** The store, or null after answering why the request cannot be served. */
  function storeFor(req: Request, res: Response): TurnStopStore | null {
    if (!deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return null;
    }
    const store = deps.stops();
    if (!store) res.status(503).json({ error: 'Turn stop store not connected' });
    return store;
  }

  router.post('/internal/turns/:turnId/stop', async (req: Request, res: Response) => {
    const store = storeFor(req, res);
    if (!store) return;
    const turnId = req.params.turnId as string;
    const { userId, reason } = (req.body ?? {}) as { userId?: unknown; reason?: unknown };
    if (typeof userId !== 'string' || !userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    if (!isTurnStopReason(reason)) {
      res.status(400).json({ error: 'reason must be user_stop or superseded' });
      return;
    }
    try {
      const { record, first } = await store.request(turnId, userId, reason);
      res.json({ ok: true, stop: first ? 'requested' : 'already', record });
    } catch (err) {
      deps.logger.error({ err, turnId, userId }, 'Turn stop request failed');
      res.status(500).json({ error: 'Turn stop request failed' });
    }
  });

  router.get('/internal/turns/:turnId/stop', async (req: Request, res: Response) => {
    const store = storeFor(req, res);
    if (!store) return;
    const turnId = req.params.turnId as string;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    const waitMs = req.query.waitMs === undefined ? 0 : Number(req.query.waitMs);
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      res.status(400).json({ error: 'waitMs must be a non-negative number' });
      return;
    }
    try {
      const record = await store.await(turnId, userId, Math.min(waitMs, MAX_STOP_WAIT_MS));
      if (!record) {
        res.status(204).end();
        return;
      }
      res.json(record);
    } catch (err) {
      deps.logger.error({ err, turnId, userId }, 'Turn stop lookup failed');
      res.status(500).json({ error: 'Turn stop lookup failed' });
    }
  });

  return router;
}
