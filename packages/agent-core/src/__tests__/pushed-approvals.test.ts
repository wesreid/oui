/**
 * What the approval store pushes to a tab, as every tab reads it:
 * only a well-formed grant or decline is taken, and a grant is a tab's only
 * for the conversation it has open, in a room it is in, before it expires.
 */
import { describe, expect, it } from 'vitest';
import { approvalGrantRefusal, argsHash, readApprovalDeclined, readApprovalGranted, type ApprovalGrantedEvent } from '../index.js';

const ROOM = 'deos:conversation:conv-1';

async function granted(over: Partial<ApprovalGrantedEvent> = {}): Promise<ApprovalGrantedEvent> {
  return {
    approvalId: 'call_order_9',
    grantId: 'grant-1',
    argsHash: await argsHash({ symbol: 'ACME', quantity: 100 }),
    expiresAt: Date.now() + 120_000,
    conversationId: 'conv-1',
    room: ROOM,
    channel: 'voice',
    timestamp: Date.now(),
    ...over,
  };
}

describe('reading what the store pushes', () => {
  it('takes only a well-formed grant or decline, and tells a stale tab why the grant is not its', async () => {
    const grant = await granted();
    expect(readApprovalGranted(grant)).toEqual(grant);
    expect(readApprovalGranted({ ...grant, argsHash: 'nope' })).toBeNull();
    expect(readApprovalGranted({ ...grant, channel: 'sms' })).toBeNull();
    expect(readApprovalGranted({ ...grant, channel: 'ui' })).toBeNull();
    expect(readApprovalGranted(null)).toBeNull();
    expect(readApprovalDeclined({ approvalId: 'a', conversationId: 'c', channel: 'sms', timestamp: 1 })).toEqual({
      approvalId: 'a',
      conversationId: 'c',
      channel: 'sms',
      timestamp: 1,
    });
    expect(readApprovalDeclined({ approvalId: 'a', conversationId: 'c', channel: 'ui' })).toBeNull();
    const now = Date.now();
    expect(approvalGrantRefusal(grant, { conversationId: 'conv-1', rooms: [ROOM] }, now)).toBeNull();
    expect(approvalGrantRefusal(grant, { conversationId: 'conv-2', rooms: [ROOM] }, now)).toMatch(/conversation/);
    expect(approvalGrantRefusal(grant, { conversationId: 'conv-1', rooms: ['agent:turn:t'] }, now)).toMatch(/room/);
    expect(approvalGrantRefusal(grant, { conversationId: 'conv-1', rooms: [ROOM] }, grant.expiresAt)).toMatch(/expired/);
  });
});
