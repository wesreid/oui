/**
 * The note trailer's parts, alone (tools/trailer.ts): the stream transform that
 * cuts trailers out of the model's text, the request a step sends, the calls
 * written back as trailers, the rule the model is taught, and which tools may
 * be trailers.
 */
import { describe, expect, it } from 'vitest';
import {
  asTrailers,
  assertTrailerTools,
  createTrailerStream,
  isTrailerCallId,
  MAX_TRAILER_CHARS,
  MAX_TRAILERS_PER_STEP,
  requestDigest,
  TRAILER_CALL_ID_PREFIX,
  trailerCallId,
  trailerExample,
  trailerParams,
  trailerRule,
  trailerToolProblem,
  type ReadTrailer,
  type StreamPartLike,
} from '../tools/trailer.js';
import { assertAgentRuntimeConfig } from '../runtime/config.js';
import { renderRule, offeredTools } from '../prompt/step-tools.js';
import type { RegisteredTool } from '../tools/types.js';

// ─── The stream ─────────────────────────────────────────────────────────────

const NOTE = '{"kind":"decision","text":"Chorus brighter."}';
const TRAILER = `<oui:note>${NOTE}</oui:note>`;
const FINISH: StreamPartLike = { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: {} };

/** A response's parts: its text in these deltas, in one block, then its finish. */
function response(deltas: string[], extra: { before?: StreamPartLike[]; finish?: StreamPartLike } = {}): StreamPartLike[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...(extra.before ?? []),
    { type: 'text-start', id: 't0' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't0', delta })),
    { type: 'text-end', id: 't0' },
    extra.finish ?? FINISH,
  ];
}

/** What the transform gives out for these parts, and the trailers it read. */
async function through(parts: StreamPartLike[], tools: string[] = ['note']): Promise<{ parts: StreamPartLike[]; read: ReadTrailer[] }> {
  const read: ReadTrailer[] = [];
  const source = new ReadableStream<StreamPartLike>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const out: StreamPartLike[] = [];
  const reader = source.pipeThrough(createTrailerStream<StreamPartLike>({ tools, callId: (i) => trailerCallId('digest', 0, i), onTrailer: (t) => read.push(t) })).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return { parts: out, read };
}

const textOf = (parts: StreamPartLike[]) =>
  parts
    .filter((p) => p.type === 'text-delta')
    .map((p) => p.delta)
    .join('');
const callsOf = (parts: StreamPartLike[]) => parts.filter((p) => p.type === 'tool-call').map((p) => ({ toolName: p.toolName, input: p.input, toolCallId: p.toolCallId }));

