/**
 * A turn resumed after work: the person's tab starts it by itself because work the assistant started in an earlier
 * turn finished after that turn had ended (the payload's `resume`).
 *
 * On dev (2026-11-06) the assistant started a minute-long image job, the call answered "running" after 20 s, the
 * turn ended, and the job's outcome reached nobody until the person wrote again. The resumed turn reads each
 * request's final answer from the realtime server, gives it to the model as the later result of the call that
 * started the work, in place of "still running", and stores it under that call's id, so every later turn reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { stillRunningNote } from '../ui/ui-tools.js';
import { STATE_AT_END } from '../ui/page-state-at-end.js';
import { payloadRefusal } from '../runtime/turn-runner.js';
import { RESUME_READ_WAIT_MS, resumeNote, resumedCalls } from '../resume/resumed-calls.js';
// What a host's `recordTurnComplete` is given, from the package's root.
import type { ResumedTurn } from '../index.js';

// ─── The model, played by the test: it says what it is told to, and the test reads what it was sent ──────────

type Sent = { messages: Array<{ role: string; content: unknown }> };
let seen: Sent[];
let reply = 'The three versions are ready in the Layers panel.';
vi.mock('ai', () => ({
  streamText: (opts: Sent) => {
    seen.push(opts);
    const steps = Promise.resolve([{ text: reply, toolCalls: [] }]);
    return {
      textStream: (async function* () {
        yield reply;
      })(),
      steps: steps.then((ss) => ss.map((s) => ({ ...s, usage: { inputTokens: 10 } }))),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: reply }] }),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  seen = [];
  reply = 'The three versions are ready in the Layers panel.';
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Not a log line of the worker's.
    }
  });
});
afterEach(() => vi.restoreAllMocks());

// ─── The conversation: a job started in an earlier turn, reported still running ─────────────────────────────────

const VARIANTS = 'image_studio_variants_across_backgrounds';
const studio: OUISurface = {
  id: 'room:image-studio',
  name: 'Image Studio',
  description: 'a layered picture editor',
  actions: [
    {
      id: VARIANTS,
      title: 'Variants across backgrounds',
      description: 'Places one subject on each of several backgrounds',
      input: { type: 'object', properties: {} },
      async: true,
      polling: { intervalMs: 1000, maxDurationMs: 360_000 },
    },
  ],
};

/** What the worker stored for a job's call that answered "running": the shape `runAction` gives it. */
const runningRow = (callId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...extra,
    result: { status: 'started', jobId: `local:${callId}` },
    page: { surfaces: ['Image Studio'] },
    pageState: STATE_AT_END,
    status: 'running',
    note: stillRunningNote({ id: VARIANTS }),
  });

function historyWith(calls: Array<{ id: string; row?: string | null }>): TurnHistoryMessage[] {
  return [
    { role: 'user', content: 'Put Ruth on the beach, the forest and the city, with matching light' },
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: 'ui_act', arguments: JSON.stringify({ action: VARIANTS, input: {} }) } })),
    },
    ...calls.flatMap((c) => (c.row === null ? [] : [{ role: 'tool' as const, content: c.row ?? runningRow(c.id), tool_call_id: c.id, name: 'ui_act' }])),
    { role: 'assistant', content: 'It is still making the three versions; that takes about a minute.' },
  ];
}

/** The final answer the tab sent when the job ended, as the realtime server keeps it. */
const finished = (requestId: string): OUIActionResult => ({
  requestId,
  success: true,
  interim: false,
  data: { status: 'complete', jobId: `local:${requestId}`, made: [{ background: 'beach', group: 'g1' }, { background: 'forest', group: 'g2' }] },
  observations: { 'room:image-studio': { layers: [{ id: 'g1', name: 'Ruth in beach' }] } },
  surfacesHash: 'h1',
  timestamp: 2,
});

/** The realtime server's results, as the worker's channel reads them. */
function store(finals: Record<string, OUIActionResult>) {
  const awaitResult = vi.fn(async (requestId: string, _opts: { userId: string; timeoutMs: number; final?: boolean }) => finals[requestId] ?? null);
  const channel: UIActionChannel = { dispatch: vi.fn(async () => null), awaitResult };
  return { channel, awaitResult };
}

function config(channel: UIActionChannel, extra: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    systemPrompt: 'test',
    ui: { channel, resultTimeoutMs: 200 },
    ...extra,
  };
}

const snapshot = {
  surfaces: [studio],
  observations: { 'room:image-studio': { layers: [{ id: 'g1', name: 'Ruth in beach' }, { id: 'g2', name: 'Ruth in forest' }] } },
  surfacesHash: 'h1',
};

function resumeTurn(history: TurnHistoryMessage[], requestIds: string[]): AgentTurnInput {
  return {
    turnId: 'turn-resume',
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:turn-resume',
    content: '',
    history,
    context: { currentPath: '/image', oui: snapshot },
    resume: { requestIds },
  };
}

