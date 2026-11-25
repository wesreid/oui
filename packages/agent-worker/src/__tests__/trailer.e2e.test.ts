/**
 * The note trailer, through a whole turn: the runtime a host creates
 * (`createAgentTurnRunner`), the real orchestrator and `ai` loop, and a model
 * scripted through the real `@ai-sdk/openai` package, its text in pieces as a
 * live stream gives it. What is checked is what the turn costs (the requests
 * the provider was sent), what the person is sent (the room's events), what
 * the host stores and is told, and how the next turn reads it back.
 *
 * A trailer tool (`RegisteredTool.trailer`) is written into the response after
 * the reply, as `<oui:note>{json}</oui:note>`. Its definition is not sent; the
 * system prompt teaches it. The reply and the note arrive in one model call.
 */
import { AGENT_SOCKET_EVENTS, type TurnStopRecord } from '@ouispec/agent-core';
import { describe, expect, it } from 'vitest';
import {
  AFTER_NOTE,
  asHistory,
  BRIGHTEN_CALL,
  brightenTool,
  NOTE_CALL,
  noteTool,
  noteTurn,
  REPLY,
  roundEnds,
  scriptedOpenAIModel,
  tokens,
  type NoteTurnRun,
} from './support/note-turn.js';
import { scriptedOpenAIWire, type WireReply } from './support/provider-wire.js';
import { isStepTail } from '../testing/scripted.js';
import { isTrailerCallId, TRAILER_CALL_ID_PREFIX } from '../tools/trailer.js';
import type { RegisteredTool } from '../tools/types.js';
import type { TurnPolicy } from '../turn-policy.js';

const NOTE = { kind: 'decision', text: 'Chorus brighter; verse unchanged.' };
const TRAILER = `<oui:note>${JSON.stringify(NOTE)}</oui:note>`;

/** The reply and its trailer as a live stream gives them: in small pieces, the tag cut across them. */
const pieces = (text: string, size = 7): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

interface Request {
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: unknown;
}
const requestsOf = (run: NoteTurnRun) => run.requests as Request[];
const toolNames = (request: Request) => (request.tools ?? []).map((t) => t.function.name);
const systemOf = (request: Request) => String(request.messages[0].content);

async function trailerTurn(replies: WireReply[], extra: Partial<Parameters<typeof noteTurn>[0]> & { tools?: RegisteredTool[] } = {}) {
  const note = noteTool({ answerless: true, trailer: true });
  const tools = extra.tools ?? [note];
  const run = await noteTurn({ ...extra, tools, provider: scriptedOpenAIWire(replies) });
  return { run, note: tools.find((t) => t.name === 'note') as ReturnType<typeof noteTool> };
}

