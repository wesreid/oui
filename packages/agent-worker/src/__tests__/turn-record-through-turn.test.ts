/**
 * Through a turn (ADR-0244 §2.2, §2.5, §2.7): a room's readers are not capped
 * like edits, the model is told again what did not succeed before every later
 * step, a refused call reaches the client with its arguments, and the rows an
 * action changed stay whole in the page state it answers with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';

type Instructions = unknown;
type StreamOpts = {
  temperature?: number;
  tools: Record<string, { execute: (args: unknown, o: { toolCallId: string }) => Promise<string> }>;
  instructions: Instructions;
  prepareStep: (o: { steps: unknown[]; messages?: unknown[] }) => Promise<{ instructions: Instructions; messages?: unknown[] }>;
};
let segmentImpls: Array<(opts: StreamOpts) => Promise<Array<{ text: string; toolCalls: Array<{ toolName: string; toolCallId: string }> }>>>;
let seenOpts: StreamOpts[];

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seenOpts.push(opts);
    const impl = segmentImpls[seenOpts.length - 1];
    if (!impl) throw new Error(`unexpected segment ${seenOpts.length}`);
    const steps = impl(opts);
    return {
      textStream: (async function* () {
        for (const s of await steps) if (s.text) yield s.text;
      })(),
      steps: steps.then((ss) => ss.map((s) => ({ ...s, usage: { inputTokens: 10 } }))),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: steps.then((ss) => ({ messages: ss.map((s) => ({ role: 'assistant', content: s.text })) })),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const layerId = (i: number) => `vector-layer-${String(i).padStart(3, '0')}`;

const documentSchema = {
  type: 'object',
  properties: {
    selection: { type: 'array', items: { type: 'string' } },
    layers: { type: 'array', 'x-rows': { ref: 'id', title: 'name', index: ['kind'], selection: 'selection' }, items: { type: 'object' } },
  },
};

const room: OUISurface = {
  id: 'room:vector-studio',
  name: 'Vector Studio',
  description: 'Vector artwork',
  actions: [
    { id: 'vector_studio_inspect', description: 'Reads rows', effect: 'view', input: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } }, required: ['refs'] } },
    { id: 'vector_studio_select', description: 'Selects', effect: 'selection', input: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
    { id: 'vector_studio_rename', description: 'Renames', effect: 'edit', input: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } },
  ],
  observations: [{ id: 'document', description: 'The artwork', schema: documentSchema }],
} as OUISurface;

const layers = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: layerId(i),
    name: 'Text',
    kind: 'text',
    box: [155.7, 153.2, 588.6, 193.6],
    text: 'TRAIDR',
    appearance: [{ id: 'fill', kind: 'fill', paint: { kind: 'solid', color: '#d0d0d0' } }],
    padding: 'x'.repeat(120),
  }));

function makeChannel(answer: (req: OUIActionRequest) => OUIActionResult) {
  const dispatched: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: vi.fn(async (_room, request) => void dispatched.push(request)),
    awaitResult: vi.fn(async (requestId) => answer(dispatched.find((d) => d.requestId === requestId)!)),
  };
  return { channel, dispatched };
}

function makeConfig(channel: UIActionChannel, more: Partial<AgentWorkerConfig> = {}) {
  const emit = vi.fn(async (..._args: unknown[]) => {});
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([]),
    emit: { emit },
    model: 'test-model',
    systemPrompt: 'test',
    ui: { channel, resultTimeoutMs: 1000 },
    ...more,
  };
  return { config, emit };
}

const input = (): AgentTurnInput => ({
  turnId: 'turn-w14',
  conversationId: 'conv',
  userId: 'user-1',
  accountId: 'acct',
  socketRoom: 'agent:turn:turn-w14',
  content: 'centre the text on Anim 03',
  history: [{ role: 'user', content: 'centre the text on Anim 03' }],
  context: { currentPath: '/vector/b1', oui: { surfaces: [room], observations: { [room.id]: { document: { selection: [], layers: layers(3) } } } } },
});

/** What a step was told for itself: the note after its conversation. */
const STEP_MESSAGES = [{ role: 'user', content: 'Check the layers.' }];
const stepNotes = (prepared: { messages?: unknown[] }) => {
  const last = (prepared.messages ?? []).at(-1) as { content?: Array<{ text?: string }> } | undefined;
  const text = Array.isArray(last?.content) ? (last!.content[0]?.text ?? '') : '';
  return text.startsWith('<step_note>') ? text : '';
};

beforeEach(() => {
  segmentImpls = [];
  seenOpts = [];
});

