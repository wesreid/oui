/**
 * A host sizes the page it shows the model through the runtime config: the page
 * state (`maxObservationChars`) and the page's index
 * (`maxIndexChars`) both reach the turn. So does where the turn's context goes
 * (`turnContextPlacement`), and where the page's knowledge goes
 * (`uiActions.knowledgePlacement`).
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

  it('passes a turn context placement to the turn when the host sets one, and none when it does not (the default, with the message)', async () => {
    const base = {
      model: 'provider/model-id',
      realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
      systemPrompt: () => 'You help.',
      tools: [],
      getDb: async () => ({}),
      getHistory: async () => [],
      persistMessages: async () => {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    const payload = { turnId: 't2', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:t2', content: 'Hello' } as never;
    await createAgentTurnRunner<object>({ ...base, turnContextPlacement: 'after-conversation' }).run(payload);
    expect(seen.at(-1)?.turnContextPlacement).toBe('after-conversation');
    await createAgentTurnRunner<object>(base).run(payload);
    expect(seen.at(-1)).not.toHaveProperty('turnContextPlacement');
    // A placement the worker does not know fails when the runner is created, naming the ones there are.
    expect(() => createAgentTurnRunner<object>({ ...base, turnContextPlacement: 'end' as never })).toThrow(
      /turnContextPlacement must be one of with-message, after-conversation, not "end"/,
    );
  });

  it('passes a knowledge placement to the turn when the host sets one, none when it does not, and refuses one it does not know', async () => {
    const base = {
      model: 'provider/model-id',
      realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
      systemPrompt: () => 'You help.',
      tools: [],
      getDb: async () => ({}),
      getHistory: async () => [],
      persistMessages: async () => {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    const payload = { turnId: 't3', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:t3', content: 'Hello' } as never;
    await createAgentTurnRunner<object>({ ...base, uiActions: { knowledgePlacement: 'index' } }).run(payload);
    expect(seen.at(-1)?.ui?.knowledgePlacement).toBe('index');
    await createAgentTurnRunner<object>({ ...base, uiActions: {} }).run(payload);
    expect(seen.at(-1)?.ui).not.toHaveProperty('knowledgePlacement');
    expect(() => createAgentTurnRunner<object>({ ...base, uiActions: { knowledgePlacement: 'system' as never } })).toThrow(
      /ui\.knowledgePlacement must be one of prompt, index, not "system"/,
    );
  });
});