describe('a reply with its note as a trailer', () => {
  it('is one model call: the turn ends on it, and the host is told it ended on a trailer', async () => {
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY}\n\n${TRAILER}`) }]);

    expect(run.requests).toHaveLength(1);
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    expect(run.recorded).toEqual({ rounds: 1, answerlessEnd: { tools: ['note'], trailer: true, trailers: 1 } });
    // The note's tool is given its input as JSON read from the trailer.
    expect(note.written).toEqual([NOTE]);
    // The person is sent the reply alone, as the turn's last word.
    expect(tokens(run)).toBe(REPLY);
    for (const e of run.events.filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)) expect(String(e.data.text)).not.toContain('<oui:');
    expect(roundEnds(run)).toEqual([expect.objectContaining({ step: 0, calledTools: true, final: true })]);
  });

  it('stores what a step that wrote its reply and called the tool stores', async () => {
    const { run } = await trailerTurn([{ text: pieces(`${REPLY}\n\n${TRAILER}`) }]);
    const called = await noteTurn({ tools: [noteTool({ answerless: true })], provider: scriptedOpenAIModel([{ text: REPLY, toolCalls: [{ ...NOTE_CALL, args: NOTE }] }]) });
    const id = run.stored[0].toolCalls![0].id;
    expect(id.startsWith(TRAILER_CALL_ID_PREFIX)).toBe(true);
    expect(JSON.parse(JSON.stringify(run.stored).split(id).join(NOTE_CALL.id))).toEqual(called.stored);
    expect(run.stored).toEqual([
      { role: 'assistant', content: REPLY, toolCalls: [{ id, name: 'note', arguments: NOTE }] },
      { role: 'tool', content: JSON.stringify({ id: 'note-1', ...NOTE }), toolCallId: id, name: 'note' },
    ]);
  });

  it('is the same with the trailer written before the reply', async () => {
    const after = await trailerTurn([{ text: pieces(`${REPLY}\n${TRAILER}`) }]);
    const before = await trailerTurn([{ text: pieces(`${TRAILER}\n${REPLY}`) }]);
    expect(before.run.recorded).toEqual(after.run.recorded);
    expect(tokens(before.run)).toBe(REPLY);
    expect(before.run.stored[0].content).toBe(REPLY);
    expect(before.note.written).toEqual([NOTE]);
  });

  it('sends no definition of the trailer tool, and teaches it in a system prompt every step shares', async () => {
    const { run } = await trailerTurn(
      [{ text: pieces(`Brightening the chorus. ${TRAILER}`), toolCalls: [BRIGHTEN_CALL] }, { text: pieces(AFTER_NOTE) }],
      { tools: [noteTool({ answerless: true, trailer: true }), brightenTool] },
    );
    expect(run.requests).toHaveLength(2);
    for (const request of requestsOf(run)) expect(toolNames(request)).toEqual(['brighten_section']);
    expect(systemOf(requestsOf(run)[0])).toContain('## NOTES: `note`');
    expect(systemOf(requestsOf(run)[0])).toContain('`note` is not a tool you call');
    expect(systemOf(requestsOf(run)[1])).toBe(systemOf(requestsOf(run)[0]));
  });

  it('beside another call, goes on, and the next step reads the note as the trailer it was: no call or result of it', async () => {
    const { run, note } = await trailerTurn(
      [{ text: pieces(`Brightening the chorus. ${TRAILER}`), toolCalls: [BRIGHTEN_CALL] }, { text: pieces(AFTER_NOTE) }],
      { tools: [noteTool({ answerless: true, trailer: true }), brightenTool] },
    );
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 2 });
    expect(note.written).toEqual([NOTE]);
    const second = requestsOf(run)[1];
    const sent = JSON.stringify(second.messages);
    expect(sent).not.toContain(TRAILER_CALL_ID_PREFIX);
    const assistant = second.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.tool_calls?.map((c) => c.function.name)).toEqual(['brighten_section']);
    expect(assistant.content).toBe(`Brightening the chorus.\n\n<oui:note>{"kind":"decision","text":"Chorus brighter; verse unchanged."}</oui:note>`);
    expect(second.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([BRIGHTEN_CALL.id]);
    // Stored as the step was: its text, both calls, both results.
    expect(run.stored[0].toolCalls!.map((c) => c.name)).toEqual(['note', 'brighten_section']);
    expect(tokens(run)).toBe(`Brightening the chorus.\n\n${AFTER_NOTE}`);
  });

  it('is read back as the trailer it was on the next turn, in the bytes its own turn sent', async () => {
    const first = await trailerTurn([{ text: pieces(`Brightening the chorus. ${TRAILER}`), toolCalls: [BRIGHTEN_CALL] }, { text: pieces(AFTER_NOTE) }], {
      tools: [noteTool({ answerless: true, trailer: true }), brightenTool],
    });
    const next = await trailerTurn([{ text: ['The verse is as it was.'] }], {
      tools: [noteTool({ answerless: true, trailer: true }), brightenTool],
      history: [{ role: 'user', content: 'Brighten the chorus.' }, ...asHistory(first.run.stored)],
      turnId: 'turn-note-2',
    });
    const sent = requestsOf(next.run)[0].messages.filter((m) => !isStepTail(m as never));
    const inTurn = requestsOf(first.run)[1].messages.filter((m) => !isStepTail(m as never));
    const assistant = (r: typeof sent) => r.find((m) => m.role === 'assistant');
    expect(JSON.stringify(assistant(sent))).toBe(JSON.stringify(assistant(inTurn)));
    expect(JSON.stringify(sent)).not.toContain(TRAILER_CALL_ID_PREFIX);
    expect(toolNames(requestsOf(next.run)[0])).toEqual(['brighten_section']);
  });

  it('on a spoken turn: never spoken, and the rule against other tags excepts it', async () => {
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} ${TRAILER}`) }], {
      context: {
        currentPath: '/music/generate',
        timeZone: 'Europe/Paris',
        output: { mode: 'voice', voiceDirections: { engine: 'fixture-voice', tags: ['<laugh>'], guidance: 'Use them sparingly.' } },
      },
    });
    expect(tokens(run)).toBe(REPLY);
    expect(note.written).toEqual([NOTE]);
    const told = JSON.stringify(requestsOf(run)[0].messages);
    expect(told).toContain('Use no other tags (the note trailer excepted: it is never spoken). Use them sparingly.');
  });
});

