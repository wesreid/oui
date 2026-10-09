/**
 * The PA on a page that offers hundreds of actions (ADR-0245).
 *
 * In the video editor with the vector studio docked, a tab's action
 * definitions weighed 604 KB: every answer was refused as larger than the
 * relay's 512 KB frame, and the definitions alone were about 154,000 tokens
 * for the model on every call (PA session 618701bb, 2026-10-02). Here the tab
 * is a real oui-spec runtime in index form, with that many actions and a
 * 90 KB effect catalogue, and the turn runs through the orchestrator:
 * - the model gets three UI tools and the page's index, whatever the page offers;
 * - an action's definition is fetched from the page when it is used, and its
 *   input is checked against it;
 * - a large definition is described in outline, and opened by path;
 * - nothing that changes the page runs while the page cannot be seen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import { jsonBytes, type JSONSchema, type OUIActionRequest, type OUIActionResult } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import type { TurnPolicy } from '../turn-policy.js';

// ─── Mock the `ai` module: the test plays the model ──────────────────────────

type Tool = { execute: (args: unknown, o: { toolCallId: string }) => Promise<string>; description: string; inputSchema: unknown };
type StreamOpts = {
  tools: Record<string, Tool>;
  messages: Array<{ role: string; content: unknown }>;
  prepareStep: (ctx: { steps: unknown[] }) => Promise<{ toolChoice?: unknown; activeTools?: string[]; instructions?: unknown }>;
};
let model: (opts: StreamOpts) => Promise<Array<{ text: string; toolCalls: Array<{ toolName: string; toolCallId: string; input?: unknown }> }>>;
let seenOpts: StreamOpts[];

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seenOpts.push(opts);
    const steps = model(opts);
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

beforeEach(() => {
  seenOpts = [];
});

// ─── The tab: a studio page, on a real oui-spec runtime in index form ────────

/** An effect catalogue as a room declares it: one member per effect, told apart by `effect`. */
function effectUnion(effects: number, paramsEach: number): JSONSchema {
  return {
    oneOf: Array.from({ length: effects }, (_, e) => ({
      type: 'object',
      title: `Effect ${e}`,
      required: ['effect', 'layerId'],
      additionalProperties: false,
      properties: {
        effect: { const: `effect-${e}` },
        layerId: { type: 'string', description: 'The layer the effect is added to.' },
        ...Object.fromEntries(
          Array.from({ length: paramsEach }, (_, p) => [
            `param_${p}`,
            { type: 'number', minimum: 0, maximum: 100, 'x-unit': 'px', description: `Parameter ${p} of effect ${e}: how far it reaches at the playhead.` },
          ]),
        ),
      },
    })),
  };
}

interface Studio {
  channel: UIActionChannel;
  /** The requests the tab was sent, as the wire carried them. */
  sent: OUIActionRequest[];
  /** Every answer the tab gave, as the wire carried it. */
  answers: OUIActionResult[];
  /** What the page's handlers were run with. */
  ran: Array<{ action: string; params: Record<string, unknown> }>;
  snapshot: () => unknown;
  /** Make the relay refuse answers that carry the page's state, as it did past its frame limit. */
  refuseState: (on: boolean) => void;
  /** Make the tab stop answering. */
  silence: (on: boolean) => void;
}

