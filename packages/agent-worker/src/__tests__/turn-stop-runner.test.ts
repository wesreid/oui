/**
 * The turn runner around a stopped, superseding or redelivered turn
 * (ADR-0252 §2.4, §2.5): what the host's hooks are told, and what the host
 * can answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStopRecord } from '@ouispec/agent-core';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import type { TurnStopClient } from '../stop/turn-stop.js';
import type { HistoryRequest } from '../runtime/types.js';

const MARKER = { reason: 'superseded', at: 7 } as const;
const orchestrator = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../orchestrator.js', () => ({ runAgentTurn: orchestrator.run }));

const { createAgentTurnRunner, payloadRefusal } = await import('../runtime/turn-runner.js');

const emitted: string[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/api/emit')) emitted.push((JSON.parse(init!.body!) as { event: string }).event);
    return Response.json({ ok: true });
  }),
);

/** A stop client the test fires. */
function stops() {
  let hear: ((r: TurnStopRecord | null) => void) | null = null;
  const client: TurnStopClient = {
    watch: (_t, _u, signal) =>
      new Promise((resolve) => {
        hear = resolve;
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
  return { client, fire: () => hear?.({ turnId: 't1', by: 'u1', reason: 'superseded', at: 7 }) };
}

type Hooks = Partial<Parameters<typeof createAgentTurnRunner<object>>[0]>;
const payload = { turnId: 't1', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:t1', content: 'Hello' };

function runner(hooks: Hooks = {}, stop = stops()) {
  const confirmed: string[] = [];
  const r = createAgentTurnRunner<object>({
    model: 'provider/model-id',
    realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
    systemPrompt: () => 'You help.',
    tools: [],
    getDb: async () => ({}),
    getHistory: async () => [],
    persistMessages: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    approvals: {
      store: {
        create: async () => {},
        redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
        status: async () => null,
        confirmExpirySettled: async (id) => void confirmed.push(id),
      },
    },
    stops: { client: stop.client, graceMs: 30 },
    uiActions: { channel: { request: vi.fn() } as never },
    ...hooks,
  });
  return { run: (extra: Record<string, unknown> = {}) => r.run({ ...payload, ...extra } as never), confirmed, stop };
}

/** The orchestrator, stopped: it stores through the hook it was given, then returns. */
const stoppedTurn = async (config: AgentWorkerConfig, _input: AgentTurnInput) => {
  const newMessages = [{ role: 'assistant' as const, content: 'So far', stopped: MARKER }];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, peakPromptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await config.beforeTurnComplete?.({ rounds: 0, usage, newMessages, stopped: MARKER });
  return { rounds: 0, usage, newMessages, settledApprovals: ['call_old'], maxRoundsReached: false, stopReason: 'superseded', stopped: MARKER };
};

beforeEach(() => {
  emitted.length = 0;
  orchestrator.run.mockReset();
  orchestrator.run.mockImplementation(stoppedTurn);
});

describe('a stopped turn, through the runner', () => {
  it('stores with the marker, records the stop reason, and reports itself stopped', async () => {
    const persistMessages = vi.fn(async () => {});
    const recordTurnComplete = vi.fn(async () => {});
    const recordTurnFailure = vi.fn(async () => {});
    const { run, confirmed } = runner({ persistMessages, recordTurnComplete, recordTurnFailure });

    await expect(run()).resolves.toEqual({ status: 'stopped', turnId: 't1', rounds: 0, stopReason: 'superseded' });
    expect(persistMessages).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: 't1', stopped: MARKER, messages: [expect.objectContaining({ stopped: MARKER })] }),
    );
    expect(recordTurnComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: 't1', stopReason: 'superseded' }));
    // A stopped turn did not fail.
    expect(recordTurnFailure).not.toHaveBeenCalled();
    expect(emitted).not.toContain('agent:turn_error');
    // Stored, so the expiry it claimed is confirmed.
    expect(confirmed).toEqual(['call_old']);
  });

  it('stores nothing and confirms nothing when the host found the turn given up on, and still reports it stopped', async () => {
    const { run, confirmed } = runner({ persistMessages: async () => ({ stored: false as const }) });
    await expect(run()).resolves.toMatchObject({ status: 'stopped', stopReason: 'superseded' });
    expect(confirmed).toEqual([]);
  });

  it('records a turn that ran out of time as stopped when what it had was stored', async () => {
    const DEADLINE = { reason: 'deadline', at: 9 } as const;
    orchestrator.run.mockImplementation(async (config: AgentWorkerConfig) => {
      const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, peakPromptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      await config.beforeTurnComplete?.({ rounds: 1, usage, newMessages: [], stopped: DEADLINE });
      return { rounds: 1, usage, newMessages: [], maxRoundsReached: false, stopReason: 'deadline', stopped: DEADLINE };
    });
    const recordTurnComplete = vi.fn(async () => {});
    const recordTurnFailure = vi.fn(async () => {});
    const { run } = runner({ recordTurnComplete, recordTurnFailure });
    await expect(run()).resolves.toEqual({ status: 'stopped', turnId: 't1', rounds: 1, stopReason: 'deadline' });
    expect(recordTurnComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stopReason: 'deadline' }));
    expect(recordTurnFailure).not.toHaveBeenCalled();
  });

  it('records a turn that ran out of time and could not store what it had as having exceeded its deadline, not as stopped (ADR-0252 §6.4)', async () => {
    const DEADLINE = { reason: 'deadline', at: 9 } as const;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, peakPromptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const recordTurnComplete = vi.fn(async () => {});
    const recordTurnFailure = vi.fn(async () => {});

    // The host's store threw.
    orchestrator.run.mockImplementation(async (config: AgentWorkerConfig) => {
      await config.beforeTurnComplete?.({ rounds: 1, usage, newMessages: [], stopped: DEADLINE });
      return { rounds: 1, usage, newMessages: [], maxRoundsReached: false, stopReason: 'deadline', stopped: DEADLINE };
    });
    const threw = runner({ persistMessages: async () => Promise.reject(new Error('connection terminated')), recordTurnComplete, recordTurnFailure });
    await expect(threw.run()).resolves.toEqual({ status: 'stopped', turnId: 't1', rounds: 1, stopReason: 'deadline', stored: false });
    expect(recordTurnFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: 't1', error: expect.objectContaining({ code: 'TURN_DEADLINE_EXCEEDED', recoverable: false }) }),
    );
    expect(recordTurnComplete).not.toHaveBeenCalled();

    // The stop path's store did not finish in time: the orchestrator says it was not stored.
    recordTurnFailure.mockClear();
    orchestrator.run.mockImplementation(async () => ({ rounds: 1, usage, newMessages: [], maxRoundsReached: false, stopReason: 'deadline', stopped: DEADLINE, stored: false }));
    await expect(runner({ recordTurnComplete, recordTurnFailure }).run()).resolves.toMatchObject({ stopReason: 'deadline', stored: false });
    expect(recordTurnFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.objectContaining({ code: 'TURN_DEADLINE_EXCEEDED' }) }));
    expect(recordTurnComplete).not.toHaveBeenCalled();
  });

  it('says nothing of a stop reason for a turn that ended by itself', async () => {
    orchestrator.run.mockImplementation(async () => ({
      rounds: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      newMessages: [],
      maxRoundsReached: false,
      stopReason: 'complete',
    }));
    const recordTurnComplete = vi.fn(async () => {});
    const { run } = runner({ recordTurnComplete });
    await expect(run()).resolves.toEqual({ status: 'completed', turnId: 't1', rounds: 1 });
    expect(recordTurnComplete.mock.calls[0][0]).not.toHaveProperty('stopReason');
  });
});