/** Every way the text can arrive: whole, cut once at each point, and one character at a time. */
function splits(text: string): string[][] {
  const out: string[][] = [[text], [...text]];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

describe('the stream transform', () => {
  const cases: Array<{ name: string; text: string; shown: string; calls: Array<{ toolName: string; input: string }> }> = [
    { name: 'a trailer after the reply', text: `I made it brighter.\n\n${TRAILER}`, shown: 'I made it brighter.', calls: [{ toolName: 'note', input: NOTE }] },
    { name: 'a trailer before the reply', text: `${TRAILER}\nI made it brighter.`, shown: 'I made it brighter.', calls: [{ toolName: 'note', input: NOTE }] },
    { name: 'a trailer in the middle', text: `First part. ${TRAILER} Second part.`, shown: 'First part. Second part.', calls: [{ toolName: 'note', input: NOTE }] },
    {
      name: 'several trailers',
      text: `Done. <oui:note>{"text":"a"}</oui:note>\n<oui:note>{"text":"b"}</oui:note>`,
      shown: 'Done.',
      calls: [
        { toolName: 'note', input: '{"text":"a"}' },
        { toolName: 'note', input: '{"text":"b"}' },
      ],
    },
    {
      name: 'a closer inside a JSON string',
      text: 'Done.<oui:note>{"text":"say </oui:note> to close"}</oui:note>',
      shown: 'Done.',
      calls: [{ toolName: 'note', input: '{"text":"say </oui:note> to close"}' }],
    },
    { name: 'no trailer', text: 'Just <b>bold</b> words, 2 < 3, and <oui:other>x</oui:other>.', shown: 'Just <b>bold</b> words, 2 < 3, and <oui:other>x</oui:other>.', calls: [] },
    { name: 'an opener that is not one', text: 'See <oui:not>, <oui and <oui:note too', shown: 'See <oui:not>, <oui and <oui:note too', calls: [] },
    { name: 'a voice tag', text: 'Ha <laugh> that is funny.', shown: 'Ha <laugh> that is funny.', calls: [] },
    { name: 'whitespace before and after', text: `Reply.   \n ${TRAILER}`, shown: 'Reply.', calls: [{ toolName: 'note', input: NOTE }] },
    { name: 'a doubled angle bracket', text: `Reply <${TRAILER}`, shown: 'Reply <', calls: [{ toolName: 'note', input: NOTE }] },
  ];

  for (const c of cases) {
    it(`${c.name}: the same text and calls however the text is cut`, async () => {
      for (const deltas of splits(c.text)) {
        const { parts } = await through(response(deltas));
        expect(textOf(parts), JSON.stringify(deltas)).toBe(c.shown);
        expect(
          callsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
          JSON.stringify(deltas),
        ).toEqual(c.calls);
      }
    });
  }

  it('gives out a response with no trailer as it came: every part, and the same text', async () => {
    // Deltas that end on no whitespace and hold no `<` come out exactly as they went in.
    const parts = response(['Plain', ' words,', ' nothing', ' else.']);
    expect((await through(parts)).parts).toEqual(parts);
    const withTools = response(['Look: <b>this</b>'], { before: [{ type: 'reasoning-start', id: 'r0' }, { type: 'reasoning-delta', id: 'r0', delta: '<oui:note>' }, { type: 'reasoning-end', id: 'r0' }] });
    expect((await through(withTools)).parts).toEqual(withTools);
    // Any others give the same text, whitespace held back until what follows it, and the same other parts.
    const spaced = response(['Plain ', 'words, ', '2 <', ' 3 ', 'and done.\n']);
    const out = (await through(spaced)).parts;
    expect(textOf(out)).toBe('Plain words, 2 < 3 and done.\n');
    expect(out.filter((p) => p.type !== 'text-delta')).toEqual(spaced.filter((p) => p.type !== 'text-delta'));
  });

  it('gives `<laugh>` out at its second character, and holds only what can begin an opener', async () => {
    const read: StreamPartLike[] = [];
    const ts = createTrailerStream<StreamPartLike>({ tools: ['note'], callId: (i) => `id${i}` });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const next = async () => {
      read.push((await reader.read()).value!);
    };
    void writer.write({ type: 'text-start', id: 'a' });
    void writer.write({ type: 'text-delta', id: 'a', delta: 'Ha <' });
    await next();
    await next();
    expect(read).toEqual([{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Ha' }]);
    void writer.write({ type: 'text-delta', id: 'a', delta: 'l' });
    await next();
    expect(read[2]).toEqual({ type: 'text-delta', id: 'a', delta: ' <l' });
    // What can still begin an opener is held, and given out the moment it cannot.
    void writer.write({ type: 'text-delta', id: 'a', delta: ' <oui:no' });
    const pending = reader.read();
    const nothing = await Promise.race([pending.then((r) => r.value), new Promise((resolve) => setTimeout(() => resolve('held'), 50))]);
    expect(nothing).toBe('held');
    void writer.write({ type: 'text-delta', id: 'a', delta: 'x' });
    expect((await pending).value).toEqual({ type: 'text-delta', id: 'a', delta: ' <oui:nox' });
  });

  it('leaves reasoning, raw and metadata parts untouched, in place', async () => {
    const reasoning: StreamPartLike[] = [
      { type: 'reasoning-start', id: 'r0', providerMetadata: { anthropic: { signature: 'sig' } } },
      { type: 'reasoning-delta', id: 'r0', delta: `I will write ${TRAILER} after.` },
      { type: 'reasoning-end', id: 'r0' },
      { type: 'raw', rawValue: { chunk: TRAILER } },
      { type: 'response-metadata', id: 'msg_1', modelId: 'fixture' },
    ];
    const { parts } = await through(response([`Reply.${TRAILER}`], { before: reasoning }));
    expect(parts.slice(1, 6)).toEqual(reasoning);
    expect(textOf(parts)).toBe('Reply.');
  });

  it('gives the calls out before the finish, and says tool-calls; a cut-off step still says length', async () => {
    const { parts } = await through(response([`Reply. ${TRAILER}`]));
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'text-start', 'text-delta', 'text-end', 'tool-call', 'finish']);
    expect(parts.at(-1)!.finishReason).toEqual({ unified: 'tool-calls', raw: 'end_turn' });
    const cut = await through(response([`Reply. ${TRAILER}`], { finish: { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage: {} } }));
    expect(cut.parts.at(-1)!.finishReason).toEqual({ unified: 'length', raw: 'max_tokens' });
    const none = await through(response(['Reply.']));
    expect(none.parts.at(-1)).toEqual(FINISH);
  });

  it('gives the calls out before the response’s own tool calls, in order', async () => {
    const own: StreamPartLike[] = [
      { type: 'tool-input-start', id: 'call_1', toolName: 'brighten' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'brighten', input: '{}' },
    ];
    const parts = [...response([`Reply. ${TRAILER}`]).slice(0, -1), ...own, FINISH];
    const out = (await through(parts)).parts;
    expect(out.map((p) => (p.type === 'tool-call' ? `call:${p.toolName}` : p.type))).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'call:note',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'call:brighten',
      'finish',
    ]);
  });

  it('keeps a block’s id on every part it gives out, and gives no block for one that is all trailer', async () => {
    const parts: StreamPartLike[] = [
      { type: 'text-start', id: 'a', providerMetadata: { p: { x: 1 } } },
      { type: 'text-delta', id: 'a', delta: 'One. <oui:no' },
      { type: 'text-delta', id: 'a', delta: `te>${NOTE}</oui:note> Two.` },
      { type: 'text-end', id: 'a' },
      { type: 'text-start', id: 'b' },
      { type: 'text-delta', id: 'b', delta: TRAILER },
      { type: 'text-end', id: 'b' },
      FINISH,
    ];
    const out = (await through(parts)).parts;
    expect(out.filter((p) => p.type.startsWith('text'))).toEqual([
      { type: 'text-start', id: 'a', providerMetadata: { p: { x: 1 } } },
      { type: 'text-delta', id: 'a', delta: 'One.' },
      { type: 'text-delta', id: 'a', delta: ' Two.' },
      { type: 'text-end', id: 'a' },
    ]);
    expect(callsOf(out)).toHaveLength(2);
  });

  it('reads a body that is not JSON as a trailer that could not be read, and shows none of it', async () => {
    const { parts, read } = await through(response(['Reply.<oui:note>{"text": oops}</oui:note> More.']));
    expect(textOf(parts)).toBe('Reply. More.');
    expect(read).toEqual([expect.objectContaining({ toolName: 'note', cause: 'its JSON could not be read' })]);
    // Its input is what no JSON reader takes, so `ai` answers it as a call that did not run.
    expect(() => JSON.parse(read[0].input)).toThrow();
  });

  it('reads a trailer still open at the end as one that could not be read, and shows none of it', async () => {
    for (const text of ['Reply. <oui:note>{"text":"cut', `Reply. <oui:note>${NOTE}`]) {
      const { parts, read } = await through(response([text]));
      expect(textOf(parts)).toBe('Reply.');
      expect(read).toEqual([expect.objectContaining({ cause: 'it was not closed with </oui:note>' })]);
    }
    // A partial opener at the end is text.
    expect(textOf((await through(response(['Reply. <oui:no']))).parts)).toBe('Reply. <oui:no');
  });

  it(`reads a trailer past ${MAX_TRAILER_CHARS} characters, or past ${MAX_TRAILERS_PER_STEP} in a response, as one that could not be read`, async () => {
    const long = `{"text":"${'x'.repeat(MAX_TRAILER_CHARS + 10)}"}`;
    const big = await through(response(['Reply.', `<oui:note>${long}</oui:note>`, ' After.']));
    expect(textOf(big.parts)).toBe('Reply. After.');
    expect(big.read).toEqual([expect.objectContaining({ cause: `longer than ${MAX_TRAILER_CHARS.toLocaleString('en-US')} characters` })]);
    const many = await through(response([`Reply.${Array.from({ length: MAX_TRAILERS_PER_STEP + 2 }, (_, i) => `<oui:note>{"text":"${i}"}</oui:note>`).join('')}`]));
    expect(textOf(many.parts)).toBe('Reply.');
    expect(many.read.map((t) => t.cause ?? null)).toEqual([
      ...Array.from({ length: MAX_TRAILERS_PER_STEP }, () => null),
      `more than ${MAX_TRAILERS_PER_STEP} in one response`,
      `more than ${MAX_TRAILERS_PER_STEP} in one response`,
    ]);
  });

  it('names each call by the step, its place and the request, never the turn', async () => {
    const { read } = await through(response([`${TRAILER}${TRAILER}`]));
    expect(read.map((t) => t.toolCallId)).toEqual([`${TRAILER_CALL_ID_PREFIX}digest_0_0`, `${TRAILER_CALL_ID_PREFIX}digest_0_1`]);
    expect(isTrailerCallId(read[0].toolCallId)).toBe(true);
    expect(isTrailerCallId('toolu_01')).toBe(false);
    expect(requestDigest([{ role: 'user', content: 'a' }])).toBe(requestDigest([{ role: 'user', content: 'a' }]));
    expect(requestDigest([{ role: 'user', content: 'a' }])).not.toBe(requestDigest([{ role: 'user', content: 'b' }]));
    expect(requestDigest([])).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reads the trailers of several trailer tools', async () => {
    const { read } = await through(response([`Reply.<oui:note>{"a":1}</oui:note><oui:task-list>{"b":2}</oui:task-list>`]), ['note', 'task-list']);
    expect(read.map((t) => [t.toolName, t.input])).toEqual([
      ['note', '{"a":1}'],
      ['task-list', '{"b":2}'],
    ]);
  });
});

