/**
 * The note trailer on each provider's own wire: Bedrock ConverseStream,
 * Anthropic Messages and OpenAI Chat Completions, each through its real `ai`
 * provider package, which builds the request it would send a live model and
 * parses the response as it would a live one.
 *
 * A request never names a tool it does not declare: a turn that goes on after
 * a trailer (it was written beside another call) sends no tool use and no
 * tool result of the trailer tool, written or failed, and does not declare
 * it. The one case a definition is still sent is proven here too: a request
 * whose only tools are trailer tools and whose prompt holds other calls.
 * Bedrock drops every call and result from a request that declares no tool,
 * and Anthropic refuses one, so the definition stays and the calls are sent.
 */
import { describe, expect, it } from 'vitest';
import { asHistory, BRIGHTEN_CALL, brightenTool, noteTool, noteTurn, type ScriptedProvider } from './support/note-turn.js';
import { scriptedAnthropic, scriptedBedrock, scriptedOpenAIWire, type WireReply } from './support/provider-wire.js';
import { TRAILER_CALL_ID_PREFIX } from '../tools/trailer.js';
import type { TurnHistoryMessage } from '../types.js';

const TRAILER = '<oui:note>{"kind":"decision","text":"Chorus brighter."}</oui:note>';
const BAD_TRAILER = '<oui:note>{"kind":"decision","text": nope}</oui:note>';

/** What each provider's request says, read the same way: its tools, and every call and result its messages hold. */
interface Read {
  tools: string[];
  calls: string[];
  results: string[];
  assistantText: string[];
}

const providers: Array<{ name: string; make: (replies: WireReply[]) => ScriptedProvider; read: (body: unknown) => Read }> = [
  {
    name: 'bedrock',
    make: scriptedBedrock,
    read: (body) => {
      const b = body as {
        toolConfig?: { tools?: Array<{ toolSpec?: { name: string } }> };
        messages: Array<{ role: string; content: Array<{ text?: string; toolUse?: { name: string; toolUseId: string }; toolResult?: { toolUseId: string } }> }>;
      };
      const parts = b.messages.flatMap((m) => m.content.map((c) => ({ role: m.role, ...c })));
      return {
        tools: (b.toolConfig?.tools ?? []).map((t) => t.toolSpec?.name ?? '?'),
        calls: parts.filter((p) => p.toolUse).map((p) => `${p.toolUse!.name}:${p.toolUse!.toolUseId}`),
        results: parts.filter((p) => p.toolResult).map((p) => p.toolResult!.toolUseId),
        assistantText: parts.filter((p) => p.role === 'assistant' && typeof p.text === 'string').map((p) => p.text!),
      };
    },
  },
  {
    name: 'anthropic',
    make: scriptedAnthropic,
    read: (body) => {
      const b = body as {
        tools?: Array<{ name: string }>;
        messages: Array<{ role: string; content: Array<{ type: string; text?: string; name?: string; id?: string; tool_use_id?: string }> | string }>;
      };
      const parts = b.messages.flatMap((m) => (typeof m.content === 'string' ? [{ role: m.role, type: 'text', text: m.content }] : m.content.map((c) => ({ role: m.role, ...c }))));
      return {
        tools: (b.tools ?? []).map((t) => t.name),
        calls: parts.filter((p) => p.type === 'tool_use').map((p) => `${p.name}:${p.id}`),
        results: parts.filter((p) => p.type === 'tool_result').map((p) => p.tool_use_id!),
        assistantText: parts.filter((p) => p.role === 'assistant' && p.type === 'text').map((p) => p.text!),
      };
    },
  },
  {
    name: 'openai',
    make: (replies) => scriptedOpenAIWire(replies),
    read: (body) => {
      const b = body as {
        tools?: Array<{ function: { name: string } }>;
        messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string }>;
      };
      return {
        tools: (b.tools ?? []).map((t) => t.function.name),
        calls: b.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => `${c.function.name}:${c.id}`)),
        results: b.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id!),
        assistantText: b.messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string').map((m) => m.content as string),
      };
    },
  },
];