describe('a turn that reads, fails and edits', () => {
  it('lets a reader and an edit be called as often as the work needs, each with its own input', async () => {
    const { channel } = makeChannel((req) => ({ requestId: req.requestId, success: true, data: { items: [] }, timestamp: 1 }));
    const outputs: Record<string, string[]> = { inspect: [], select: [] };
    segmentImpls = [
      async (opts) => {
        for (let i = 0; i < 20; i++) {
          outputs.inspect.push(await opts.tools.ui_act.execute({ action: 'vector_studio_inspect', input: { refs: [layerId(i)] } }, { toolCallId: `i-${i}` }));
          outputs.select.push(await opts.tools.ui_act.execute({ action: 'vector_studio_select', input: { ids: [layerId(i)] } }, { toolCallId: `s-${i}` }));
        }
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel).config, input());
    expect(outputs.inspect.filter((o) => o.includes('quota'))).toHaveLength(0);
    // UI edits are not counted (session 24611234); only the same call with the same input again is refused.
    expect(outputs.select.filter((o) => o.includes('quota') || o.includes('repeatedCall'))).toHaveLength(0);
  });

  it('tells the model before each later step which calls did not succeed, and nothing while all have', async () => {
    const { channel } = makeChannel((req) =>
      req.actionId === 'vector_studio_select'
        ? { requestId: req.requestId, success: false, error: { code: 'NO_SUCH_LAYER', message: 'No layer or artboard with id "Anim 03"' }, timestamp: 1 }
        : { requestId: req.requestId, success: true, data: { items: [] }, timestamp: 1 },
    );
    const notes: string[] = [];
    segmentImpls = [
      async (opts) => {
        notes.push(stepNotes(await opts.prepareStep({ steps: [], messages: STEP_MESSAGES })));
        await opts.tools.ui_act.execute({ action: 'vector_studio_inspect', input: { refs: [layerId(0)] } }, { toolCallId: 'a' });
        notes.push(stepNotes(await opts.prepareStep({ steps: [], messages: STEP_MESSAGES })));
        await opts.tools.ui_act.execute({ action: 'vector_studio_select', input: { ids: ['Anim 03'] } }, { toolCallId: 'b' });
        notes.push(stepNotes(await opts.prepareStep({ steps: [], messages: STEP_MESSAGES })));
        return [{ text: 'Done.', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel).config, input());
    expect(notes[0]).not.toContain('<turn_record>');
    expect(notes[1]).not.toContain('<turn_record>');
    expect(notes[2]).toContain('<turn_record>');
    expect(notes[2]).toContain('This turn has made 2 calls; 1 did not succeed:');
    expect(notes[2]).toContain('- vector_studio_select: No layer or artboard with id "Anim 03"');
  });

  it('sends a call refused for its input to the client with the arguments the model gave, and records it', async () => {
    const { channel, dispatched } = makeChannel((req) => ({ requestId: req.requestId, success: true, timestamp: 1 }));
    const { config, emit } = makeConfig(channel);
    let refusal = '';
    let note = '';
    segmentImpls = [
      async (opts) => {
        refusal = await opts.tools.ui_act.execute({ action: 'vector_studio_rename', input: { id: layerId(0) } }, { toolCallId: 'bad' });
        note = stepNotes(await opts.prepareStep({ steps: [], messages: STEP_MESSAGES }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config, input());
    expect(refusal).toContain('Invalid input for \\"vector_studio_rename\\"');
    // It never reached the page.
    expect(dispatched).toEqual([]);
    const events = emit.mock.calls.map((c) => c[2] as { toolUseId?: string; input?: unknown; success?: boolean; result?: unknown }).filter((p) => p?.toolUseId === 'bad');
    expect(events).toHaveLength(2);
    expect(events[0].input).toEqual({ id: layerId(0) });
    expect(events[1]).toMatchObject({ success: false, result: { refused: true } });
    expect(note).toContain('- vector_studio_rename: Invalid input');
  });

  it('keeps the row an action changed whole in the page state, with the rest of a long list as index rows', async () => {
    const changed = layerId(41);
    const { channel } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      data: { id: changed, name: 'Wordmark', changed: [{ list: 'document/layers', ref: changed, detail: { id: changed, name: 'Wordmark' } }] },
      timestamp: 1,
      observations: { [room.id]: { document: { selection: [], layers: layers(60).map((l) => (l.id === changed ? { ...l, name: 'Wordmark' } : l)) } } },
    }));
    let answer = '';
    segmentImpls = [
      async (opts) => {
        answer = await opts.tools.ui_act.execute({ action: 'vector_studio_rename', input: { id: changed, name: 'Wordmark' } }, { toolCallId: 'r' });
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel).config, input());
    const state = (JSON.parse(answer) as { state: { values: Record<string, { document: { layers: Record<string, unknown>[] } }> } }).state;
    const rows = state.values[room.id].document.layers;
    expect(rows).toHaveLength(60);
    const row = rows.find((l) => l.id === changed)!;
    expect(row).toMatchObject({ name: 'Wordmark', box: [155.7, 153.2, 588.6, 193.6], text: 'TRAIDR' });
    const other = rows.find((l) => l.id === layerId(59))!;
    expect(Object.keys(other).sort()).toEqual(['id', 'kind', 'name']);
  });
});

describe('the sampling temperature', () => {
  const sent = async (more: Partial<AgentWorkerConfig>) => {
    const { channel } = makeChannel((req) => ({ requestId: req.requestId, success: true, timestamp: 1 }));
    segmentImpls = [async () => [{ text: 'ok', toolCalls: [] }]];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel, more).config, input());
    return seenOpts[0];
  };

  it('is 0.3 when the host sets none, and the host’s when it sets one', async () => {
    expect((await sent({})).temperature).toBe(0.3);
    seenOpts = [];
    expect((await sent({ temperature: 0.7 })).temperature).toBe(0.7);
  });

  it('is not sent at all when the host sets null, for a model that refuses a request naming one', async () => {
    expect(await sent({ temperature: null })).not.toHaveProperty('temperature');
  });
});
