/**
 * A stopped turn (ADR-0252 §2.2–§2.4): what it had produced is stored, every
 * call with exactly one result, and only then is the client told, with why.
 *
 * The stop path runs after the turn's signal was aborted, and builds what it
 * stores from the worker's own record. So it is the same whether the model
 * stream throws on the abort or simply ends, and it never reads the stream's
 * own results, which reject then: the model here fails the test if they are
 * read after an abort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SOCKET_EVENTS, turnStoppedNote, type TurnStopRecord } from '@ouispec/agent-core';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage, TurnMessage } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';
import type { TurnStopWatch } from '../stop/turn-stop.js';

type Opts = {
  abortSignal: AbortSignal;
  messages: Array<{ role: string; content: unknown }>;
  tools: Record<string, { execute: (args: unknown, opts: unknown) => Promise<string> }>;
  onStepEnd: (step: { text: string; toolCalls: unknown[]; usage: { inputTokens: number; outputTokens: number } }) => Promise<void>;
};
type Mode = 'throws' | 'ends';
interface ModelApi {
  opts: Opts;
  /** Resolves when the turn's signal aborts. */
  aborted: Promise<void>;
  /** A step ended: the model's own callback. */
  step(text: string, calls?: Array<{ toolName: string; toolCallId: string; input: unknown }>): Promise<void>;
}

let mode: Mode = 'throws';
let script: (api: ModelApi) => AsyncGenerator<string>;
let streamCalls = 0;
let lastOpts: Opts | null = null;