// ─── The request a step sends ───────────────────────────────────────────────

const fn = (name: string) => ({ type: 'function', name, description: name, inputSchema: { type: 'object' } });

describe('trailerParams: the request a step sends', () => {
  const userOnly = [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }];

  it('leaves out only the trailer tools’ definitions', () => {
    const sent = trailerParams({ prompt: userOnly, tools: [fn('brighten'), fn('note'), { type: 'provider', id: 'x.y', name: 'note' }] }, ['note']);
    expect(sent.tools).toEqual([fn('brighten'), { type: 'provider', id: 'x.y', name: 'note' }]);
    expect(sent.prompt).toEqual(userOnly);
    const alone = trailerParams({ prompt: userOnly, tools: [fn('note')] }, ['note']);
    expect(alone.tools).toEqual([]);
  });

  it('sends a choice that forces a trailer tool as auto, and leaves any other choice as it is', () => {
    expect(trailerParams({ prompt: userOnly, tools: [fn('note'), fn('b')], toolChoice: { type: 'tool', toolName: 'note' } }, ['note']).toolChoice).toEqual({ type: 'auto' });
    expect(trailerParams({ prompt: userOnly, tools: [fn('note'), fn('b')], toolChoice: { type: 'tool', toolName: 'b' } }, ['note']).toolChoice).toEqual({ type: 'tool', toolName: 'b' });
    expect(trailerParams({ prompt: userOnly, tools: [fn('note'), fn('b')], toolChoice: { type: 'required' } }, ['note']).toolChoice).toEqual({ type: 'required' });
  });

  it('writes the prompt’s trailer calls back as trailers: no call names a tool the request leaves out', () => {
    const prompt = [
      ...userOnly,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Brighter now.' },
          { type: 'tool-call', toolCallId: 'oui_trailer_d_0_0', toolName: 'note', input: { text: 'b', kind: 'decision' } },
          { type: 'tool-call', toolCallId: 'call_b', toolName: 'b', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'oui_trailer_d_0_0', toolName: 'note', output: { type: 'text', value: '{"id":"n1"}' } },
          { type: 'tool-result', toolCallId: 'call_b', toolName: 'b', output: { type: 'text', value: '{"ok":true}' } },
        ],
      },
    ];
    const sent = trailerParams({ prompt, tools: [fn('note'), fn('b')] }, ['note']);
    expect(sent.tools).toEqual([fn('b')]);
    expect(JSON.stringify(sent.prompt)).not.toContain('"toolName":"note"');
    expect(sent.prompt[2]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Brighter now.\n\n<oui:note>{"kind":"decision","text":"b"}</oui:note>' },
        { type: 'tool-call', toolCallId: 'call_b', toolName: 'b', input: {} },
      ],
    });
  });

  it('keeps the definition when the trailer tools are the only tools and the prompt holds other calls (Bedrock and Anthropic need one)', () => {
    const prompt = [
      ...userOnly,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_old', toolName: 'ui_act', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_old', toolName: 'ui_act', output: { type: 'text', value: '{}' } }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ];
    expect(trailerParams({ prompt, tools: [fn('note')] }, ['note']).tools).toEqual([fn('note')]);
    // With another tool declared, the request has tools: the trailer's definition is left out.
    expect(trailerParams({ prompt, tools: [fn('note'), fn('b')] }, ['note']).tools).toEqual([fn('b')]);
  });

  it('keeps the definition while the prompt still holds a trailer call it keeps (a response that wrote only a trailer, at the end)', () => {
    const prompt = [
      ...userOnly,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'oui_trailer_d_0_0', toolName: 'note', input: { text: 'b' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'oui_trailer_d_0_0', toolName: 'note', output: { type: 'text', value: '{"id":"n1"}' } }] },
    ];
    const sent = trailerParams({ prompt, tools: [fn('note'), fn('b')] }, ['note']);
    expect(sent.tools).toEqual([fn('note'), fn('b')]);
    expect(sent.prompt).toEqual(prompt);
  });
});

