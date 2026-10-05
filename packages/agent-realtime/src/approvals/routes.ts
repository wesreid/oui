/**
 * The approval store's internal endpoints (ADR-0228 §2.4). Each requires the
 * internal key: they are for the product's agent worker and a conversation
 * engine, never a browser. A browser decides only through `approval:decide`
 * on its own authenticated socket.
 *
 *   POST /internal/approvals               store a pending approval (worker, engine)
 *   POST /internal/approvals/:id/decide    a conversation channel's decision (engine)
 *   POST /internal/approvals/redeem        atomic single use (worker, engine)
 *   GET  /internal/approvals/:id?userId=   where an approval stands (worker, for the turn after a decision)
 *   POST /internal/approvals/:id/settle    whether it expired undecided, claimed for one turn to store; with
 *                                          `confirm`, that it has been stored (worker, at the start of a later turn);
 *                                          with `expire`, expire it now, saying why (host, when a new message
 *                                          arrives; worker, when the turn that asked is stopped: ADR-0252 §2.6)
 */
import { Router, type Request, type Response } from 'express';
import {
  APPROVAL_WITHDRAW_REASONS,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalRefusalReason,
  type ApprovalWithdrawReason,
  type PendingApprovalInput,
} from '@ouispec/agent-core';
import type { PayloadSchema } from '../types.js';
import type { ApprovalStore } from './store.js';
import { internalDecideSchema, pendingApprovalSchema, redeemSchema } from './schemas.js';

export interface ApprovalRouteDeps {
  approvals: ApprovalStore;
  isInternalKey: (presented: string | undefined) => boolean;
}

const DECIDE_STATUS: Record<ApprovalRefusalReason, number> = {
  unknown: 404,
  forbidden: 403,
  expired: 410,
  decided: 409,
  used: 410,
  invalid: 400,
  mismatch: 403,
  channel: 400,
};
const REDEEM_STATUS: Record<ApprovalRefusalReason, number> = {
  ...DECIDE_STATUS,
  invalid: 403,
  unknown: 410,
};

export function approvalRouter(deps: ApprovalRouteDeps): Router {
  const router = Router();

  const accept = <T>(req: Request, res: Response, schema: PayloadSchema): T | null => {
    if (!deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return null;
    }
    const { value, error } = schema.validate(req.body ?? {}, { abortEarly: true, convert: false });
    if (error) {
      res.status(400).json({ error: `invalid body: ${error.message}`, reason: 'invalid' });
      return null;
    }
    return value as T;
  };

  router.post('/internal/approvals/redeem', async (req, res) => {
    const body = accept<{ token: string; userId: string; conversationId: string }>(req, res, redeemSchema);
    if (!body) return;
    const result = await deps.approvals.redeem(body.token, { userId: body.userId, conversationId: body.conversationId });
    if (!result.ok) {
      res.status(REDEEM_STATUS[result.reason]).json({ error: result.error, reason: result.reason });
      return;
    }
    res.json({ call: result.call });
  });

  router.post('/internal/approvals', async (req, res) => {
    const body = accept<PendingApprovalInput>(req, res, pendingApprovalSchema);
    if (!body) return;
    const result = await deps.approvals.create(body);
    if (!result.ok) {
      res.status(result.reason === 'decided' ? 409 : 400).json({ error: result.error, reason: result.reason });
      return;
    }
    res.status(201).json({ approvalId: result.approvalId, argsHash: result.argsHash, expiresAt: result.expiresAt });
  });

  router.post('/internal/approvals/:id/decide', async (req, res) => {
    const body = accept<{ userId: string; decision: ApprovalDecision; channel: ApprovalChannel }>(req, res, internalDecideSchema);
    if (!body) return;
    // In a UI only the user's click counts, and it arrives on their own socket.
    if (body.channel === 'ui') {
      res.status(400).json({ error: 'a UI approval is decided only on the user’s own socket (approval:decide)', reason: 'channel' });
      return;
    }
    const result = await deps.approvals.decide(req.params.id as string, body);
    if (!result.ok) {
      res.status(DECIDE_STATUS[result.reason]).json({ error: result.error, reason: result.reason });
      return;
    }
    res.json(result);
  });

  router.post('/internal/approvals/:id/settle', async (req: Request, res: Response) => {
    if (!deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }
    const body = (req.body ?? {}) as { userId?: unknown; conversationId?: unknown; confirm?: unknown; expire?: unknown };
    if (typeof body.userId !== 'string' || !body.userId || typeof body.conversationId !== 'string' || !body.conversationId) {
      res.status(400).json({ error: 'userId and conversationId are required' });
      return;
    }
    const approvalId = req.params.id as string;
    const owner = { userId: body.userId, conversationId: body.conversationId };
    // Always 200: `unknown` is an answer, and a worker must tell it from a server that has no such route (404).
    if (body.confirm === true) {
      res.json({ approvalId, outcome: (await deps.approvals.confirmExpirySettled(approvalId, owner)) ? 'confirmed' : 'unknown' });
      return;
    }
    if (body.expire !== undefined) {
      if (!(APPROVAL_WITHDRAW_REASONS as readonly unknown[]).includes(body.expire)) {
        res.status(400).json({ error: `expire must be one of ${APPROVAL_WITHDRAW_REASONS.join(', ')}` });
        return;
      }
      res.json(await deps.approvals.withdraw(approvalId, owner, body.expire as ApprovalWithdrawReason));
      return;
    }
    res.json(await deps.approvals.settleExpired(approvalId, owner));
  });

  router.get('/internal/approvals/:id', async (req, res) => {
    if (!deps.isInternalKey(req.headers['x-api-key'] as string | undefined)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }
    const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const status = await deps.approvals.status(req.params.id as string, userId);
    if (!status) {
      res.status(404).json({ error: 'no such approval for this user', reason: 'unknown' });
      return;
    }
    res.json(status);
  });

  return router;
}