vi.mock('ai', () => ({
  streamText: (raw: unknown) => {
    const opts = raw as Opts;
    streamCalls++;
    lastOpts = opts;
    const aborted = new Promise<void>((resolve) => {
      if (opts.abortSignal.aborted) resolve();
      else opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
    const steps: unknown[] = [];
    const api: ModelApi = {
      opts,
      aborted,
      step: async (text, calls = []) => {
        const step = { text, toolCalls: calls, usage: { inputTokens: 100, outputTokens: 10 } };
        steps.push(step);
        await opts.onStepEnd(step);
      },
    };
    const afterAbort = (what: string) => {
      if (opts.abortSignal.aborted) throw new Error(`the stop path read the stream's ${what} after the abort`);
    };
    return {
      textStream: (async function* () {
        yield* script(api);
        // The abort surfaces one of two ways.
        if (opts.abortSignal.aborted && mode === 'throws') throw new DOMException('This operation was aborted', 'AbortError');
      })(),
      get steps() {
        afterAbort('steps');
        return Promise.resolve(steps);
      },
      get usage() {
        afterAbort('usage');
        return Promise.resolve({ inputTokens: 100 * steps.length, outputTokens: 10 * steps.length });
      },
      get response() {
        afterAbort('response');
        return Promise.resolve({ messages: [] });
      },
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

/** A stop watch the test fires. */
function stopSource(initial: TurnStopRecord | null = null) {
  let heard = initial;
  let closed = false;
  let listener: ((r: TurnStopRecord) => void) | null = null;
  const watch: TurnStopWatch = {
    current: () => (closed ? null : heard),
    onStop(next) {
      if (closed) return;
      listener = next;
      if (heard) next(heard);
    },
    close() {
      closed = true;
      listener = null;
    },
  };
  return {
    watch,
    isClosed: () => closed,
    fire(reason: TurnStopRecord['reason'] = 'user_stop') {
      heard = { turnId: 'turn-1', by: 'user-1', reason, at: 1_700_000_000_000 };
      listener?.(heard);
    },
  };
}

const turn = (stopWatch: TurnStopWatch, history: TurnHistoryMessage[] = []): AgentTurnInput => ({
  turnId: 'turn-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  accountId: 'acct-1',
  socketRoom: 'agent:turn:turn-1',
  content: 'Rename the draft, then tidy the notes.',
  history,
  stopWatch,
});

/** Runs a turn, recording what was stored and what was announced, in order. */
async function run(options: { stop: ReturnType<typeof stopSource>; tools?: RegisteredTool[]; history?: TurnHistoryMessage[]; store?: () => Promise<void> }) {
  const order: string[] = [];
  let stored: TurnMessage[] | null = null;
  let storedAs: unknown = null;
  const announced: Array<Record<string, unknown>> = [];
  const config: AgentWorkerConfig = {
    tools: createToolRegistry(options.tools ?? []),
    model: 'test-model' as never,
    systemPrompt: 'test',
    stopGraceMs: 40,
    emit: {
      emit: vi.fn(async (_room: string, event: string, data: unknown) => {
        if (event === AGENT_SOCKET_EVENTS.TURN_COMPLETE) {
          order.push('turn_complete');
          announced.push(data as Record<string, unknown>);
        }
      }),
    },
    beforeTurnComplete: async ({ newMessages, stopped }) => {
      await options.store?.();
      // A store that takes a moment: the announcement must not overtake it.
      await new Promise((resolve) => setTimeout(resolve, 15));
      stored = newMessages;
      storedAs = stopped ?? null;
      order.push('stored');
    },
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  const result = await runAgentTurn(config, turn(options.stop.watch, options.history));
  return { result, order, stored: stored as TurnMessage[] | null, storedAs, announced };
}

const MARKER = { reason: 'user_stop', at: 1_700_000_000_000 } as const;

beforeEach(() => {
  vi.resetModules();
  mode = 'throws';
  streamCalls = 0;
  lastOpts = null;
});

describe.each(['throws', 'ends'] as const)('a stop during the model’s answer, when the abort %s', (how) => {
  beforeEach(() => {
    mode = how;
  });

  it('keeps the text produced so far, marked, and announces only after it is stored', async () => {
    const stop = stopSource();
    script = async function* (api) {
      yield 'I renamed the draft. Next I will ';
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
    };
    const { result, order, stored, storedAs, announced } = await run({ stop });

    expect(order).toEqual(['stored', 'turn_complete']);
    expect(stored).toEqual([{ role: 'assistant', content: 'I renamed the draft. Next I will ', stopped: MARKER }]);
    expect(storedAs).toEqual(MARKER);
    expect(announced).toEqual([expect.objectContaining({ turnId: 'turn-1', stopReason: 'user_stop', rounds: 0 })]);
    expect(result.stopReason).toBe('user_stop');
    expect(result.stopped).toEqual(MARKER);
    expect(result.newMessages).toEqual(stored);
    // Nothing listens for a stop once the turn has ended.
    expect(stop.isClosed()).toBe(true);
  });

  it('keeps the steps that finished as they were, and the step it was in after them', async () => {
    const stop = stopSource();
    const rename: RegisteredTool = {
      name: 'rename',
      description: 'Renames the draft.',
      inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
      execute: async (input) => ({ success: true, data: { renamed: input.title } }),
    };
    script = async function* (api) {
      yield 'Renaming. ';
      await api.opts.tools.rename.execute({ title: 'Launch plan' }, { toolCallId: 'call-1' });
      await api.step('Renaming. ', [{ toolName: 'rename', toolCallId: 'call-1', input: { title: 'Launch plan' } }]);
      yield 'Done. Now the notes';
      setTimeout(() => stop.fire('superseded'), 5);
      await api.aborted;
    };
    const { stored, announced, result } = await run({ stop, tools: [rename] });

    expect(stored).toEqual([
      { role: 'assistant', content: 'Renaming. ', toolCalls: [{ id: 'call-1', name: 'rename', arguments: { title: 'Launch plan' } }] },
      { role: 'tool', content: JSON.stringify({ renamed: 'Launch plan' }), toolCallId: 'call-1', name: 'rename' },
      { role: 'assistant', content: 'Done. Now the notes', stopped: { reason: 'superseded', at: 1_700_000_000_000 } },
    ]);
    expect(announced[0]).toMatchObject({ stopReason: 'superseded', rounds: 1 });
    // The step that ended reported its tokens; the one the stop cut short did not.
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 10, totalTokens: 110 });
  });
});

describe.each(['throws', 'ends'] as const)('a stop while a tool is running, when the abort %s', (how) => {
  beforeEach(() => {
    mode = how;
  });

  it('gives a call the stop cut short one result, saying its outcome is unknown', async () => {
    const stop = stopSource();
    /** Honours the turn's signal: it rejects when the turn is aborted. */
    const slow: RegisteredTool = {
      name: 'slow',
      description: 'Takes a while.',
      inputSchema: { type: 'object', properties: {} },
      execute: (_input, ctx) =>
        new Promise((_, reject) => ctx.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    };
    script = async function* (api) {
      yield 'Working on it. ';
      const call = api.opts.tools.slow.execute({}, { toolCallId: 'call-slow' });
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
      await call.catch(() => undefined);
    };
    const { stored, order } = await run({ stop, tools: [slow] });

    expect(order).toEqual(['stored', 'turn_complete']);
    expect(stored).toHaveLength(2);
    expect(stored![0]).toEqual({
      role: 'assistant',
      content: 'Working on it. ',
      toolCalls: [{ id: 'call-slow', name: 'slow', arguments: {} }],
      stopped: MARKER,
    });
    expect(stored![1]).toMatchObject({ role: 'tool', toolCallId: 'call-slow', name: 'slow' });
    expect(JSON.parse(stored![1].content!)).toMatchObject({ stopped: true, outcome: 'unknown' });
  });

  it('does not wait past its grace for a tool that ignores the stop: the call is stored as running, outcome unknown', async () => {
    const stop = stopSource();
    let release!: () => void;
    const deaf: RegisteredTool = {
      name: 'deaf',
      description: 'Never looks at the signal.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => new Promise((resolve) => (release = () => resolve({ success: true, data: { late: true } }))),
    };
    script = async function* (api) {
      void api.opts.tools.deaf.execute({}, { toolCallId: 'call-deaf' });
      yield '';
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
    };
    const started = Date.now();
    const { stored } = await run({ stop, tools: [deaf] });
    // The grace (40 ms here) and its margin, not the tool's 30 s timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    release();

    expect(stored!.map((m) => m.role)).toEqual(['assistant', 'tool']);
    // No text was produced: the message is its call, never an empty text block.
    expect(stored![0]).toMatchObject({ content: null, toolCalls: [{ id: 'call-deaf', name: 'deaf' }], stopped: MARKER });
    expect(JSON.parse(stored![1].content!)).toMatchObject({ stopped: true, sent: true, outcome: 'unknown' });
  });

  it('starts nothing after the stop: a call that arrives late is stored as not run', async () => {
    const stop = stopSource();
    const ran = vi.fn(async () => ({ success: true }));
    const late: RegisteredTool = { name: 'late', description: 'Arrives late.', inputSchema: { type: 'object', properties: {} }, execute: ran };
    script = async function* (api) {
      yield 'One moment. ';
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
      await api.opts.tools.late.execute({}, { toolCallId: 'call-late' });
    };
    const { stored } = await run({ stop, tools: [late] });
    expect(ran).not.toHaveBeenCalled();
    expect(JSON.parse(stored![1].content!)).toMatchObject({ stopped: true, notRun: true });
  });
});

describe('a turn stopped before it produced anything', () => {
  it('heard before it starts: the model is never called, and one message says the turn was stopped', async () => {
    const stop = stopSource({ turnId: 'turn-1', by: 'user-1', reason: 'superseded', at: 1_700_000_000_000 });
    script = async function* () {
      yield 'never';
    };
    const { stored, order, announced, result } = await run({ stop });

    expect(streamCalls).toBe(0);
    const marker = { reason: 'superseded', at: 1_700_000_000_000 } as const;
    // Its text is the marker's line: a model provider refuses an empty text block.
    expect(stored).toEqual([{ role: 'assistant', content: turnStoppedNote(marker), stopped: marker }]);
    expect(order).toEqual(['stored', 'turn_complete']);
    expect(announced[0]).toMatchObject({ stopReason: 'superseded', rounds: 0 });
    expect(result.usage.totalTokens).toBe(0);
  });

  it('stopped as the model began, with no text and no call: the same one message', async () => {
    const stop = stopSource();
    script = async function* (api) {
      yield '';
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
    };
    const { stored } = await run({ stop });
    expect(stored).toEqual([{ role: 'assistant', content: turnStoppedNote(MARKER), stopped: MARKER }]);
  });

  it('whitespace alone is not text either', async () => {
    const stop = stopSource();
    script = async function* (api) {
      yield '\n\n';
      setTimeout(() => stop.fire(), 5);
      await api.aborted;
    };
    const { stored } = await run({ stop });
    expect(stored).toEqual([{ role: 'assistant', content: turnStoppedNote(MARKER), stopped: MARKER }]);
  });
});

describe('a stop that lands after the turn has begun its own end', () => {
  it('is not a stop: the turn completes once, with no marker and no stop reason', async () => {
    const stop = stopSource();
    script = async function* (api) {
      yield 'All done.';
      await api.step('All done.');
    };
    // Fired between the normal persist starting and the announcement.
    const { result, order, stored, storedAs, announced } = await run({ stop, store: async () => stop.fire() });

    expect(order).toEqual(['stored', 'turn_complete']);
    expect(announced).toHaveLength(1);
    expect(announced[0]).not.toHaveProperty('stopReason');
    expect(result.stopReason).toBe('complete');
    expect(result.stopped).toBeUndefined();
    expect(storedAs).toBeNull();
    expect(stored).toEqual([{ role: 'assistant', content: 'All done.' }]);
    // Its watch was closed before the store began.
    expect(stop.isClosed()).toBe(true);
  });

  it('heard after the model finished and before the store began, it is a stop: what was said is stored, marked', async () => {
    const stop = stopSource();
    script = async function* (api) {
      yield 'All done.';
      await api.step('All done.');
      stop.fire();
    };
    const { result, stored, announced } = await run({ stop });
    expect(stored).toEqual([{ role: 'assistant', content: 'All done.', stopped: MARKER }]);
    expect(announced).toEqual([expect.objectContaining({ stopReason: 'user_stop' })]);
    expect(result.stopReason).toBe('user_stop');
  });
});

describe('a later turn, reading a stopped turn in its history', () => {
  const said = () => (lastOpts!.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'assistant');
  const textOf = (m: { content: unknown }) =>
    (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text);

  it('is told the turn was stopped, after what it had said', async () => {
    script = async function* (api) {
      yield 'Understood.';
      await api.step('Understood.');
    };
    await run({
      stop: stopSource(),
      history: [
        { role: 'user', content: 'Rename the draft.' },
        { role: 'assistant', content: 'I renamed the draft. Next I will ', stopped: MARKER },
      ],
    });
    expect(textOf(said()[0])).toEqual([`I renamed the draft. Next I will \n\n${turnStoppedNote(MARKER)}`]);
  });

  it('reads a marker-only message as the marker’s line, once, and never as an empty text block', async () => {
    script = async function* (api) {
      yield 'Understood.';
      await api.step('Understood.');
    };
    await run({
      stop: stopSource(),
      history: [
        { role: 'user', content: 'Rename the draft.' },
        // As this SDK stores it, and as a host that kept only the marker hands it back.
        { role: 'assistant', content: turnStoppedNote(MARKER), stopped: MARKER },
        { role: 'user', content: 'Actually, delete it.' },
        { role: 'assistant', content: null, stopped: { reason: 'superseded', at: 2 } },
        { role: 'user', content: 'No, keep it.' },
        { role: 'assistant', content: '  ', stopped: MARKER },
      ],
    });
    expect(said().map(textOf)).toEqual([
      [turnStoppedNote(MARKER)],
      [turnStoppedNote({ reason: 'superseded' })],
      [turnStoppedNote(MARKER)],
    ]);
  });
});