/** The text of the result the model was given for a call. */
function resultOf(sent: Sent, callId: string): string | undefined {
  for (const m of sent.messages) {
    if (m.role !== 'tool') continue;
    for (const part of m.content as Array<{ type: string; toolCallId: string; output: { value: string } }>) {
      if (part.type === 'tool-result' && part.toolCallId === callId) return part.output.value;
    }
  }
  return undefined;
}
const lastUserText = (sent: Sent) => {
  const user = sent.messages.filter((m) => m.role === 'user').at(-1);
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('the turn payload', () => {
  const base = { turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: '' };

  it('takes resume: 1 to 8 non-empty request ids of at most 200 characters', () => {
    expect(payloadRefusal({ ...base, resume: { requestIds: ['call_1'] } })).toBeNull();
    expect(payloadRefusal({ ...base, resume: { requestIds: Array.from({ length: 8 }, (_, i) => `call_${i}`) } })).toBeNull();
    expect(payloadRefusal({ ...base, resume: { requestIds: [] } })).toMatch(/1 to 8/);
    expect(payloadRefusal({ ...base, resume: { requestIds: Array.from({ length: 9 }, (_, i) => `call_${i}`) } })).toMatch(/1 to 8/);
    expect(payloadRefusal({ ...base, resume: { requestIds: [''] } })).toMatch(/non-empty/);
    expect(payloadRefusal({ ...base, resume: { requestIds: ['x'.repeat(201)] } })).toMatch(/at most 200/);
    expect(payloadRefusal({ ...base, resume: ['call_1'] })).toMatch(/must be an object/);
  });

  it('never takes resume and approval together', async () => {
    expect(
      payloadRefusal({ ...base, resume: { requestIds: ['call_1'] }, approval: { approvalId: 'a', decision: 'decline' } }),
    ).toMatch(/resume or approval, never both/);
    const { runAgentTurn } = await import('../orchestrator.js');
    await expect(
      runAgentTurn(config(store({}).channel), { ...resumeTurn(historyWith([{ id: 'call_1' }]), ['call_1']), approval: { approvalId: 'a', decision: 'decline' } }),
    ).rejects.toThrow(/never both/);
  });
});

describe('a turn resumed after work', () => {
  it('reads the final answer, gives the model the outcome in place of "still running", and stores it under the call’s id', async () => {
    const { channel, awaitResult } = store({ call_variants: finished('call_variants') });
    const beforeTurnComplete = vi.fn(async () => {});
    const emit = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      config(channel, { beforeTurnComplete, emit: { emit } }),
      resumeTurn(historyWith([{ id: 'call_variants' }]), ['call_variants']),
    );

    // The final answer, from the realtime server, for this user, briefly.
    expect(awaitResult).toHaveBeenCalledOnce();
    expect(awaitResult.mock.calls[0][0]).toBe('call_variants');
    expect(awaitResult.mock.calls[0][1]).toMatchObject({ userId: 'user-1', final: true, timeoutMs: RESUME_READ_WAIT_MS });

    // What the model is sent: the call's one result is now its outcome, in ui_wait's words.
    expect(seen).toHaveLength(1);
    const given = resultOf(seen[0], 'call_variants')!;
    expect(JSON.parse(given)).toMatchObject({
      action: VARIANTS,
      jobId: 'local:call_variants',
      result: { status: 'complete', made: [{ background: 'beach', group: 'g1' }, { background: 'forest', group: 'g2' }] },
      pageState: STATE_AT_END,
    });
    expect(given).not.toMatch(/"status":"running"/);
    expect(given).not.toMatch(/not done/);
    const results = seen[0].messages.filter((m) => m.role === 'tool');
    expect(results).toHaveLength(1);

    // In place of a message: the note, in plain words, naming the work by its title.
    const note = lastUserText(seen[0]);
    expect(note).toMatch(/^<resumed>Nobody wrote anything: this turn started by itself/);
    expect(note).toContain('"Variants across backgrounds" (image_studio_variants_across_backgrounds)');
    expect(note).toMatch(/Its outcome is now the result of the call that started it, above, in place of "still running"/);
    expect(note).toMatch(/check what the page shows before you claim anything/);
    expect(note).toMatch(/If their earlier request needed this outcome to go on, go on with it/);
    expect(note).toMatch(/not by its id/);
    // The person's own earlier message is still theirs, unchanged.
    expect(seen[0].messages.filter((m) => m.role === 'user')).toHaveLength(2);

    // Stored: the later result under the call's own id, then the reply.
    expect(result.newMessages[0]).toEqual({ role: 'tool', content: given, toolCallId: 'call_variants', name: 'ui_act' });
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: reply });
    expect(beforeTurnComplete.mock.calls[0][0]).toMatchObject({ newMessages: result.newMessages });
    const record: ResumedTurn = { requestIds: ['call_variants'], reported: ['call_variants'], unreadable: [], ignored: [] };
    expect(result.resumed).toEqual(record);
    expect(result.stopReason).toBe('complete');

    // Marked in the logs and the usage.
    expect(logs.find((l) => l.message === 'Turn started')).toMatchObject({ resumed: { requestIds: ['call_variants'] } });
    expect(logs.find((l) => l.message === 'Turn usage')).toMatchObject({ resumed: { reported: ['call_variants'] } });
  });

  it('never reads a request whose call is not in this conversation, and calls no model when nothing is left to report', async () => {
    const { channel, awaitResult } = store({ call_elsewhere: finished('call_elsewhere') });
    const emit = vi.fn(async () => {});
    const beforeTurnComplete = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(
      config(channel, { emit: { emit }, beforeTurnComplete }),
      resumeTurn(historyWith([{ id: 'call_variants' }]), ['call_elsewhere']),
    );
    expect(awaitResult).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(result).toMatchObject({ rounds: 0, newMessages: [], stopReason: 'complete' });
    expect(result.resumed).toEqual({ requestIds: ['call_elsewhere'], reported: [], unreadable: [], ignored: [{ requestId: 'call_elsewhere', reason: 'not_in_history' }] });
    // The turn still ends, so the tab stops showing it working.
    expect(emit).toHaveBeenCalledWith('agent:turn:turn-resume', 'agent:turn_complete', expect.objectContaining({ turnId: 'turn-resume', rounds: 0, endReason: 'complete' }));
    expect(beforeTurnComplete).toHaveBeenCalledWith(expect.objectContaining({ newMessages: [] }));
    expect(logs.find((l) => l.message === 'A resumed turn left a request out')).toMatchObject({ requestId: 'call_elsewhere', reason: 'not_in_history' });
  });

  it('reports what it can read, says what it cannot, and leaves out what is already reported', async () => {
    const { channel, awaitResult } = store({ call_a: finished('call_a') });
    const { runAgentTurn } = await import('../orchestrator.js');
    const done = JSON.stringify({ action: VARIANTS, result: { status: 'complete' }, pageState: STATE_AT_END });
    const result = await runAgentTurn(
      config(channel),
      resumeTurn(historyWith([{ id: 'call_a' }, { id: 'call_b' }, { id: 'call_c', row: done }]), ['call_a', 'call_b', 'call_c', 'call_x']),
    );
    expect(awaitResult.mock.calls.map((c) => c[0])).toEqual(['call_a', 'call_b']);
    expect(JSON.parse(resultOf(seen[0], 'call_a')!)).toMatchObject({ result: { status: 'complete' } });
    // Not read: it keeps its "still running" result, and the note says its outcome could not be read.
    expect(resultOf(seen[0], 'call_b')).toMatch(/"status":"running"/);
    expect(resultOf(seen[0], 'call_c')).toBe(done);
    const note = lastUserText(seen[0]);
    expect(note).toMatch(/could not be read \(it is no longer kept, or never arrived\): check what the page shows before you say anything about it/);
    expect(note).toMatch(/The outcome of "Variants across backgrounds" \(image_studio_variants_across_backgrounds\) is now the result of the call that started it/);
    // Only the outcome that was read is stored.
    expect(result.newMessages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_a']);
    expect(result.resumed).toEqual({
      requestIds: ['call_a', 'call_b', 'call_c', 'call_x'],
      reported: ['call_a'],
      unreadable: ['call_b'],
      ignored: [
        { requestId: 'call_c', reason: 'already_reported' },
        { requestId: 'call_x', reason: 'not_in_history' },
      ],
    });
  });

  it('with only unreadable work still runs, so the assistant checks the page and tells the person', async () => {
    const { channel } = store({});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(channel), resumeTurn(historyWith([{ id: 'call_lost' }]), ['call_lost']));
    expect(seen).toHaveLength(1);
    expect(lastUserText(seen[0])).toMatch(/could not be read/);
    expect(result.newMessages).toEqual([{ role: 'assistant', content: reply }]);
  });
});

