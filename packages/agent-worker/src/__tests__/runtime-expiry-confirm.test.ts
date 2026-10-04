/**
 * An expired approval a turn claimed is confirmed with the store only once
 * the host has stored the turn's messages. A turn that dies in between, or a
 * host whose store write fails, confirms nothing: the claim lapses on the
 * store's clock and a later turn stores the result, so the conversation a
 * person reads later never says "waiting" for good.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalStoreClient } from '../approvals/client.js';

vi.mock('../orchestrator.js', () => ({
  runAgentTurn: vi.fn(async () => ({
    newMessages: [{ role: 'tool', content: '{"approval":{"decided":"expired"}}', toolCallId: 'call_save_1', name: 'ui_act' }],
    settledApprovals: ['call_save_1'],
    rounds: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: 'complete',
  })),
}));

const { createAgentTurnRunner } = await import('../runtime/turn-runner.js');

function runner(persistMessages: () => Promise<void>, confirmExpirySettled: ApprovalStoreClient['confirmExpirySettled']) {
  const order: string[] = [];
  const store: ApprovalStoreClient = {
    create: async () => {},
    redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
    status: async () => null,
    confirmExpirySettled: confirmExpirySettled
      ? async (id, owner) => {
          order.push(`confirm ${id} ${owner.userId} ${owner.conversationId}`);
          await confirmExpirySettled(id, owner);
        }
      : undefined,
  };
  const run = () =>
    createAgentTurnRunner<object>({
      model: 'provider/model-id',
      realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
      systemPrompt: () => 'You help.',
      tools: [],
      getDb: async () => ({}),
      getHistory: async () => [],
      persistMessages: async () => {
        order.push('persist');
        await persistMessages();
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      approvals: { store },
      uiActions: { channel: { request: vi.fn() } as never },
    }).run({ turnId: 't1', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:t1', content: 'Hello' } as never);
  return { run, order };
}

describe('the turn runner, after a turn claimed an expired approval', () => {
  it('confirms it with the store after the host has stored the messages', async () => {
    const { run, order } = runner(async () => {}, async () => {});
    expect((await run()).status).toBe('completed');
    expect(order).toEqual(['persist', 'confirm call_save_1 u1 c1']);
  });

  it('confirms nothing when the host could not store them: the claim is left to lapse', async () => {
    const { run, order } = runner(
      async () => {
        throw new Error('the database is down');
      },
      async () => {},
    );
    await run();
    expect(order).toEqual(['persist']);
  });

  it('finishes the turn when the confirmation itself fails', async () => {
    const { run, order } = runner(
      async () => {},
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    expect((await run()).status).toBe('completed');
    expect(order).toEqual(['persist', 'confirm call_save_1 u1 c1']);
  });
});