describe('a turn its own record refuses', () => {
  it('does nothing at all: no history read, no model, no store, no event to the client', async () => {
    const getHistory = vi.fn(async () => []);
    const persistMessages = vi.fn(async () => {});
    const { run } = runner({
      recordTurnStart: async () => ({ run: false as const, reason: 'the turn was abandoned' }),
      getHistory,
      persistMessages,
    });
    await expect(run()).resolves.toEqual({ status: 'refused', turnId: 't1', reason: 'the turn was abandoned' });
    expect(getHistory).not.toHaveBeenCalled();
    expect(orchestrator.run).not.toHaveBeenCalled();
    expect(persistMessages).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('runs as before when the record only records', async () => {
    const { run } = runner({ recordTurnStart: async () => {} });
    await expect(run()).resolves.toMatchObject({ status: 'stopped' });
    expect(orchestrator.run).toHaveBeenCalledOnce();
  });
});

describe('a turn that supersedes others', () => {
  it('tells the history read which turns to wait for, and hands the turn its open stop watch', async () => {
    let asked: HistoryRequest | null = null;
    const { run } = runner({
      getHistory: async (_conversationId, _db, turn) => {
        asked = turn;
        return [];
      },
    });
    await run({ supersedes: ['t0', 't-1'] });
    expect(asked).toMatchObject({ turnId: 't1', supersedes: ['t0', 't-1'] });
    expect(asked!.signal.aborted).toBe(false);
    const input = orchestrator.run.mock.calls[0][1] as AgentTurnInput;
    expect(input.stopWatch).toBeDefined();
  });

  it('is itself stopped while it waits: the wait is told, no history is read, and the turn goes on to store that it was stopped', async () => {
    const stop = stops();
    let waitEnded: 'aborted' | 'timed out' | null = null;
    const { run } = runner(
      {
        // The host's wait for the superseded turns, which honours the signal.
        getHistory: (_c, _db, turn) =>
          new Promise((_, reject) => {
            const timer = setTimeout(() => ((waitEnded = 'timed out'), reject(new Error('timed out'))), 2_000);
            turn.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              waitEnded = 'aborted';
              reject(new Error('stopped while waiting'));
            });
            setTimeout(() => stop.fire(), 10);
          }),
      },
      stop,
    );
    let heardAtStart: unknown = null;
    orchestrator.run.mockImplementation(async (config: AgentWorkerConfig, input: AgentTurnInput) => {
      // The watch it is handed has already heard the stop.
      heardAtStart = input.stopWatch!.current();
      return stoppedTurn(config, input);
    });
    await expect(run({ supersedes: ['t0'] })).resolves.toMatchObject({ status: 'stopped' });
    expect(waitEnded).toBe('aborted');
    expect((orchestrator.run.mock.calls[0][1] as AgentTurnInput).history).toEqual([]);
    expect(heardAtStart).toMatchObject({ reason: 'superseded' });
  });

  it('fails as before when the history read fails for any other reason', async () => {
    const recordTurnFailure = vi.fn(async () => {});
    const { run } = runner({
      getHistory: async () => {
        throw new Error('the database is down');
      },
      recordTurnFailure,
    });
    await expect(run()).resolves.toMatchObject({ status: 'failed' });
    expect(recordTurnFailure).toHaveBeenCalledOnce();
    expect(orchestrator.run).not.toHaveBeenCalled();
  });

  it('refuses a payload whose supersedes is not a list of turn ids', () => {
    expect(payloadRefusal({ ...payload, supersedes: ['t0'] })).toBeNull();
    expect(payloadRefusal({ ...payload, supersedes: 't0' })).toMatch(/supersedes/);
    expect(payloadRefusal({ ...payload, supersedes: [''] })).toMatch(/supersedes/);
  });
});