describe('a trailer that cannot be read', () => {
  it('lets the reply stand and ends the turn: nothing written, the error stored for the next turn, and counted', async () => {
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY}\n<oui:note>{"kind":"decision","text": oops}</oui:note>`) }]);
    expect(run.requests).toHaveLength(1);
    expect(note.written).toEqual([]);
    expect(tokens(run)).toBe(REPLY);
    expect(run.recorded).toEqual({ rounds: 1, answerlessEnd: { tools: ['note'], trailer: true, trailers: 1, failedTrailers: 1 } });
    const [assistant, result] = run.stored;
    expect(assistant).toMatchObject({ role: 'assistant', content: REPLY, toolCalls: [{ name: 'note' }] });
    expect(isTrailerCallId(assistant.toolCalls![0].id)).toBe(true);
    expect(JSON.parse(result.content!)).toEqual({
      success: false,
      notRun: true,
      invalidInput: true,
      error:
        'Invalid input for tool note: the note trailer could not be read (its JSON could not be read), so no note was written. Write it again at the end of your reply.',
    });

    // The next turn reads that it failed, after the reply, and is not sent a call to a tool it does not declare.
    const next = await trailerTurn([{ text: [`Noted. ${TRAILER}`] }], { history: [{ role: 'user', content: 'Brighten.' }, ...asHistory(run.stored)], turnId: 'turn-note-2' });
    const sent = requestsOf(next.run)[0];
    expect(toolNames(sent)).toEqual([]);
    expect(sent.messages.find((m) => m.role === 'assistant')!.content).toBe(
      `${REPLY}\n\n<oui:note-failed>Invalid input for tool note: the note trailer could not be read (its JSON could not be read), so no note was written. Write it again at the end of your reply.</oui:note-failed>`,
    );
    expect(next.note.written).toEqual([NOTE]);
  });

  it('when it is not closed: the same, and none of it is shown', async () => {
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} <oui:note>{"kind":"decision","text":"cut off`) }]);
    expect(run.requests).toHaveLength(1);
    expect(tokens(run)).toBe(REPLY);
    expect(note.written).toEqual([]);
    expect(JSON.parse(run.stored[1].content!).error).toContain('it was not closed with </oui:note>');
  });

  it('when its input is not the tool’s schema: refused as any call is, and the reply stands', async () => {
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} <oui:note>{"kind":"decision","text":"x","colour":"red"}</oui:note>`) }]);
    expect(run.requests).toHaveLength(1);
    expect(note.written).toEqual([]);
    expect(run.recorded?.answerlessEnd).toEqual({ tools: ['note'], trailer: true, trailers: 1, failedTrailers: 1 });
    expect(JSON.parse(run.stored[1].content!)).toMatchObject({ success: false, invalidInput: true });
  });

  it('when its step does not take the tool: it says the tool is written, never called, and the reply stands', async () => {
    const onlyBrighten: TurnPolicy = {
      classifyTurn: () => 'normal',
      prepareStep: async () => ({ activeTools: ['brighten_section'] }),
    };
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} ${TRAILER}`) }], {
      tools: [noteTool({ answerless: true, trailer: true }), brightenTool],
      config: { turnPolicy: onlyBrighten },
    });
    expect(run.requests).toHaveLength(1);
    expect(tokens(run)).toBe(REPLY);
    expect(note.written).toEqual([]);
    // The step not offering it, its rule is not said.
    expect(systemOf(requestsOf(run)[0])).not.toContain('## NOTES');
    expect(JSON.parse(run.stored[1].content!)).toMatchObject({
      success: false,
      notRun: true,
      unavailable: true,
      error: expect.stringContaining('"note" is written as a trailer after your reply'),
    });
  });
});

