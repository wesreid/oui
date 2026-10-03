/**
 * A picture in an action's answer reaches the model as a picture (ADR-0244
 * §2.2, ADR-0245 §2.4).
 *
 * A room's snapshot reader answers with `data.image`: an encoded picture, up
 * to 200 KB of base64. Stringified into the tool result it would be about
 * 270,000 characters the model cannot see anything in. The worker lifts it
 * out: the model gets an image part beside the result's text, and the base64
 * is in no event, no record and no stored message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { liftAnswerImage, MAX_ANSWER_IMAGE_BASE64_CHARS } from '../ui/answer-image.js';

// ─── Mock the `ai` module: the test plays the model ──────────────────────────

type ModelOutput = { type: string; value: unknown };
type Tool = {
  execute: (args: unknown, o: { toolCallId: string }) => Promise<string>;
  toModelOutput: (o: { toolCallId: string; input: unknown; output: unknown }) => ModelOutput;
};
type StreamOpts = { tools: Record<string, Tool> };
type Step = { text: string; toolCalls: Array<{ toolName: string; toolCallId: string; input?: unknown }> };
let model: (opts: StreamOpts) => Promise<Step[]>;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
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

const { runAgentTurn } = await import('../orchestrator.js');

/** A picture's base64, of a given length: valid, and unmistakable in any text it leaks into. */
const picture = (chars: number) => 'iVBORw0KGgo'.padEnd(chars - (chars % 4), 'A');

describe('liftAnswerImage', () => {
  it('lifts data.image out, and leaves what the picture is', () => {
    const base64 = picture(4_000);
    const { data, image } = liftAnswerImage({ image: { mediaType: 'image/png', base64, width: 640, height: 360 }, artboardId: 'ab-1', time: 2.5 });
    expect(image).toEqual({ mediaType: 'image/png', base64 });
    expect(data).toEqual({
      image: { mediaType: 'image/png', width: 640, height: 360, shown: 'The picture is attached to this result: look at it.' },
      artboardId: 'ab-1',
      time: 2.5,
    });
    expect(JSON.stringify(data)).not.toContain('iVBORw0KGgo');
  });

  it('leaves anything that is not a picture as it is', () => {
    for (const data of [undefined, null, 'text', [1], { image: 'logo.png' }, { image: { url: 'https://x/y.png' } }, { rows: [] }]) {
      expect(liftAnswerImage(data)).toEqual({ data });
    }
  });

  it('leaves out a picture past the size, of a type the model is not given, or that is not base64, and says why', () => {
    const tooLarge = liftAnswerImage({ image: { mediaType: 'image/png', base64: picture(MAX_ANSWER_IMAGE_BASE64_CHARS + 4), width: 4000, height: 4000 } });
    expect(tooLarge.image).toBeUndefined();
    expect(tooLarge.data).toMatchObject({ image: { mediaType: 'image/png', width: 4000, height: 4000, leftOut: expect.stringMatching(/at most 262144 can be shown/) } });
    expect(JSON.stringify(tooLarge.data).length).toBeLessThan(600);

    const svg = liftAnswerImage({ image: { mediaType: 'image/svg+xml', base64: picture(400), width: 10, height: 10 } });
    expect(svg.image).toBeUndefined();
    expect(svg.data).toMatchObject({ image: { leftOut: expect.stringMatching(/image\/svg\+xml cannot be shown/) } });

    const broken = liftAnswerImage({ image: { mediaType: 'image/png', base64: 'not base64!', width: 10, height: 10 } });
    expect(broken.image).toBeUndefined();
    expect(broken.data).toMatchObject({ image: { leftOut: 'the picture was not valid base64' } });
  });
});

// ─── Through a turn: the tab is a real oui-spec runtime in index form ────────

const BASE64 = picture(200_000);

function tab() {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const room = defineSurface({
    id: 'room:vector',
    name: 'Vector Studio',
    description: 'The vector studio.',
    actions: [
      {
        id: 'vector_snapshot',
        title: 'Snapshot',
        description: 'A picture of the artboard as it is drawn now.',
        effect: 'view',
        input: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => ({
          success: true,
          data: { image: { mediaType: 'image/png', base64: BASE64, width: 960, height: 540 }, artboardId: 'ab-1', time: 0 },
        }),
      },
      {
        id: 'vector_rename',
        description: 'Renames the artboard.',
        effect: 'edit',
        input: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => ({ success: true, data: { renamed: 'ab-1' } }),
      },
    ],
  });
  runtime.mount(room, () => ({}));
  const sent: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      sent.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => runtime.execute(sent.find((r) => r.requestId === requestId)!),
  };
  return { channel, snapshot: () => runtime.snapshot() };
}

describe('a picture in an answer, through a turn', () => {
  let emit: ReturnType<typeof vi.fn>;
  let config: AgentWorkerConfig;
  let input: AgentTurnInput;

  beforeEach(() => {
    const page = tab();
    emit = vi.fn(async () => {});
    config = { tools: createToolRegistry([]), emit: { emit }, model: 'test-model', systemPrompt: 'test', ui: { channel: page.channel, resultTimeoutMs: 500 } };
    input = {
      turnId: 'turn-image',
      conversationId: 'conv',
      userId: 'user-1',
      accountId: 'acct',
      socketRoom: 'agent:turn:turn-image',
      content: 'what does the artboard look like?',
      history: [{ role: 'user', content: 'what does the artboard look like?' }],
      context: { currentPath: '/vector', oui: page.snapshot() },
    };
  });

  it('gives the model the picture as an image part of that call’s result, and its text without the base64', async () => {
    const outputs: Record<string, ModelOutput> = {};
    model = async ({ tools }) => {
      const act = tools.ui_act;
      for (const [toolCallId, action] of [['call-snap', 'vector_snapshot'], ['call-rename', 'vector_rename']] as const) {
        const output = await act.execute({ action }, { toolCallId });
        outputs[toolCallId] = act.toModelOutput({ toolCallId, input: { action }, output });
      }
      return [
        { text: '', toolCalls: [{ toolName: 'ui_act', toolCallId: 'call-snap', input: { action: 'vector_snapshot' } }] },
        { text: 'It shows a title on a dark board.', toolCalls: [] },
      ];
    };
    const result = await runAgentTurn(config, input);

    const snap = outputs['call-snap'] as { type: 'content'; value: Array<Record<string, unknown>> };
    expect(snap.type).toBe('content');
    expect(snap.value).toHaveLength(2);
    expect(snap.value[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: BASE64 } });
    const text = snap.value[0] as { type: string; text: string };
    expect(text.type).toBe('text');
    expect(text.text.length).toBeLessThan(2_000);
    expect(JSON.parse(text.text).result).toEqual({
      image: { mediaType: 'image/png', width: 960, height: 540, shown: 'The picture is attached to this result: look at it.' },
      artboardId: 'ab-1',
      time: 0,
    });

    // A result without a picture is text, as before.
    expect(outputs['call-rename'].type).toBe('text');
    expect(JSON.parse(outputs['call-rename'].value as string).result).toEqual({ renamed: 'ab-1' });

    // The base64 is in nothing the worker sends or keeps.
    expect(JSON.stringify(emit.mock.calls)).not.toContain('iVBORw0KGgo');
    expect(JSON.stringify(result.newMessages)).not.toContain('iVBORw0KGgo');
  });
});
