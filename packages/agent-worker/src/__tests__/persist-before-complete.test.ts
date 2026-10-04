/**
 * A turn's messages are stored before the client is told the turn is complete.
 *
 * Told first and stored after, a message sent within a second of
 * `turn_complete` was answered from a history without the turn that had just
 * finished: asked to rename a draft and then to delete it, the model renamed
 * it a second time (dev, 2026-10-04: three runs of three with a one-second
 * gap, none of two with six). A person who types fast meets it, and so does
 * anything automatic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage, TurnMessage } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;
vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

type Wrapped = Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;

/** A model that calls `rename` once and says it did. */
function renames() {
  mockStreamTextImpl = (opts) => {
    const run = (opts.tools as Wrapped).rename.execute({ title: 'Launch plan' }, { toolCallId: 'call-1' });
    return {
      textStream: (async function* () {
        await run;
        yield 'Renamed.';
      })(),
      steps: run.then((output) => [
        {
          text: 'Renamed.',
          toolCalls: [{ toolName: 'rename', toolCallId: 'call-1', input: { title: 'Launch plan' } }],
          toolResults: [{ toolName: 'rename', toolCallId: 'call-1', output }],
        },
      ]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [] }),
    };
  };
}

const rename: RegisteredTool = {
  name: 'rename',
  description: 'Renames the draft.',
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  execute: async (input) => ({ success: true, data: { renamed: input.title } }),
};

const input = (history: TurnHistoryMessage[] = []): AgentTurnInput => ({
  turnId: 'turn-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  accountId: 'acct-1',
  socketRoom: 'agent:turn:turn-1',
  content: 'Rename the draft to "Launch plan".',
  history,
});

beforeEach(() => {
  vi.resetModules();
  renames();
});

describe('the orchestrator', () => {
  it('hands the host the turn’s messages, and waits for it, before it announces the turn complete', async () => {
    const order: string[] = [];
    let stored: TurnMessage[] = [];
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([rename]),
      model: 'test-model' as never,
      systemPrompt: 'test',
      emit: {
        emit: vi.fn(async (_room: string, event: string) => {
          if (event === AGENT_SOCKET_EVENTS.TURN_COMPLETE) order.push('turn_complete');
        }),
      },
      beforeTurnComplete: async ({ newMessages, rounds, usage }) => {
        // A store that takes a moment: the announcement must not overtake it.
        await new Promise((resolve) => setTimeout(resolve, 30));
        stored = newMessages;
        expect(rounds).toBe(1);
        expect(usage.totalTokens).toBe(15);
        order.push('stored');
      },
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config, input());

    expect(order).toEqual(['stored', 'turn_complete']);
    // What it was handed is what the turn returns: the call, its result, and what was said.
    expect(stored).toEqual(result.newMessages);
    expect(stored.flatMap((m) => m.toolCalls ?? []).map((c) => c.name)).toEqual(['rename']);
    expect(stored.some((m) => m.role === 'tool' && m.toolCallId === 'call-1')).toBe(true);
  });

  it('still completes the turn when the host’s store fails', async () => {
    const emit = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      {
        tools: createToolRegistry([rename]),
        model: 'test-model' as never,
        systemPrompt: 'test',
        emit: { emit },
        beforeTurnComplete: async () => {
          throw new Error('the database is away');
        },
      },
      input(),
    );
    expect(result.stopReason).toBe('complete');
    expect(emit.mock.calls.map((c) => c[1])).toContain(AGENT_SOCKET_EVENTS.TURN_COMPLETE);
  });
});

describe('the turn runner', () => {
  it('stores a turn before its completion is announced, once, so the next turn’s history holds it', async () => {
    const events: string[] = [];
    const rows: TurnMessage[] = [];
    const fetched = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as { event?: string }) : {};
      if (body.event === AGENT_SOCKET_EVENTS.TURN_COMPLETE) events.push(`announced with ${rows.length} stored`);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetched);
    try {
      const { createAgentTurnRunner } = await import('../runtime/turn-runner.js');
      const persistMessages = vi.fn(async ({ messages }: { messages: TurnMessage[] }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        rows.push(...messages);
        events.push('stored');
      });
      const histories: number[] = [];
      const runner = createAgentTurnRunner<object>({
        model: 'provider/model-id',
        realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
        systemPrompt: () => 'You help.',
        tools: [rename],
        getDb: async () => ({}),
        // The history a turn is sent: what has been stored when it starts.
        getHistory: async () => {
          histories.push(rows.length);
          return [];
        },
        persistMessages,
        recordTurnComplete: async () => {
          events.push('recorded complete');
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      const payload = { conversationId: 'conv-1', userId: 'u1', accountId: 'a1', content: 'Rename it.' };
      await runner.run({ ...payload, turnId: 't1', socketRoom: 'agent:turn:t1' } as never);
      const storedByTurnOne = rows.length;
      expect(storedByTurnOne).toBeGreaterThan(0);
      // Stored first, announced with the rows already there, then the host's own record of completion.
      expect(events).toEqual(['stored', `announced with ${storedByTurnOne} stored`, 'recorded complete']);
      expect(persistMessages).toHaveBeenCalledTimes(1);

      // The next turn, sent the moment the first is announced, reads a history that holds it.
      await runner.run({ ...payload, turnId: 't2', socketRoom: 'agent:turn:t2', content: 'Now delete it.' } as never);
      expect(histories).toEqual([0, storedByTurnOne]);
      expect(persistMessages).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
