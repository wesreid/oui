/**
 * `approval:decide` (ADR-0228 §2.2.3): the user's click on the approval card,
 * on their own authenticated socket. The decider is the socket's verified
 * identity, never one the payload names, and an approval's token is answered
 * only to this socket, in the event's ack.
 */
import { APPROVAL_DECIDE_EVENT, type ApprovalDecidePayload, type ApprovalRefusal } from '@ouispec/agent-core';
import { defineClientEvent, type ClientEvent } from '../client-events/chain.js';
import type { ApprovalStore } from './store.js';
import { decidePayloadSchema } from './schemas.js';

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