describe('a trailer and the turn’s other rules', () => {
  it('a step held to the trailer tool is told to write it, and the provider is forced to nothing', async () => {
    const forced: TurnPolicy = { classifyTurn: () => 'normal', prepareStep: async () => ({ toolChoice: { type: 'tool', toolName: 'note' } }) };
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} ${TRAILER}`) }], {
      tools: [noteTool({ answerless: true, trailer: true }), brightenTool],
      config: { turnPolicy: forced },
    });
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    expect(note.written).toEqual([NOTE]);
    const sent = requestsOf(run)[0];
    expect(sent.tool_choice).toBeUndefined();
    expect(toolNames(sent)).toEqual([]);
    expect(JSON.stringify(sent.messages)).toContain('This step: write your reply, then a note after it, as <oui:note>{…}</oui:note>.');
  });

  it('a trailer a policy would ask approval of is refused, never asked for', async () => {
    const asks = {
      evaluate: async () => ({ action: 'require_approval' as const, reason: 'everything is approved here' }),
    };
    const { run, note } = await trailerTurn([{ text: pieces(`${REPLY} ${TRAILER}`) }], { config: { toolPolicy: asks } });
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    expect(note.written).toEqual([]);
    expect(run.events.some((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED)).toBe(false);
    expect(JSON.parse(run.stored[1].content!).error).toBe('"note" was written as a trailer, which is never asked for approval, so it was not run.');
  });

  it('stopped in the middle of a trailer: shows none of it, and writes no note', async () => {
    let hear: ((record: TurnStopRecord) => void) | null = null;
    const note = noteTool({ answerless: true, trailer: true });
    const provider = scriptedOpenAIWire([{ text: [`${REPLY} <oui:note>{"kind":"dec`, 'ision","text":"x"}</oui:note>'] }], {
      // After the first piece, the person presses Stop; the response never finishes.
      hold: async (_index, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        hear?.({ turnId: 'turn-note-1', by: 'user-1', reason: 'user_stop', at: Date.now() });
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    });
    const run = await noteTurn({ tools: [note], provider, stop: { fire: (h) => (hear = h) } });
    expect(run.outcome).toMatchObject({ status: 'stopped', stopReason: 'user_stop' });
    expect(note.written).toEqual([]);
    expect(tokens(run)).toBe(REPLY);
    expect(JSON.stringify(run.stored)).not.toContain('<oui:');
    expect(run.stored.some((m) => m.toolCalls?.some((c) => c.name === 'note'))).toBe(false);
  });

  it('a host that declares the same tool without trailer is sent its definition and no rule, as before', async () => {
    const run = await noteTurn({ tools: [noteTool({ answerless: true })], provider: scriptedOpenAIModel([{ text: REPLY, toolCalls: [NOTE_CALL] }]) });
    expect(toolNames(requestsOf(run)[0])).toEqual(['note']);
    expect(systemOf(requestsOf(run)[0])).not.toContain('## NOTES');
    expect(run.recorded).toEqual({ rounds: 1, answerlessEnd: { tools: ['note'] } });
  });
});
