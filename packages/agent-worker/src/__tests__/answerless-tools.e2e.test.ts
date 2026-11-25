/**
 * Answerless tools, through a whole turn: the runtime a host creates
 * (`createAgentTurnRunner`), the real orchestrator and `ai` loop, and a model
 * scripted through the real `@ai-sdk/openai` package. What is checked is what
 * the turn costs (the requests the provider sends the model), what the person
 * is sent (the room's events), what the host stores, and that the next turn
 * reads the stored conversation as a valid one.
 *
 * A tool whose answer says only that something was written (a note the agent
 * keeps for itself) is declared `answerless`. A step that writes the reply and
 * makes only such calls, all of which succeed, is the turn's last: the model
 * is not called again to read answers it does not need. Anything else in the
 * step (no reply text, a call that failed, another tool) goes on as before.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { AGENT_SOCKET_EVENTS, type TurnStopRecord } from '@ouispec/agent-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentTurnRunner } from '../runtime/turn-runner.js';
import { scriptedChatCompletions, conversationOf, type ChatRequest, type ScriptedReply } from '../testing/scripted.js';
import type { RegisteredTool } from '../tools/types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../runtime/types.js';
import type { AnswerlessEnd, TurnHistoryMessage, TurnMessage } from '../types.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SAID = 'Make the chorus brighter and keep the verse as it is.';
const REPLY = 'I made the chorus brighter and left the verse as it was.';
const AFTER_NOTE = 'Done: the chorus is brighter, and I noted your decision.';

// ─── The realtime server: keeps what the turn sends its room ─────────────────

interface Emitted {
  event: string;
  data: Record<string, unknown>;
}
let emitted: Emitted[] = [];
let realtime: http.Server;
let realtimeUrl: string;
beforeAll(async () => {
  realtime = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/api/emit')) {
        try {
          emitted.push(JSON.parse(body) as Emitted);
        } catch {
          // Not an event.
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => realtime.listen(0, '127.0.0.1', resolve));
  realtimeUrl = `http://127.0.0.1:${(realtime.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => realtime.close(() => resolve()));
});
beforeEach(() => {
  emitted = [];
});

// ─── The product's tools ─────────────────────────────────────────────────────

/** The host's note tool, as studio-api declares its memory's `note`: the chat's own record. */
function noteTool(options: { answerless: boolean; fails?: boolean; whileRunning?: () => Promise<void> }): RegisteredTool & { written: string[] } {
  const written: string[] = [];
  return {
    name: 'note',
    effect: 'edit',
    ...(options.answerless ? { answerless: true } : {}),
    description: 'Write one line in this chat’s work notes.',
    inputSchema: {
      type: 'object',
      sideEffects: false,
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['decision', 'task', 'made'] }, text: { type: 'string' } },
    },
    written,
    async execute(input) {
      await options.whileRunning?.();
      if (options.fails) return { success: false, error: 'NO_CONVERSATION: This turn has no conversation to keep notes in.' };
      written.push(String(input.text));
      return { success: true, data: { id: `note-${written.length}`, kind: input.kind, text: input.text } };
    },
  };
}

/** A tool whose answer the model reads: the work itself. */
const brightenTool: RegisteredTool = {
  name: 'brighten_section',
  effect: 'edit',
  description: 'Make a section of the track brighter.',
  inputSchema: { type: 'object', sideEffects: false, properties: { section: { type: 'string' } } },
  async execute(input) {
    return { success: true, data: { section: input.section, brightness: '+3 dB at 8 kHz' } };
  },
};

const NOTE_CALL = { id: 'call_note', name: 'note', args: { kind: 'decision', text: 'Chorus brighter; verse unchanged.' } };
const BRIGHTEN_CALL = { id: 'call_brighten', name: 'brighten_section', args: { section: 'chorus' } };

