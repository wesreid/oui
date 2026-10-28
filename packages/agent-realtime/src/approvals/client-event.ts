/**
 * The approval card's events, on the person's own authenticated socket:
 *
 * - `approval:decide`: the user's click on the approval card. The decider is
 *   the socket's verified identity, never one the payload names, and an
 *   approval's token is answered only to this socket, in the event's ack.
 * - `approval:claim`: the tab takes the grant the store pushed to its room
 *   when the person approved an action on their page by voice, on the phone or
 *   in chat (ADR-0284). The claimer is the socket's verified identity, in the
 *   rooms the server holds it in; only the first claim gets the grant.
 */
import {
  APPROVAL_CLAIM_EVENT,
  APPROVAL_DECIDE_EVENT,
  type ApprovalClaimPayload,
  type ApprovalDecidePayload,
  type ApprovalRefusal,
} from '@ouispec/agent-core';
import { defineClientEvent, type ClientEvent } from '../client-events/chain.js';
import type { ApprovalStore } from './store.js';
import { claimPayloadSchema, decidePayloadSchema } from './schemas.js';

export function createApprovalDecideEvent(approvals: () => ApprovalStore): ClientEvent {
  return defineClientEvent<ApprovalDecidePayload>({
    name: APPROVAL_DECIDE_EVENT,
    schema: decidePayloadSchema,
    maxBytes: 1024,
    // A person clicks; a burst is a script.
    rate: { perSecond: 2, burst: 5 },
    // Scoped by construction: the store decides only an approval whose user is this socket's.
    refusal: (reason): ApprovalRefusal => ({ ok: false, reason: 'invalid', error: reason }),
    handle: async ({ user }, payload, ack) => {
      const result = await approvals().decide(payload.approvalId, { userId: user.userId, decision: payload.decision, channel: 'ui' });
      ack?.(result);
    },
  });
}

export function createApprovalClaimEvent(approvals: () => ApprovalStore): ClientEvent {
  return defineClientEvent<ApprovalClaimPayload>({
    name: APPROVAL_CLAIM_EVENT,
    schema: claimPayloadSchema,
    maxBytes: 1024,
    // One per tab per approval; a burst is a script.
    rate: { perSecond: 2, burst: 5 },
    refusal: (reason): ApprovalRefusal => ({ ok: false, reason: 'invalid', error: reason }),
    handle: async ({ socket, user }, payload, ack) => {
      const result = await approvals().claim(payload.approvalId, payload.grantId, {
        userId: user.userId,
        socketId: socket.id,
        rooms: [...socket.rooms],
      });
      ack?.(result);
    },
  });
}