// ─── Calls written back as trailers ─────────────────────────────────────────

type Msg = { role: string; content: unknown };
const call = (id: string, input: unknown, toolName = 'note') => ({ type: 'tool-call', toolCallId: id, toolName, input });
const result = (id: string, value: string, type = 'text', toolName = 'note') => ({ type: 'tool-result', toolCallId: id, toolName, output: { type, value } });

describe('asTrailers: calls written back as the trailers they were', () => {
  const history: Msg[] = [
    { role: 'user', content: 'Brighten the chorus.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }, call('t1', { text: 'Chorus brighter.', kind: 'decision' }), call('t2', { kind: 'task', text: 'Master it.' })] },
    { role: 'tool', content: [result('t1', '{"id":"n1"}')] },
    { role: 'tool', content: [result('t2', '{"id":"n2"}')] },
    { role: 'user', content: 'Thanks.' },
  ];

  it('writes each call that wrote its note as canonical JSON after the text, one per line, and takes its result out', () => {
    expect(asTrailers(history, ['note'])).toEqual([
      history[0],
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Done.\n\n<oui:note>{"kind":"decision","text":"Chorus brighter."}</oui:note>\n<oui:note>{"kind":"task","text":"Master it."}</oui:note>',
          },
        ],
      },
      history[4],
    ]);
  });

  it('is deterministic and idempotent, and leaves messages it does not change as they were', () => {
    const once = asTrailers(history, ['note']);
    expect(JSON.stringify(asTrailers(history, ['note']))).toBe(JSON.stringify(once));
    expect(asTrailers(once, ['note'])).toEqual(once);
    expect(once[0]).toBe(history[0]);
    expect(asTrailers(history, [])).toBe(history);
    expect(asTrailers(history, ['other'])).toEqual(history);
  });

  it('writes a call that wrote nothing as what it failed with, so the model writes it again', () => {
    const failed: Msg[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }, call('t1', '<oui:note>{bad')] },
      {
        role: 'tool',
        content: [result('t1', JSON.stringify({ success: false, notRun: true, invalidInput: true, error: 'Invalid input for tool note: the note trailer could not be read (its JSON could not be read), so no note was written. Write it again at the end of your reply.' }), 'error-text')],
      },
      { role: 'user', content: 'Next.' },
    ];
    expect(asTrailers(failed, ['note'])[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Done.\n\n<oui:note-failed>Invalid input for tool note: the note trailer could not be read (its JSON could not be read), so no note was written. Write it again at the end of your reply.</oui:note-failed>',
        },
      ],
    });
    // The same row read back as a stored result (text, not error-text) is written the same way.
    const stored = [failed[0], { role: 'tool', content: [{ ...(failed[1].content as Array<Record<string, unknown>>)[0], output: { type: 'text', value: ((failed[1].content as Array<{ output: { value: string } }>)[0]).output.value } }] }, failed[2]];
    expect(asTrailers(stored, ['note'])).toEqual(asTrailers(failed, ['note']));
    for (const failure of ['"NO_CONVERSATION: none"', '{"error":"NO_SUCH_NOTE: x"}', '{"success":false,"notRun":true,"error":"refused"}']) {
      const out = asTrailers([failed[0], { role: 'tool', content: [result('t1', failure)] }, failed[2]], ['note']);
      expect((out[0].content as Array<{ text: string }>)[0].text).toMatch(/^Done\.\n\n<oui:note-failed>.+<\/oui:note-failed>$/);
    }
  });

  it('keeps the calls of a message that wrote only trailers when nothing but their results follows it', () => {
    const alone: Msg[] = [
      { role: 'user', content: 'Brighten.' },
      { role: 'assistant', content: [call('t1', { text: 'x' })] },
      { role: 'tool', content: [result('t1', '{"id":"n1"}')] },
    ];
    expect(asTrailers(alone, ['note'])).toEqual(alone);
    // Followed by more of the conversation, it is written back: its trailer is its text.
    const followed = [...alone, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }];
    expect(asTrailers(followed, ['note'])).toEqual([
      alone[0],
      { role: 'assistant', content: [{ type: 'text', text: '<oui:note>{"text":"x"}</oui:note>' }] },
      followed[3],
    ]);
  });

  it('puts the trailers of a message with no words after its reasoning, and keeps its other calls and their results', () => {
    const reasoned: Msg[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Think.', providerOptions: { anthropic: { signature: 's' } } }, call('t1', { text: 'x' }), call('c1', {}, 'brighten')],
      },
      { role: 'tool', content: [result('t1', '{"id":"n1"}'), result('c1', '{"ok":true}', 'text', 'brighten')] },
    ];
    expect(asTrailers(reasoned, ['note'])).toEqual([
      {
        role: 'assistant',
        content: [reasoned[0].content && (reasoned[0].content as unknown[])[0], { type: 'text', text: '<oui:note>{"text":"x"}</oui:note>' }, call('c1', {}, 'brighten')],
      },
      { role: 'tool', content: [result('c1', '{"ok":true}', 'text', 'brighten')] },
    ]);
  });

  it('keeps a call with no result', () => {
    const open: Msg[] = [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }, call('t1', { text: 'x' })] }, { role: 'user', content: 'Next.' }];
    expect(asTrailers(open, ['note'])).toEqual(open);
  });
});