function studio(options: { actions?: number } = {}): Studio {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const ran: Studio['ran'] = [];
  const layers = Array.from({ length: 6 }, (_, i) => ({ id: `layer-${i}`, name: `Layer ${i}` }));
  const handler = (action: string) => async (params: Record<string, unknown>) => {
    ran.push({ action, params });
    if (action === 'studio_layer_add') layers.push({ id: `layer-${layers.length}`, name: String(params.name ?? 'New') });
    mounted.pushObservation('layers', [...layers]);
    return { success: true, data: { did: action } };
  };
  const room = defineSurface({
    id: 'room:studio',
    name: 'Studio',
    description: 'The editor, with the vector studio docked.',
    observations: [{ id: 'layers', description: 'The layers of the document.', schema: { type: 'array' } }],
    actions: [
      {
        id: 'studio_effect_add',
        title: 'Add an effect',
        description: 'Adds an effect to a layer. Each effect takes its own parameters.',
        effect: 'edit',
        input: effectUnion(60, 12),
        handler: handler('studio_effect_add'),
      },
      {
        id: 'studio_layer_add',
        title: 'Add a layer',
        description: 'Adds a layer on top of the stack.',
        effect: 'edit',
        input: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 80 } } },
        handler: handler('studio_layer_add'),
      },
      {
        id: 'studio_layers_query',
        title: 'Query layers',
        description: 'Lists the layers, by name.',
        effect: 'view',
        input: { type: 'object', additionalProperties: false, properties: { title_contains: { type: 'string' } } },
        handler: async (params) => {
          ran.push({ action: 'studio_layers_query', params });
          return { success: true, data: { rows: layers.map((l) => ({ ref: l.id, title: l.name })), total: layers.length } };
        },
      },
      ...Array.from({ length: options.actions ?? 424 }, (_, a) => ({
        id: `studio_action_${a}`,
        title: `Action ${a}`,
        description: `Sets property ${a} of the selection. It is one undo step.`,
        effect: 'edit' as const,
        input: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'number', minimum: 0, maximum: 1000, 'x-unit': 'px', description: `How far property ${a} reaches, measured from the layer's own origin.` },
            easing: { enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring'], description: 'How the change is eased when it is animated.' },
          },
        } as JSONSchema,
        handler: handler(`studio_action_${a}`),
      })),
    ],
  });
  const mounted = runtime.mount(room, () => ({}));
  mounted.pushObservation('layers', [...layers]);

  const sent: OUIActionRequest[] = [];
  const answers: OUIActionResult[] = [];
  let refuse = false;
  let silent = false;
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      sent.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => {
      if (silent) return null;
      let answer = await runtime.execute(sent.find((r) => r.requestId === requestId)!);
      // The relay's part: an answer it refuses comes back trimmed, saying why (oui-spec §7.3.6).
      if (refuse && answer.observations) {
        const { index: _index, observations: _observations, ...rest } = answer;
        answer = { ...rest, delivery: { trimmed: true, reason: 'payload larger than 524288 bytes', omitted: ['index', 'observations'] } };
      }
      answers.push(answer);
      return answer;
    },
  };
  return {
    channel,
    sent,
    answers,
    ran,
    snapshot: () => runtime.snapshot(),
    refuseState: (on) => void (refuse = on),
    silence: (on) => void (silent = on),
  };
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

function turn(page: Studio): AgentTurnInput {
  return {
    turnId: 'turn-index',
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:turn-index',
    content: 'add a glow to the title',
    history: [{ role: 'user', content: 'add a glow to the title' }],
    context: { currentPath: '/editor', oui: page.snapshot() },
  };
}