/** A stop client that never hears a stop, or the test's own. */
function stopClient(stop?: { fire: (hear: (record: TurnStopRecord) => void) => void }) {
  return {
    watch: (_t: string, _u: string, signal: AbortSignal, onChecked?: () => void) =>
      new Promise<TurnStopRecord | null>((resolve) => {
        stop?.fire(resolve);
        onChecked?.();
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
}

interface Run {
  requests: ChatRequest[];
  outcome: Awaited<ReturnType<ReturnType<typeof createAgentTurnRunner>['run']>>;
  stored: TurnMessage[];
  recorded: { rounds: number; answerlessEnd?: AnswerlessEnd; stopReason?: string } | null;
  events: Emitted[];
}

/** One turn of a product with these tools, its model answering each request with the next of `replies`. */
async function turn(options: {
  tools: RegisteredTool[];
  replies: ScriptedReply[];
  history?: TurnHistoryMessage[];
  stop?: { fire: (hear: (record: TurnStopRecord) => void) => void };
  turnId?: string;
}): Promise<Run> {
  const scripted = scriptedChatCompletions((_request, index) => options.replies[index]);
  let stored: TurnMessage[] = [];
  let recorded: Run['recorded'] = null;
  const config: AgentRuntimeConfig<object> = {
    model: createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scripted.fetch }).chat('gpt-fixture'),
    realtime: { url: realtimeUrl, apiKey: 'realtime-key' },
    systemPrompt: () => 'You help with music.',
    tools: options.tools,
    getDb: async () => ({}),
    getHistory: async () => [...(options.history ?? []), { role: 'user', content: SAID }],
    persistMessages: async ({ messages }) => {
      stored = messages;
    },
    recordTurnComplete: async ({ rounds, answerlessEnd, stopReason }) => {
      recorded = { rounds, ...(answerlessEnd ? { answerlessEnd } : {}), ...(stopReason ? { stopReason } : {}) };
    },
    logger: quiet,
    approvals: { store: { create: async () => {}, redeem: async () => ({ ok: false, reason: 'used', error: 'used' }), status: async () => null } },
    stops: { client: stopClient(options.stop), graceMs: 50 },
    uiActions: { channel: { request: async () => ({ success: false, error: 'not used' }) } as never },
  };
  const payload: AgentTurnPayload = {
    turnId: options.turnId ?? 'turn-answerless-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'conversation:conv-1',
    content: SAID,
    context: { currentPath: '/music/generate', timeZone: 'Europe/Paris' },
  };
  const outcome = await createAgentTurnRunner(config).run(payload, { channel: 'chat' });
  return { requests: scripted.requests, outcome, stored, recorded, events: emitted.filter((e) => e.data?.turnId === payload.turnId) };
}

/** The turn's stored messages, as a host hands them back as the next turn's history. */
function asHistory(messages: TurnMessage[]): TurnHistoryMessage[] {
  return messages.map((m): TurnHistoryMessage =>
    m.role === 'tool'
      ? { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId!, ...(m.name ? { name: m.name } : {}) }
      : {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls
            ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }
            : {}),
        },
  );
}

const roundEnds = (run: Run) => run.events.filter((e) => e.event === AGENT_SOCKET_EVENTS.ROUND_END).map((e) => e.data);
const tokens = (run: Run) =>
  run.events
    .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
    .map((e) => e.data.text)
    .join('');
const turnComplete = (run: Run) => run.events.find((e) => e.event === AGENT_SOCKET_EVENTS.TURN_COMPLETE)?.data;
/** What a turn sends the model, in characters: what its input tokens grow with. */
const sentChars = (run: Run) => run.requests.reduce((sum, r) => sum + JSON.stringify(r.messages).length, 0);