// ─── The rule ───────────────────────────────────────────────────────────────

const noteDecl = (extra: Partial<RegisteredTool> = {}): RegisteredTool => ({
  name: 'note',
  effect: 'edit',
  answerless: true,
  trailer: true,
  description: 'Write one line in this chat’s notes.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['decision', 'task'], description: 'What the note is.' },
      text: { type: 'string', description: 'One line.' },
      where: { type: 'string' },
    },
  },
  execute: async () => ({ success: true, data: {} }),
  ...extra,
});

describe('the rule a step is taught', () => {
  it('is generated from the tool’s own description and schema, for a step that offers it', () => {
    const rule = trailerRule(noteDecl());
    expect(renderRule(rule, offeredTools(['note']))).toBe(
      '\n\n## NOTES: `note`\n' +
        'Write one line in this chat’s notes.\n' +
        '`note` is not a tool you call: write each note inside your response, after your reply, as `<oui:note>{"kind":"decision","text":"…"}</oui:note>`, one per note, ' +
        'a JSON object with: `kind` (one of "decision", "task"): What the note is.; `text` (text): One line.; `where` (text). At most 5 in a response, each under 4,096 characters.\n' +
        'Write it in the response that writes the reply it belongs to, never instead of a reply. It is removed before anything is shown or spoken, so write it on a spoken turn too. ' +
        'A note that could not be written shows after its reply as `<oui:note-failed>why</oui:note-failed>`: write it again, correctly, in your next reply.',
    );
    expect(renderRule(rule, offeredTools(['other']))).toBe('');
  });

  it('shows the required fields in its example when the schema has any', () => {
    const tool = noteDecl({ name: 'bookmark', inputSchema: { type: 'object', required: ['url'], properties: { label: { type: 'string' }, url: { type: 'string' }, count: { type: 'integer', minimum: 1 } } } });
    expect(trailerExample(tool)).toBe('{"url":"…"}');
    expect(renderRule(trailerRule(tool), offeredTools(['bookmark']))).toContain('`bookmark` is not a tool you call');
    expect(renderRule(trailerRule(tool), offeredTools(['bookmark']))).toContain('`url` (text, required)');
    expect(renderRule(trailerRule(tool), offeredTools(['bookmark']))).toContain('`count` (a whole number)');
  });
});

