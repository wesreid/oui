/**
 * What the PA knows of the whole app: the app's map, always in its
 * instructions, and `ui_find`, which searches every action of the build, with
 * `ui_guide { page }` for another page's knowledge, both answered by the tab.
 *
 * On 2026-11-23 the PA, on a character's page, said it could not remove an
 * object from the character's photo: it knew only the page it was on, and its
 * rules told it its abilities were exactly that page's actions. The picture
 * editor one page away does it. Here the tab is a real oui-spec runtime with
 * the build's lookup installed, and the turn runs through the orchestrator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import { createKnowledgeLookup, resolveKnowledge, type GeneratedKnowledge, type OuiManifest } from '@ouispec/bindings';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry, type ToolExecutionContext } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { APP_MAP_PROMPT_CHARS, knowledgeTool, readClientKnowledge, renderAppMap } from '../ui/knowledge.js';
import { readClientPage } from '../ui/snapshot.js';
import { getUIControlRules } from '../prompt/rules/ui-control.js';
import { EVERY_TOOL } from '../prompt/step-tools.js';

// ─── Mock the `ai` module: the test plays the model ──────────────────────────

type Tool = { execute: (args: unknown, o: { toolCallId: string }) => Promise<string>; description: string; inputSchema: { properties?: Record<string, unknown> } };
type StreamOpts = { tools: Record<string, Tool>; messages: unknown[]; instructions?: Array<{ content: string }> };
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

// ─── The build: a character's page, a picture studio and its editor ──────────

const MAP =
  'Every page: sidebar groups, then their pages.\nStudios:\n- Image Studio /image: New image …\n  - Image Editor /image/:imageId (from New image): Edit: Remove, Generative Fill, Relight …\nGeneration:\n- Characters /characters: New Character …\n  - Character Detail /characters/:id (from Open): Images: Add Images …';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'b1',
  surfaces: [
    {
      id: 'page:CharacterDetailPage',
      kind: 'page',
      title: 'Character Detail',
      description: 'Offers Add Images.',
      routes: ['/characters/:id'],
      observations: [],
      actions: [
        { name: 'characters_rename', id: 'characters.rename', source: 'control', control: 'button', title: 'Rename', description: 'Press "Rename": Rename the character.', input: { type: 'object' }, reach: [] },
      ],
    },
    {
      id: 'page:ImageEditorHomePage',
      kind: 'page',
      title: 'Image Studio',
      description: 'Pictures in layers.',
      routes: ['/image'],
      observations: [],
      actions: [
        { name: 'image_home_new', id: 'image.home.new', source: 'control', control: 'button', title: 'New image', description: 'Press "New image": Start a new image.', input: { type: 'object' }, effect: { kind: 'navigate', to: '/image/:imageId' }, reach: [] },
      ],
    },
    { id: 'page:ImageEditorPage', kind: 'page', title: 'Image Editor', description: 'Offers Remove.', routes: ['/image/:imageId'], observations: [], actions: [] },
    {
      id: 'room:image-studio',
      kind: 'room',
      title: 'Image Studio',
      description: 'A layered picture editor.',
      routes: ['/image/:imageId'],
      observations: [],
      actions: [
        {
          name: 'image_studio_generative_remove',
          id: 'image-studio/action/generative-remove',
          source: 'room-action',
          title: 'Remove',
          description: 'Remove: Removes what is selected and fills the area from what surrounds it. (Edit › Remove)',
          input: { type: 'object' },
          effect: { kind: 'job', estimatedDuration: '10 seconds' },
          reach: [{ kind: 'room', room: 'image-studio', where: 'Edit › Remove' }],
        },
        {
          name: 'image_studio_select_object',
          id: 'image-studio/action/select-object',
          source: 'room-action',
          title: 'Select an object',
          description: 'Select an object: Selects the object a point is on. (Select › Object)',
          input: { type: 'object' },
          effect: 'selection',
          reach: [{ kind: 'room', room: 'image-studio', where: 'Select › Object' }],
        },
      ],
    },
  ],
};

const page = (surface: string, title: string, route: string) => ({
  surface,
  routes: [route],
  summary: { title, content: `${title} (${route})` },
  detail: { title: `${title} (${route})`, content: `${title}: what it offers, in full.` },
  relationships: null,
  recipes: [],
  adjacent: [],
});

const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'b1',
  overview: { title: 'The app’s pages', content: MAP },
  pages: [
    page('page:CharacterDetailPage', 'Character Detail', '/characters/:id'),
    page('page:ImageEditorHomePage', 'Image Studio', '/image'),
    page('page:ImageEditorPage', 'Image Editor', '/image/:imageId'),
  ],
};

// ─── The tab: a real runtime on the character's page, with the build's lookup ─

function tab({ lookup = true } = {}) {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  runtime.mount(
    defineSurface({
      id: 'page:CharacterDetailPage',
      name: 'Character Detail',
      description: 'A character.',
      observations: [],
      actions: [{ id: 'characters_rename', title: 'Rename', description: 'Rename the character.', effect: 'edit', input: { type: 'object', properties: {} }, handler: async () => ({ success: true }) }],
    }),
    () => ({}),
  );
  if (lookup) runtime.setLookup(createKnowledgeLookup({ knowledge, manifest, location: () => '/characters/c_alex' }));
  const sent: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      sent.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => runtime.execute(sent.find((r) => r.requestId === requestId)!),
  };
  return { runtime, channel, sent };
}

function config(channel: UIActionChannel): AgentWorkerConfig {
  return { tools: createToolRegistry([]), emit: { emit: vi.fn(async () => {}) }, model: 'test-model', systemPrompt: 'You are the PA.', ui: { channel, resultTimeoutMs: 500 } };
}

function turn(t: ReturnType<typeof tab>, content: string): AgentTurnInput {
  return {
    turnId: 'turn-app',
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:turn-app',
    content,
    history: [{ role: 'user', content }],
    context: { currentPath: '/characters/c_alex', oui: t.runtime.snapshot(), uiKnowledge: resolveKnowledge(knowledge, '/characters/c_alex') },
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

describe('what the PA is given of the whole app', () => {
  it('the map in its instructions, apart from the page’s knowledge, and ui_find and ui_guide { page } when the tab answers them', async () => {
    const t = tab();
    model = async () => [{ text: 'ok', toolCalls: [] }];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(t.channel), turn(t, 'hello'));

    const { tools, instructions } = seenOpts[0];
    expect(Object.keys(tools).sort()).toEqual(['ui_act', 'ui_describe', 'ui_find', 'ui_guide', 'ui_read', 'ui_wait']);
    expect(Object.keys(tools.ui_guide.inputSchema.properties ?? {})).toContain('page');
    const system = instructions![0].content;
    expect(system).toContain(`## The App: The app’s pages\n\n${MAP}`);
    // The map comes before the page's own knowledge, which no longer carries it.
    expect(system.indexOf('## The App:')).toBeLessThan(system.indexOf('## Platform Knowledge'));
    expect(system.split('Image Editor /image/:imageId (from New image)').length).toBe(2);
  });

  it('neither tool, and the map named instead, when the tab answers no lookup', async () => {
    const t = tab({ lookup: false });
    model = async () => [{ text: 'ok', toolCalls: [] }];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(t.channel), turn(t, 'hello'));
    const { tools } = seenOpts[0];
    expect(Object.keys(tools)).not.toContain('ui_find');
    expect(Object.keys(tools.ui_guide.inputSchema.properties ?? {})).not.toContain('page');
  });

  it('finds the editor’s Remove from the character’s page, through the tab, with the way there; then reads that page', async () => {
    const t = tab();
    const saw: unknown[] = [];
    model = calls(
      [
        { tool: 'ui_find', args: { query: 'remove an object from a photo', limit: 3 } },
        { tool: 'ui_guide', args: { page: 'Image Editor' } },
      ],
      saw,
    );
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(t.channel), turn(t, 'remove the basketball from this character’s photo'));

    expect(t.sent.map((r) => [r.surfaceId, r.actionId])).toEqual([
      ['oui', 'find'],
      ['oui', 'guide'],
    ]);
    expect(t.sent[0].params).toEqual({ query: 'remove an object from a photo', limit: 3 });
    // What the model reads: the lookup's answer itself.
    const found = saw[0] as { from: unknown; results: Array<Record<string, unknown>> };
    expect(found.from).toEqual({ page: 'Character Detail', route: '/characters/:id' });
    expect(found.results[0]).toMatchObject({
      tool: 'image_studio_generative_remove',
      where: 'Image Editor (/image/:imageId) › Image Studio › Edit › Remove',
      way: [
        'Go to Image Studio (/image) with app_navigate.',
        'On Image Studio, open Image Editor with New image [image_home_new].',
      ],
      needs: [
        'a selection in the Image Studio: make one with Select an object [image_studio_select_object], or another of its selection actions',
      ],
    });
    const guide = saw[1] as { page: string; text: string };
    expect(guide.page).toBe('Image Editor');
    expect(guide.text).toContain('Image Editor: what it offers, in full.');
  });
});

describe('the parts', () => {
  it('reads the map a tab sends, and refuses a malformed one', () => {
    const resolved = resolveKnowledge(knowledge, '/characters/c_alex');
    expect(readClientKnowledge({ uiKnowledge: resolved })?.map).toEqual(knowledge.overview);
    expect(() => readClientKnowledge({ uiKnowledge: { map: { title: 'x' }, entries: [], workflows: [] } })).toThrow(
      'context.uiKnowledge.map is not a knowledge entry (title, content)',
    );
  });

  it('cuts a map larger than its limit at a line, and says the rest is not shown', () => {
    const long = { map: { title: 'Pages', content: Array.from({ length: 2_000 }, (_, i) => `- Page ${i} /page/${i}: Offers things`).join('\n') }, entries: [], workflows: [] };
    const rendered = renderAppMap(long);
    expect(rendered.length).toBeLessThanOrEqual(APP_MAP_PROMPT_CHARS + 50);
    expect(rendered.endsWith('\n(The rest of the map is not shown.)')).toBe(true);
    expect(renderAppMap({ entries: [], workflows: [] })).toBe('');
  });

  it('reads the lookup actions a snapshot names, and none it does not know', () => {
    expect(readClientPage({ oui: { index: [], observations: {}, lookup: ['find', 'guide', 'teleport'] } })?.lookup).toEqual(['find', 'guide']);
    expect(readClientPage({ oui: { index: [], observations: {} } })?.lookup).toEqual([]);
  });

  it('ui_guide reads another page only through the tab’s lookup', async () => {
    const ctx = { toolCallId: 'c1', socketRoom: 'r', userId: 'u', accountId: 'a', turnId: 't' } as ToolExecutionContext;
    const resolved = resolveKnowledge(knowledge, '/characters/c_alex');
    const readPage = vi.fn(async (params: Record<string, unknown>) => ({ success: true, data: { page: params.page } }));
    expect(await knowledgeTool(resolved, readPage).execute({ page: 'Image Editor', from: 10 }, ctx)).toEqual({ success: true, data: { page: 'Image Editor' } });
    expect(readPage).toHaveBeenCalledWith({ page: 'Image Editor', from: 10 }, ctx);
    expect(await knowledgeTool(resolved).execute({ page: 'Image Editor' }, ctx)).toMatchObject({ success: false });
  });

  it('the UI rules send the PA to search before it says no, and say a picture is any picture it can reach', () => {
    const full = getUIControlRules(EVERY_TOOL);
    expect(full).toContain('Before you tell the user something cannot be done, search with ui_find');
    expect(full).toContain('Where an action takes a picture, any picture you can reach will do');
    expect(full).toContain('That means no action anywhere in the app: search with ui_find before you decide.');
    const without = getUIControlRules({ key: 'no-find', has: (name: string) => name !== 'ui_find' } as never);
    expect(without).not.toContain('ui_find');
    expect(without).toContain('The app’s map, when your instructions carry it, says what each page offers.'.replace('’', "'"));
  });
});