describe('a step that writes the reply and makes only answerless calls', () => {
  it('ends the turn there, with that text as the reply: one model call (acceptance)', async () => {
    const note = noteTool({ answerless: true });
    const run = await turn({ tools: [note], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }] });

    expect(run.requests).toHaveLength(1);
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    expect(note.written).toEqual(['Chorus brighter; verse unchanged.']);
    // Reported: the turn is complete, and ended on the answerless call.
    expect(run.recorded).toEqual({ rounds: 1, answerlessEnd: { tools: ['note'] } });
    expect(turnComplete(run)).toMatchObject({ rounds: 1, endReason: 'complete' });

    // The person is sent the reply, as the turn's last word: a voice that speaks only the final round speaks it.
    expect(tokens(run)).toBe(REPLY);
    expect(roundEnds(run)).toEqual([expect.objectContaining({ step: 0, calledTools: true, final: true })]);

    // Stored: the reply with its call, then the call's result.
    expect(run.stored).toEqual([
      expect.objectContaining({ role: 'assistant', content: REPLY, toolCalls: [expect.objectContaining({ id: 'call_note', name: 'note' })] }),
      expect.objectContaining({ role: 'tool', toolCallId: 'call_note', name: 'note' }),
    ]);
    expect(JSON.parse(run.stored[1].content!)).toMatchObject({ id: 'note-1', kind: 'decision' });
  });

  it('leaves a stored conversation the next turn sends as a valid one: the call, then its result, then the new message', async () => {
    const first = await turn({ tools: [noteTool({ answerless: true })], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }] });
    const next = await turn({
      tools: [noteTool({ answerless: true })],
      replies: [{ text: 'The verse is as it was.' }],
      history: [{ role: 'user', content: 'Brighten the chorus.' }, ...asHistory(first.stored)],
      turnId: 'turn-answerless-2',
    });
    expect(next.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    expect(next.recorded).toEqual({ rounds: 1 });
    const sent = conversationOf(next.requests[0]).filter((m) => m.role !== 'system');
    const call = sent.findIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(sent[call]).toMatchObject({ role: 'assistant', content: REPLY });
    expect(sent[call + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_note' });
    expect(sent.at(-1)).toMatchObject({ role: 'user' });
    expect(JSON.stringify(sent.at(-1)!.content)).toContain(SAID);
  });

  it('sends the same tools and system prompt whether the tool is answerless or not, so the cached prefix is unchanged', async () => {
    const plain = await turn({ tools: [noteTool({ answerless: false })], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }] });
    const answerless = await turn({ tools: [noteTool({ answerless: true })], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }] });
    expect(answerless.requests[0].tools).toEqual(plain.requests[0].tools);
    expect(answerless.requests[0].messages).toEqual(plain.requests[0].messages);
  });

  it('ends on several answerless calls when every one succeeded', async () => {
    const note = noteTool({ answerless: true });
    const second = { id: 'call_note_2', name: 'note', args: { kind: 'task', text: 'Master the track.' } };
    const run = await turn({ tools: [note], replies: [{ text: REPLY, toolCalls: [NOTE_CALL, second] }] });
    expect(run.requests).toHaveLength(1);
    expect(run.recorded).toEqual({ rounds: 1, answerlessEnd: { tools: ['note', 'note'] } });
    expect(run.stored.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_note', 'call_note_2']);
  });
});