describe('the calls a resume names', () => {
  it('finds an approved call that followed as its own, and keeps its approval on the later result', async () => {
    const approval = { approved: true, by: 'the person', ran: true, summary: 'The user approved it and it ran once.' };
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Export it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'appr_1-approved', type: 'function', function: { name: 'ui_act', arguments: JSON.stringify({ action: VARIANTS, input: {} }) } }],
      },
      { role: 'tool', content: runningRow('appr_1', { approval }), tool_call_id: 'appr_1-approved', name: 'ui_act' },
    ];
    expect(resumedCalls(history, ['appr_1', 'appr_1'])).toEqual({
      calls: [{ requestId: 'appr_1', callId: 'appr_1-approved', name: 'ui_act', actionId: VARIANTS, jobId: 'local:appr_1', approval }],
      ignored: [],
    });

    const { channel } = store({ appr_1: finished('appr_1') });
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(channel), resumeTurn(history, ['appr_1']));
    const stored = result.newMessages[0];
    expect(stored).toMatchObject({ role: 'tool', toolCallId: 'appr_1-approved' });
    expect(JSON.parse(stored.content!)).toMatchObject({ approval, action: VARIANTS, result: { status: 'complete' } });
  });

  it('names work without a title by its id, and several by each', () => {
    const titles = (id: string) => (id === 'b' ? 'Export' : undefined);
    const note = resumeNote([{ actionId: 'a' }, { actionId: 'b' }], [], titles);
    expect(note).toContain('"a", "Export" (b)');
    expect(note).toMatch(/the result of the call that started each/);
    expect(note).toMatch(/what came of each/);
  });
});
