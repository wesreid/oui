/**
 * The published receipt keys: `GET /.well-known/oui-approval-jwks.json`.
 *
 * Public, with no credential: a tool verifies receipts against it from
 * anywhere, a browser build included, so it answers any origin and allows
 * reads across origins. It may be cached for an hour; a rotation publishes a
 * key an hour before it signs, and keeps a retired one published for an hour
 * and the receipt lifetime after.
 */
import { Router } from 'express';
import { APPROVAL_RECEIPT_JWKS_MAX_AGE_SEC, APPROVAL_RECEIPT_JWKS_PATH } from '@ouispec/agent-core';
import type { ApprovalReceiptSigner } from './receipt.js';

export function receiptJwksRouter(signer: () => ApprovalReceiptSigner | null): Router {
  const router = Router();
  router.options(APPROVAL_RECEIPT_JWKS_PATH, (_req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
    res.status(204).end();
  });
  router.get(APPROVAL_RECEIPT_JWKS_PATH, (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    const current = signer();
    if (!current) {
      res.set('Cache-Control', 'no-store');
      res.status(404).json({ error: 'this server issues no approval receipts' });
      return;
    }
    res.set('Cache-Control', `public, max-age=${APPROVAL_RECEIPT_JWKS_MAX_AGE_SEC}`);
    res.type('application/json').json(current.jwks());
  });
  return router;
}