describe('a step the turn goes on after, as before', () => {
  it('goes on when the step wrote no reply text', async () => {
    const run = await turn({ tools: [noteTool({ answerless: true })], replies: [{ toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }] });
    expect(run.requests).toHaveLength(2);
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 2 });
    expect(run.recorded).toEqual({ rounds: 2 });
    expect(tokens(run)).toBe(AFTER_NOTE);
  });

  it('goes on when the step wrote only whitespace', async () => {
    const run = await turn({ tools: [noteTool({ answerless: true })], replies: [{ text: '  \n', toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }] });
    expect(run.requests).toHaveLength(2);
    expect(run.recorded).toEqual({ rounds: 2 });
  });

  it('goes on when the answerless call failed: the model reads why', async () => {
    const run = await turn({ tools: [noteTool({ answerless: true, fails: true })], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }] });
    expect(run.requests).toHaveLength(2);
    expect(run.recorded).toEqual({ rounds: 2 });
    const answer = conversationOf(run.requests[1]).find((m) => m.role === 'tool' && m.tool_call_id === 'call_note');
    expect(JSON.stringify(answer?.content)).toContain('NO_CONVERSATION');
    // The first round was not the last: a voice that speaks only the final round speaks the second.
    expect(roundEnds(run).map((r) => r.final)).toEqual([false, true]);
  });

  it('goes on when the step called another tool too', async () => {
    const run = await turn({
      tools: [noteTool({ answerless: true }), brightenTool],
      replies: [{ text: REPLY, toolCalls: [BRIGHTEN_CALL, NOTE_CALL] }, { text: AFTER_NOTE }],
    });
    expect(run.requests).toHaveLength(2);
    expect(run.recorded).toEqual({ rounds: 2 });
  });

  it('goes on when the call names an answerless tool the step could not run (input that is not its schema)', async () => {
    const bad = { id: 'call_note', name: 'note', args: { kind: 'decision', text: 'x', colour: 'red' } };
    const run = await turn({ tools: [noteTool({ answerless: true })], replies: [{ text: REPLY, toolCalls: [bad] }, { text: AFTER_NOTE }] });
    expect(run.requests).toHaveLength(2);
    expect(run.recorded).toEqual({ rounds: 2 });
  });

  it('goes on, as it always has, when the tool is not declared answerless', async () => {
    const run = await turn({ tools: [noteTool({ answerless: false })], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }] });
    expect(run.requests).toHaveLength(2);
    expect(run.recorded).toEqual({ rounds: 2 });
  });
});

describe('a turn stopped while its answerless call runs', () => {
  it('takes the stop path and stores the call with its result', async () => {
    let hear: ((record: TurnStopRecord) => void) | null = null;
    const note = noteTool({
      answerless: true,
      whileRunning: async () => {
        hear?.({ turnId: 'turn-answerless-1', by: 'user-1', reason: 'user_stop', at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const run = await turn({ tools: [note], replies: [{ text: REPLY, toolCalls: [NOTE_CALL] }], stop: { fire: (h) => (hear = h) } });
    expect(run.outcome).toMatchObject({ status: 'stopped', stopReason: 'user_stop' });
    expect(run.requests).toHaveLength(1);
    expect(run.recorded?.answerlessEnd).toBeUndefined();
    const call = run.stored.findIndex((m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'call_note'));
    expect(call).toBeGreaterThanOrEqual(0);
    expect(run.stored[call + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_note' });
  });
});

describe('what it saves, measured', () => {
  it('reply + note: two model calls before, one after', async () => {
    const replies = [{ text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }];
    const before = await turn({ tools: [noteTool({ answerless: false })], replies });
    const after = await turn({ tools: [noteTool({ answerless: true })], replies });
    expect([before.requests.length, after.requests.length]).toEqual([2, 1]);
    expect(sentChars(after)).toBeLessThan(sentChars(before));
  });

  it('work, then reply + note: three model calls before, two after', async () => {
    const replies = [{ toolCalls: [BRIGHTEN_CALL] }, { text: REPLY, toolCalls: [NOTE_CALL] }, { text: AFTER_NOTE }];
    const before = await turn({ tools: [noteTool({ answerless: false }), brightenTool], replies });
    const after = await turn({ tools: [noteTool({ answerless: true }), brightenTool], replies });
    expect([before.requests.length, after.requests.length]).toEqual([3, 2]);
    expect(after.recorded).toEqual({ rounds: 2, answerlessEnd: { tools: ['note'] } });
    // The call it saves is the one that reads the whole conversation again.
    expect(sentChars(after)).toBeLessThan(sentChars(before));
  });
});