/** A model that makes the calls it is given, in order, and keeps each answer. */
function calls(script: Array<{ tool: string; args: unknown }>, saw: unknown[]) {
  return async (opts: StreamOpts) => {
    const toolCalls: Array<{ toolName: string; toolCallId: string; input?: unknown }> = [];
    for (const [i, call] of script.entries()) {
      saw.push(JSON.parse(await opts.tools[call.tool].execute(call.args, { toolCallId: `call-${i}` })));
      toolCalls.push({ toolName: call.tool, toolCallId: `call-${i}`, input: call.args });
    }
    return [{ text: 'done', toolCalls }];
  };
}
const act = (action: string, input?: Record<string, unknown>) => ({ tool: 'ui_act', args: { action, ...(input ? { input } : {}) } });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('what the model is given on a page of 427 actions', () => {
  it('is three UI tools and an index, small enough for any model, where the definitions were 600 KB', async () => {
    const page = studio();
    let tail = '';
    model = async (opts) => {
      const sent = (await opts.prepareStep({ steps: [], messages: opts.messages } as never)) as { messages?: Array<{ content: unknown }> };
      tail = ((sent.messages?.at(-1)?.content ?? []) as Array<{ text?: string }>).map((p) => p.text ?? '').join('\n');
      return [{ text: 'ok', toolCalls: [] }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    const { tools } = seenOpts[0];
    expect(Object.keys(tools).sort()).toEqual(['ui_act', 'ui_describe', 'ui_read']);
    // The index follows the system prompt; the page's values are read after the conversation.
    const message = String((seenOpts[0] as unknown as { instructions: Array<{ content: string }> }).instructions[1].content) + tail;
    expect(message).toContain('<page_index>');
    expect(message).toContain('<page_state>');
    expect(message).toContain('- studio_effect_add: Adds an effect to a layer. (takes one of 60 shapes by effect)');
    expect(message).toContain('- studio_layer_add: Adds a layer on top of the stack. (takes name: string)');
    expect(message).toContain('- studio_layers_query: Lists the layers, by name. (takes title_contains?: string; reads)');
    expect(message).toContain('- studio_action_423: ');
    expect(message).toContain('"layer-5"');

    // The turn's snapshot fits one queue message, and what the model reads of the page fits its context.
    expect(jsonBytes(page.snapshot())).toBeLessThan(256 * 1024);
    const forModel = JSON.stringify(tools).length + message.length;
    // Under 20,000 tokens at four characters a token (ADR-0245 §3.3), where the definitions were 154,000.
    expect(forModel / 4).toBeLessThan(20_000);
    expect(message).not.toContain('"properties"');
  });
});

describe('running an action from the index', () => {
  it('fetches the action’s definition from the page, checks the input against it, and runs it', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = calls([act('studio_layer_add', { name: 'Title' })], saw);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    // First the definition (the runtime's own `oui.describe`), then the action itself.
    expect(page.sent.map((r) => [r.surfaceId, r.actionId])).toEqual([
      ['oui', 'describe'],
      ['room:studio', 'studio_layer_add'],
    ]);
    expect(page.sent[0].params).toEqual({ actions: [{ surface: 'room:studio', action: 'studio_layer_add' }] });
    expect(page.sent[1]).toMatchObject({ requestId: 'call-0', params: { name: 'Title' } });
    expect(page.ran).toEqual([{ action: 'studio_layer_add', params: { name: 'Title' } }]);
    expect(saw[0]).toMatchObject({ result: { did: 'studio_layer_add' }, page: { surfaces: ['Studio'] } });
    // The answer is small: the page's index is not repeated, and no definition travels with it.
    expect(page.answers[1]).not.toHaveProperty('index');
    expect(jsonBytes(page.answers[1])).toBeLessThan(4 * 1024);
  });

  // oui-spec 0.8 halves an entry's hash and drops its `definitionBytes`. During a rollout the tab is
  // still on 0.7: the worker reads the hash only as a string to compare, so the older entry works as it is.
  it('takes an index from a tab on oui-spec 0.7: a 16-digit hash and a definitionBytes it ignores', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = calls([act('studio_layer_add', { name: 'Title' }), act('studio_layer_add', { name: 'Subtitle' })], saw);
    const input = turn(page);
    const snapshot = input.context!.oui as { index: Array<{ index: Array<Record<string, unknown>> }> };
    for (const surface of snapshot.index) {
      surface.index = surface.index.map((entry) => ({
        ...entry,
        definitionHash: `${String(entry.definitionHash)}${String(entry.definitionHash)}`,
        definitionBytes: 1234,
      }));
    }
    expect(snapshot.index[0].index[0].definitionHash).toMatch(/^[0-9a-f]{16}$/);

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), input);

    // The definition is fetched once and kept for the second call: the entry's hash, at either length, is its key.
    expect(page.sent.map((r) => [r.surfaceId, r.actionId])).toEqual([
      ['oui', 'describe'],
      ['room:studio', 'studio_layer_add'],
      ['room:studio', 'studio_layer_add'],
    ]);
    expect(page.ran.map((r) => r.params)).toEqual([{ name: 'Title' }, { name: 'Subtitle' }]);
    expect(saw.every((answer) => !('error' in answer))).toBe(true);
  });

  it('refuses an input the definition does not allow, saying what the action takes, and never sends it', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = calls([act('studio_layer_add', { title: 'Title' }), act('studio_layer_add', { name: 'Title' })], saw);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    expect(saw[0]).toMatchObject({ success: false, invalidInput: true });
    expect(String(saw[0].error)).toContain('Invalid input for "studio_layer_add"');
    expect(saw[0].takes).toEqual({ type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 80 } } });
    // Corrected from what the refusal said: one describe served both calls.
    expect(page.sent.map((r) => r.actionId)).toEqual(['describe', 'studio_layer_add']);
    expect(page.ran).toEqual([{ action: 'studio_layer_add', params: { name: 'Title' } }]);
  });

  it('describes a 90 KB catalogue in outline, opens one member by path, and runs the action with it', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    const glow = { effect: 'effect-7', layerId: 'layer-0', param_0: 12 };
    model = calls(
      [
        { tool: 'ui_describe', args: { actions: ['studio_effect_add'] } },
        { tool: 'ui_describe', args: { actions: ['studio_effect_add'], path: 'effect=effect-7' } },
        act('studio_effect_add', glow),
      ],
      saw,
    );
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    const [outlined, opened, ran] = saw as Array<{ actions: Array<Record<string, unknown>> } & Record<string, unknown>>;
    const outline = outlined.actions[0];
    expect(outline).toMatchObject({ action: 'studio_effect_add', title: 'Add an effect', description: 'Adds an effect to a layer. Each effect takes its own parameters.' });
    expect(String(outline.inputOutline)).toContain('one of 60 by effect');
    expect(String(outline.inputOutline)).toContain('- effect-7 — Effect 7');
    expect(JSON.stringify(outlined).length).toBeLessThan(6_000);
    const part = opened.actions[0].part as { properties: Record<string, Record<string, unknown>> };
    expect(part.properties.effect).toEqual({ const: 'effect-7' });
    expect(part.properties.param_0).toMatchObject({ type: 'number', 'x-unit': 'px', minimum: 0, maximum: 100 });
    expect(ran).toMatchObject({ result: { did: 'studio_effect_add' } });
    expect(page.ran).toEqual([{ action: 'studio_effect_add', params: glow }]);
    // The definition was fetched once, for both descriptions and the run.
    expect(page.sent.filter((r) => r.actionId === 'describe')).toHaveLength(1);
  });

  it('says so when the action is not on the page, without asking the page', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = calls([{ tool: 'ui_describe', args: { actions: ['studio_halftone'] } }], saw);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));
    expect(JSON.stringify(saw[0])).toContain('None of these is an action of the page as it is now: studio_halftone');
    expect(page.sent).toEqual([]);
  });
});

