/**
 * A host sizes the page it shows the model through the runtime config: the page
 * state (`maxObservationChars`, ADR-0244) and the page's index
 * (`maxIndexChars`, ADR-0245) both reach the turn.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types.js';

const seen: AgentConfig[] = [];
vi.mock('../orchestrator.js', () => ({
  runAgentTurn: vi.fn(async (config: AgentConfig) => {
    seen.push(config);
    return { newMessages: [], rounds: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, stopReason: 'complete' };
  }),
}));

const { createAgentTurnRunner } = await import('../runtime/turn-runner.js');

describe('the runtime config', () => {
  it('passes the page-state and index sizes to the turn', async () => {
    const runner = createAgentTurnRunner<object>({
      model: 'provider/model-id',
      realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
      systemPrompt: () => 'You help.',
      tools: [],
      getDb: async () => ({}),
      getHistory: async () => [],
      persistMessages: async () => {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      uiActions: { channel: { request: vi.fn() } as never, maxObservationChars: 12_000, maxIndexChars: 30_000 },
    });
    await runner.run({
      turnId: 't1',
      conversationId: 'c1',
      userId: 'u1',
      accountId: 'a1',
      socketRoom: 'agent:turn:t1',
      content: 'Hello',
    } as never);
    expect(seen.at(-1)?.ui).toMatchObject({ maxObservationChars: 12_000, maxIndexChars: 30_000 });
  });
});