// ─── Which tools may be trailers ────────────────────────────────────────────

describe('which tools may be trailers', () => {
  const model = { specificationVersion: 'v4', provider: 'fixture', modelId: 'fixture' };

  it('accepts an answerless, non-destructive tool of an effect up to edit, with an object schema', () => {
    for (const effect of ['view', 'selection', 'navigate', 'open', 'edit'] as const) expect(trailerToolProblem(noteDecl({ effect }))).toBeNull();
    expect(() => assertTrailerTools([noteDecl()], model)).not.toThrow();
    expect(trailerToolProblem(noteDecl({ trailer: false, answerless: false }))).toBeNull();
  });

  it.each([
    ['without answerless', { answerless: false }, 'a trailer tool is answerless'],
    ['with a schema that is not an object', { inputSchema: { type: 'string' } }, 'its input schema is an object schema'],
    ['with a name its tags cannot be written with', { name: 'notes.write' }, 'its name must match'],
    ['with a name too long', { name: `n${'x'.repeat(41)}` }, 'its name must match'],
    ['with an effect beyond edit', { effect: 'mutate' as const }, 'its effect is at most "edit", not "mutate"'],
    ['with a job effect', { effect: { kind: 'job' as const } }, 'not "job"'],
    ['that needs approval', { effect: 'transaction' as const }, 'not "transaction"'],
    ['that is destructive', { destructive: true }, 'a destructive tool is never a trailer'],
    ['that declares no effect', { effect: undefined }, 'it declares its effect'],
    ['that is a UI action', { kind: 'ui' as const }, 'a UI action is never a trailer'],
  ])('refuses one %s', (_what, extra, problem) => {
    expect(trailerToolProblem(noteDecl(extra as Partial<RegisteredTool>))).toContain(problem);
    expect(() => assertTrailerTools([noteDecl(extra as Partial<RegisteredTool>)], model)).toThrow(/^\[agent-sdk\] A trailer tool cannot be one: "/);
  });

  it('refuses a trailer with a model named by its id, which is not wrapped', () => {
    expect(() => assertTrailerTools([noteDecl()], 'anthropic/claude-fixture')).toThrow('"note" is a trailer, which need a model object');
    expect(() => assertTrailerTools([noteDecl({ trailer: false })], 'anthropic/claude-fixture')).not.toThrow();
  });

  it('is refused when the adapter is created, for a list of tools', () => {
    const config = {
      model,
      realtime: { url: 'http://127.0.0.1:9', apiKey: 'key' },
      systemPrompt: () => 'You help.',
      getDb: async () => ({}),
      getHistory: async () => [],
      persistMessages: async () => {},
    };
    expect(() => assertAgentRuntimeConfig({ ...config, tools: [noteDecl({ answerless: false })] } as never)).toThrow('A trailer tool cannot be one');
    expect(() => assertAgentRuntimeConfig({ ...config, model: 'id', tools: [noteDecl()] } as never)).toThrow('need a model object');
    expect(() => assertAgentRuntimeConfig({ ...config, tools: [noteDecl()] } as never)).not.toThrow();
  });
});
