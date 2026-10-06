/**
 * A page action that takes an attached file, run the way the model runs page
 * actions: through `ui_act`, to a real oui-spec runtime in the tab (ADR-0252
 * §2.13, OUI spec §7.3.11).
 *
 * The worker checks each file before anything is dispatched: that it is the
 * conversation's, that its check has passed, and that it is a type the input
 * takes, for an input that takes text as much as one that takes a file. Only
 * the id travels; the tab resolves it through its own host and checks again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { AttachmentRef } from '@ouispec/agent-core';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import type { AttachmentStore } from '../attachments/store.js';

type Tool = { execute: (args: unknown, o: { toolCallId: string }) => Promise<string> };
type StreamOpts = { tools: Record<string, Tool> };
let script: (opts: StreamOpts) => Promise<void>;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    const run = script(opts).then(() => [{ text: 'done', toolCalls: [] }]);
    return {
      textStream: (async function* () {
        await run;
        yield 'done';
      })(),
      steps: run.then((s) => s.map((x) => ({ ...x, usage: { inputTokens: 10 } }))),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: run.then(() => ({ messages: [{ role: 'assistant', content: 'done' }] })),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const png: AttachmentRef = { id: 'att_logo00001', name: 'logo.png', mediaType: 'image/png', kind: 'image', bytes: 400_000, width: 1200, height: 800 };
const mark: AttachmentRef = { id: 'att_mark00001', name: 'mark.svg', mediaType: 'image/svg+xml', kind: 'text', bytes: 900 };
const page: AttachmentRef = { id: 'att_page00001', name: 'page.html', mediaType: 'text/html', kind: 'text', bytes: 900 };
const scanning: AttachmentRef = { ...png, id: 'att_scan00001', pending: true };

/** The tab: a room on a real runtime, whose host resolves a file by its id. */
function tab() {
  const ran: Array<{ action: string; params: Record<string, unknown> }> = [];
  const pngFile = Object.assign(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { name: 'logo.png', lastModified: 0 });
  const files: Record<string, unknown> = {
    att_logo00001: pngFile,
    att_mark00001: { name: 'mark.svg', mediaType: 'image/svg+xml', text: '<svg id="mark"/>' },
    // The tab's host would give this file if asked: the worker must not let it be asked.
    att_page00001: { name: 'page.html', mediaType: 'image/svg+xml', text: '<script>steal()</script>' },
  };
  const resolve = vi.fn(async (id: string) => {
    if (!(id in files)) throw new Error('It is not one of your files.');
    return files[id] as never;
  });
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 50 }, attachments: { resolve } });
  const handler = (action: string) => async (params: Record<string, unknown>) => {
    ran.push({ action, params });
    return { success: true, data: { did: action } };
  };
  runtime.mount(
    defineSurface({
      id: 'room:studio',
      name: 'Studio',
      description: 'Graphics',
      actions: [
        {
          id: 'studio_texture_set',
          title: 'Use a picture as the texture',
          description: 'Uses a picture as the texture.',
          effect: 'edit',
          input: { type: 'object', required: ['picture'], properties: { picture: { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/*'] } } } },
          handler: handler('studio_texture_set'),
        },
        {
          id: 'studio_svg_open',
          title: 'Open an SVG',
          description: 'Opens an SVG as artwork.',
          effect: 'edit',
          input: { type: 'object', required: ['svg'], properties: { svg: { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'text', mediaTypes: ['image/svg+xml'] } } } },
          handler: handler('studio_svg_open'),
        },
        {
          id: 'studio_brand_set',
          title: 'Set the brand',
          description: 'Sets the brand.',
          effect: 'edit',
          input: {
            type: 'object',
            properties: { brand: { type: 'object', properties: { logo: { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file' } } } } },
          },
          handler: handler('studio_brand_set'),
        },
      ],
    }),
    () => ({}),
  );
  const sent: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      sent.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => runtime.execute(sent.find((r) => r.requestId === requestId)!),
  };
  return { channel, sent, ran, resolve, snapshot: () => runtime.snapshot(), pngFile };
}

function store(): AttachmentStore {
  return {
    describe: vi.fn(async (ids: readonly string[]) => [png, mark, page, scanning].filter((f) => ids.includes(f.id))),
    load: vi.fn(async () => ({ ok: false as const, reason: 'unsupported' as const })),
    list: vi.fn(async () => [png, mark, page, scanning]),
  };
}

function setup() {
  const t = tab();
  const emit = vi.fn(async () => {});
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([]),
    emit: { emit },
    model: 'test-model',
    systemPrompt: 'test',
    ui: { channel: t.channel, resultTimeoutMs: 500 },
    attachments: { store: store() },
  };
  const input: AgentTurnInput = {
    turnId: 'turn-ui-files',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-ui-files',
    content: 'use my logo',
    history: [{ role: 'user', content: 'use my logo' }],
    context: { currentPath: '/studio', oui: t.snapshot() },
  };
  return { ...t, emit, config, input };
}

/** The action requests the tab was sent: the page's own `describe` requests, which fetch a definition, aside. */
const actions = (s: { sent: OUIActionRequest[] }) => s.sent.filter((r) => r.surfaceId !== 'oui');

/** The model's calls through `ui_act`, each answer kept. */
async function act(s: ReturnType<typeof setup>, calls: Array<{ action: string; input: Record<string, unknown> }>) {
  const answers: Array<Record<string, unknown>> = [];
  script = async (opts) => {
    for (const [i, call] of calls.entries()) answers.push(JSON.parse(await opts.tools.ui_act.execute(call, { toolCallId: `call-${i}` })));
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  const result = await runAgentTurn(s.config, s.input);
  return { answers, result };
}

beforeEach(() => {
  script = async () => {};
});

describe('a page action that takes a file, through ui_act', () => {
  it('sends only the id, and the tab’s handler runs with the file its host resolved', async () => {
    const s = setup();
    const { answers } = await act(s, [{ action: 'studio_texture_set', input: { picture: 'att_logo00001' } }]);
    expect(answers[0]).toMatchObject({ result: { did: 'studio_texture_set' } });
    expect(actions(s).map((r) => r.params)).toEqual([{ picture: 'att_logo00001' }]);
    expect(s.ran).toEqual([{ action: 'studio_texture_set', params: { picture: s.pngFile } }]);
    expect(s.resolve).toHaveBeenCalledWith('att_logo00001', 'file');
  });

  it('gives an input that takes text the file’s text, once its type is one it takes', async () => {
    const s = setup();
    await act(s, [{ action: 'studio_svg_open', input: { svg: 'att_mark00001' } }]);
    expect(s.ran).toEqual([{ action: 'studio_svg_open', params: { svg: '<svg id="mark"/>' } }]);
  });

  it('is refused before anything is dispatched when the file is not a type a text input takes', async () => {
    const s = setup();
    const { answers } = await act(s, [{ action: 'studio_svg_open', input: { svg: 'att_page00001' } }]);
    expect(answers[0]).toMatchObject({ notRun: true, error: 'svg: "page.html" (att_page00001) is text/html; it takes image/svg+xml.' });
    expect(actions(s)).toEqual([]);
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.ran).toEqual([]);
  });

  it('is refused before anything is dispatched for a file of another conversation, or one still being checked', async () => {
    const s = setup();
    const { answers } = await act(s, [
      { action: 'studio_texture_set', input: { picture: 'att_elsewhere1' } },
      { action: 'studio_texture_set', input: { picture: 'att_scan00001' } },
    ]);
    expect(answers[0]).toMatchObject({ notRun: true, error: expect.stringMatching(/"att_elsewhere1" is not a file of this conversation/) });
    expect(answers[1]).toMatchObject({ notRun: true, error: expect.stringMatching(/"att_scan00001" is still being checked/) });
    expect(actions(s)).toEqual([]);
    expect(s.ran).toEqual([]);
  });

  it('is refused for an action declaring a file where none can be checked', async () => {
    const s = setup();
    const { answers } = await act(s, [{ action: 'studio_brand_set', input: { brand: { logo: 'att_logo00001' } } }]);
    expect(answers[0]).toMatchObject({ notRun: true, error: expect.stringMatching(/declares an attached file at brand\.logo, where none can be checked/) });
    expect(actions(s)).toEqual([]);
  });

  it('keeps the file out of every event and the stored messages: only its id is said', async () => {
    const s = setup();
    const { result } = await act(s, [{ action: 'studio_svg_open', input: { svg: 'att_mark00001' } }]);
    const said = JSON.stringify([s.emit.mock.calls, result.newMessages]);
    expect(said).toContain('att_mark00001');
    expect(said).not.toContain('<svg id=\\"mark\\"/>');
    expect(said).not.toContain('svg id="mark"');
  });
});