describe('reading the page', () => {
  it('ui_read returns a page of an observation’s rows from the tab', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = calls([{ tool: 'ui_read', args: { surface: 'room:studio', observation: 'layers', offset: 4, limit: 5 } }], saw);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));
    expect(saw[0]).toEqual({ rows: [{ id: 'layer-4', name: 'Layer 4' }, { id: 'layer-5', name: 'Layer 5' }], total: 6, offset: 4 });
    expect(page.sent[0]).toMatchObject({ surfaceId: 'oui', actionId: 'read' });
  });
});

describe('no changes while the page cannot be seen (session 618701bb)', () => {
  it('refuses a change after an answer without the page’s state, lets a read through, and then runs the change', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = async (opts) => {
      const run = async (id: string, call: { tool: string; args: unknown }) => JSON.parse(await opts.tools[call.tool].execute(call.args, { toolCallId: id }));
      // The relay refuses the first answer: it arrives without the page's state.
      page.refuseState(true);
      saw.push(await run('c1', act('studio_layer_add', { name: 'Title' })));
      // A second change, made blind: refused before it is sent.
      saw.push(await run('c2', act('studio_action_3', { value: 10 })));
      page.refuseState(false);
      // A read that only reads: it runs, and the page is seen again.
      saw.push(await run('c3', act('studio_layers_query', {})));
      saw.push(await run('c4', act('studio_action_3', { value: 10 })));
      return [{ text: 'done', toolCalls: [] }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    expect(String(saw[0].delivery)).toContain('You cannot see the page now');
    expect(saw[1]).toMatchObject({ notRun: true, blind: true });
    expect(String(saw[1].error)).toContain('Never change the page to find out what it shows');
    expect(saw[2]).toMatchObject({ result: { total: 7 } });
    expect(saw[3]).toMatchObject({ result: { did: 'studio_action_3' } });
    // The page ran one add, the query and one change: never the change made blind.
    expect(page.ran.map((r) => r.action)).toEqual(['studio_layer_add', 'studio_layers_query', 'studio_action_3']);
  });

  it('refuses a change called in the same response as the action whose answer blinded the turn', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = async (opts) => {
      page.refuseState(true);
      // Both calls arrive together, as a model makes them in one response: the
      // second is decided when its turn comes, after the first's answer.
      const [first, second] = await Promise.all([
        opts.tools.ui_act.execute({ action: 'studio_layer_add', input: { name: 'Badge' } }, { toolCallId: 'p1' }),
        opts.tools.ui_act.execute({ action: 'studio_action_3', input: { value: 10 } }, { toolCallId: 'p2' }),
      ]);
      saw.push(JSON.parse(first), JSON.parse(second));
      return [{ text: 'done', toolCalls: [] }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    expect(String(saw[0].delivery)).toContain('You cannot see the page now');
    expect(saw[1]).toMatchObject({ notRun: true, blind: true });
    expect(page.ran.map((r) => r.action)).toEqual(['studio_layer_add']);
    expect(page.sent.filter((r) => r.surfaceId !== 'oui').map((r) => r.actionId)).toEqual(['studio_layer_add']);
  });

  it('ends the turn’s UI work after two changes refused in a row, with the project unchanged', async () => {
    const page = studio();
    const saw: Array<Record<string, unknown>> = [];
    model = async (opts) => {
      const run = async (id: string, call: { tool: string; args: unknown }) => JSON.parse(await opts.tools[call.tool].execute(call.args, { toolCallId: id }));
      // The tab stops answering: the first action may have run, and nothing is known of the page.
      page.silence(true);
      saw.push(await run('c1', act('studio_action_1', { value: 1 })));
      saw.push(await run('c2', act('studio_action_2', { value: 2 })));
      saw.push(await run('c3', act('studio_action_3', { value: 3 })));
      saw.push(await run('c4', act('studio_action_4', { value: 4 })));
      return [{ text: 'I could not confirm it.', toolCalls: [] }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel), turn(page));

    expect(String(saw[0].error ?? JSON.stringify(saw[0]))).toMatch(/did not answer|not responding|answer did not arrive/);
    expect(saw[1]).toMatchObject({ notRun: true, blind: true });
    expect(saw[2]).toMatchObject({ notRun: true, blind: true });
    expect(saw[3]).toMatchObject({ notRun: true, uiStopped: true });
    expect(String(saw[3].error)).toContain('nothing more is changed in it this turn');
    // Only the first was ever sent to the page (for its definition and then itself); the rest never left the worker.
    expect(page.sent.filter((r) => r.surfaceId !== 'oui').map((r) => r.actionId)).toEqual([]);
  });
});

describe('a turn policy speaks of the page’s actions', () => {
  it('sees them among the tools, forces one through ui_act, and holds the step to it', async () => {
    const page = studio({ actions: 2 });
    const seen: { names: string[][]; steps: unknown[][] } = { names: [], steps: [] };
    const turnPolicy: TurnPolicy = {
      classifyTurn: () => 'tour',
      prepareStep: async ({ steps, allToolNames }) => {
        seen.names.push(allToolNames);
        seen.steps.push(steps);
        return steps.length === 0 ? { toolChoice: { type: 'tool', toolName: 'studio_layers_query' } } : {};
      },
    };
    const saw: Array<Record<string, unknown>> = [];
    let prepared: Awaited<ReturnType<StreamOpts['prepareStep']>> | undefined;
    model = async (opts) => {
      prepared = await opts.prepareStep({ steps: [], messages: [{ role: 'user', content: 'Add a layer' }] } as never);
      saw.push(JSON.parse(await opts.tools.ui_act.execute({ action: 'studio_layer_add', input: { name: 'x' } }, { toolCallId: 'p1' })));
      saw.push(JSON.parse(await opts.tools.ui_act.execute({ action: 'studio_layers_query', input: {} }, { toolCallId: 'p2' })));
      // The next step: the policy is shown the call as the action it ran.
      await opts.prepareStep({ steps: [{ toolCalls: [{ toolName: 'ui_act', input: { action: 'studio_layers_query', input: {} } }] }] });
      return [{ text: 'done', toolCalls: [{ toolName: 'ui_act', toolCallId: 'p2', input: { action: 'studio_layers_query', input: {} } }] }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(page.channel, { turnPolicy }), turn(page));

    expect(seen.names[0]).toEqual(expect.arrayContaining(['ui_act', 'ui_describe', 'ui_read', 'studio_layers_query', 'studio_layer_add']));
    expect(prepared!.toolChoice).toEqual({ type: 'tool', toolName: 'ui_act' });
    expect(JSON.stringify((prepared as { messages?: unknown[] }).messages?.at(-1))).toContain('call ui_act with action \\"studio_layers_query\\"');
    expect(String(saw[0].error)).toContain('This step runs "studio_layers_query" and nothing else');
    expect(saw[1]).toMatchObject({ result: { total: 6 } });
    expect(seen.steps[1]).toEqual([{ toolCalls: [{ toolName: 'studio_layers_query' }] }]);
    expect(page.ran.map((r) => r.action)).toEqual(['studio_layers_query']);
  });
});