describe.each(providers)('on $name', ({ make, read }) => {
  it('a turn that goes on after a trailer sends no use, result or definition of the trailer tool', async () => {
    const note = noteTool({ answerless: true, trailer: true });
    const provider = make([{ text: ['Brightening the chorus. <oui:no', TRAILER.slice('<oui:no'.length)], toolCalls: [BRIGHTEN_CALL] }, { text: ['Done: the chorus is brighter.'] }]);
    const run = await noteTurn({ tools: [note, brightenTool], provider });
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 2 });
    expect(note.written).toEqual([{ kind: 'decision', text: 'Chorus brighter.' }]);
    const [first, second] = provider.requests.map(read);
    expect(first.tools).toEqual(['brighten_section']);
    expect(second.tools).toEqual(['brighten_section']);
    expect(second.calls).toEqual([`brighten_section:${BRIGHTEN_CALL.id}`]);
    expect(second.results).toEqual([BRIGHTEN_CALL.id]);
    expect(JSON.stringify(provider.requests[1])).not.toContain(TRAILER_CALL_ID_PREFIX);
    expect(second.assistantText).toEqual([`Brightening the chorus.\n\n${TRAILER}`]);
  });

  it('a trailer that could not be read, beside another call: the next step reads why, and no use of the trailer tool', async () => {
    const note = noteTool({ answerless: true, trailer: true });
    const provider = make([{ text: [`Brightening the chorus. ${BAD_TRAILER}`], toolCalls: [BRIGHTEN_CALL] }, { text: ['Done.'] }]);
    const run = await noteTurn({ tools: [note, brightenTool], provider });
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 2 });
    expect(note.written).toEqual([]);
    const second = read(provider.requests[1]);
    expect(second.tools).toEqual(['brighten_section']);
    expect(second.calls).toEqual([`brighten_section:${BRIGHTEN_CALL.id}`]);
    expect(second.assistantText).toEqual([
      'Brightening the chorus.\n\n<oui:note-failed>Invalid input for tool note: the note trailer could not be read (its JSON could not be read), so no note was written. Write it again at the end of your reply.</oui:note-failed>',
    ]);
  });

  it('the next turn reads stored trailers back as text, and declares only the tools it has', async () => {
    const first = await noteTurn({ tools: [noteTool({ answerless: true, trailer: true }), brightenTool], provider: make([{ text: [`Brightening. ${TRAILER}`], toolCalls: [BRIGHTEN_CALL] }, { text: ['Done.'] }]) });
    const provider = make([{ text: ['The verse is as it was.'] }]);
    await noteTurn({
      tools: [noteTool({ answerless: true, trailer: true }), brightenTool],
      provider,
      history: [{ role: 'user', content: 'Brighten the chorus.' }, ...asHistory(first.stored)],
      turnId: 'turn-note-2',
    });
    const sent = read(provider.requests[0]);
    expect(sent.tools).toEqual(['brighten_section']);
    expect(sent.calls).toEqual([`brighten_section:${BRIGHTEN_CALL.id}`]);
    expect(sent.results).toEqual([BRIGHTEN_CALL.id]);
    expect(sent.assistantText[0]).toBe(`Brightening.\n\n${TRAILER}`);
  });

  it('a request whose only tool is a trailer tool, with other calls in its prompt, keeps the definition and the calls', async () => {
    // An earlier turn called a tool this turn does not have.
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Brighten the chorus.' },
      { role: 'assistant', content: 'Brightening.', tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'brighten_section', arguments: '{"section":"chorus"}' } }] },
      { role: 'tool', content: '{"brightness":"+3 dB"}', tool_call_id: 'call_old', name: 'brighten_section' },
      { role: 'assistant', content: 'Done.' },
    ];
    const provider = make([{ text: [`Noted. ${TRAILER}`] }]);
    const run = await noteTurn({ tools: [noteTool({ answerless: true, trailer: true })], provider, history });
    expect(run.outcome).toMatchObject({ status: 'completed', rounds: 1 });
    const sent = read(provider.requests[0]);
    expect(sent.tools).toEqual(['note']);
    expect(sent.calls).toEqual(['brighten_section:call_old']);
    expect(sent.results).toEqual(['call_old']);
  });
});

describe('why a definition is kept on Bedrock', () => {
  it('Bedrock drops every call and result from a request that declares no tool', async () => {
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Brighten the chorus.' },
      { role: 'assistant', content: 'Brightening.', tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'brighten_section', arguments: '{}' } }] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_old', name: 'brighten_section' },
      { role: 'assistant', content: 'Done.' },
    ];
    const provider = scriptedBedrock([{ text: ['Hello.'] }]);
    await noteTurn({ tools: [], provider, history });
    const sent = providers[0].read(provider.requests[0]);
    expect(sent.tools).toEqual([]);
    expect(sent.calls).toEqual([]);
    expect(sent.results).toEqual([]);
  });
});
