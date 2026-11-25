/**
 * Where the page's knowledge goes (`config.ui.knowledgePlacement`).
 *
 * By default (`'prompt'`) the page's entries and workflows are rendered into
 * the system prompt after the app's map, so the system prompt changes with the
 * page and a turn sent from another page writes the prompt cache again from its
 * first byte (Nova, 2026-10-30: 0% read on a third turn after the page moved;
 * nova-api hand-rolled `page-guide.ts` to avoid it). With `'index'` the system
 * prompt carries the map only, the same on every page of a build, and the
 * page's entries and workflows are listed by title after the conversation,
 * beside the page's newest state, each read with `ui_guide`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import { resolveKnowledge, type GeneratedKnowledge } from '@ouispec/bindings';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import {
  KNOWLEDGE_INDEX_CLOSE,
  KNOWLEDGE_INDEX_OPEN,
  knowledgeIndexText,
  readClientKnowledge,
  readKnowledgePlacement,
  withClientKnowledge,
  type KnowledgePlacement,
} from '../ui/knowledge.js';
import { EVERY_TOOL, offeredTools } from '../prompt/step-tools.js';

// ─── Mock the `ai` module: the test plays the model ──────────────────────────

type Tool = { execute: (args: unknown, o: { toolCallId: string }) => Promise<string>; description: string };
type Message = { role: string; content: string | Array<{ type: string; text?: string }> };
type StreamOpts = {
  tools: Record<string, Tool>;
  messages: Message[];
  instructions?: Array<{ content: string }>;
  prepareStep: (ctx: { steps: unknown[]; messages: Message[] }) => Promise<{ messages?: Message[]; instructions?: unknown }>;
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

// ─── The build: two pages, each with its own entries and workflow ────────────

const MAP = 'Every page.\nMain:\n- Voices /voices: New voice\n- Clips /clips: New clip';

const page = (surface: string, title: string, route: string, workflow: string) => ({
  surface,
  routes: [route],
  summary: { title, content: `${title} (${route}): its summary.` },
  detail: { title: `${title} (${route})`, content: `${title}: everything it offers.\n${'A long line of what it offers.\n'.repeat(40)}` },
  relationships: { title: `How ${title} relate`, content: `${title}'s parts and what leads where.` },
  recipes: [{ name: workflow, trigger: `Making a ${title.toLowerCase()} item`, steps: ['Open it.', 'Fill it in.', 'Save it.'] }],
  adjacent: [],
});

const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'b1',
  overview: { title: 'The app’s pages', content: MAP },
  pages: [page('page:VoicesPage', 'Voices', '/voices', 'Make a voice'), page('page:ClipsPage', 'Clips', '/clips', 'Make a clip')],
};

// ─── The tab: one surface, the same on both pages, so only the knowledge differs ─

function tab() {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  runtime.mount(
    defineSurface({
      id: 'shell:Shell',
      name: 'Shell',
      description: 'The frame.',
      observations: [],
      actions: [{ id: 'shell_help', title: 'Help', description: 'Open help.', effect: 'view', input: { type: 'object', properties: {} }, handler: async () => ({ success: true }) }],
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
  return { runtime, channel };
}

function config(channel: UIActionChannel, knowledgePlacement?: KnowledgePlacement): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    systemPrompt: 'You are the PA.',
    ui: { channel, resultTimeoutMs: 500, ...(knowledgePlacement ? { knowledgePlacement } : {}) },
  };
}

function turn(t: ReturnType<typeof tab>, path: string, content = 'hello'): AgentTurnInput {
  return {
    turnId: `turn-${path}`,
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:x',
    content,
    history: [{ role: 'user', content }],
    context: { currentPath: path, oui: t.runtime.snapshot(), uiKnowledge: resolveKnowledge(knowledge, path) },
  };
}

const text = (m: Message) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''));

/** What the turn's first step is sent, as `ai` would send it: the system prompt, and the messages its prepareStep gives. */
async function systemPromptOn(path: string, placement?: KnowledgePlacement) {
  const t = tab();
  let messages: Message[] = [];
  let system = '';
  model = async (opts) => {
    const prepared = await opts.prepareStep({ steps: [], messages: opts.messages });
    messages = prepared.messages ?? opts.messages;
    const instructions = prepared.instructions as { content: string } | Array<{ content: string }>;
    system = Array.isArray(instructions) ? instructions[0].content : instructions.content;
    return [{ text: 'ok', toolCalls: [] }];
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  seenOpts = [];
  await runAgentTurn(config(t.channel, placement), turn(t, path));
  // The system prompt the turn starts with is the one its step is sent.
  expect(seenOpts[0].instructions![0].content).toBe(system);
  return { system, messages };
}

describe('the page’s knowledge in the system prompt (the default)', () => {
  it('changes the system prompt with the page, as before', async () => {
    const voices = await systemPromptOn('/voices');
    const clips = await systemPromptOn('/clips');
    expect(voices.system).not.toBe(clips.system);
    expect(voices.system).toContain('## Platform Knowledge');
    expect(voices.system).toContain('Voices: everything it offers.');
    expect(voices.messages.map(text).join('\n')).not.toContain(KNOWLEDGE_INDEX_OPEN);
    // Named 'prompt', it is the default byte for byte.
    expect((await systemPromptOn('/voices', 'prompt')).system).toBe(voices.system);
  });
});

describe('the page’s knowledge as an index (`knowledgePlacement: \'index\'`)', () => {
  it('keeps the system prompt the same on every page of a build: the host’s prompt and the map', async () => {
    const voices = await systemPromptOn('/voices', 'index');
    const clips = await systemPromptOn('/clips', 'index');
    expect(voices.system).toBe(clips.system);
    expect(voices.system).toContain(`## The App: The app’s pages\n\n${MAP}`);
    expect(voices.system).not.toContain('Platform Knowledge');
    expect(voices.system).not.toContain('Voices: everything it offers.');
    expect(voices.system).not.toContain('Make a voice');
  });

  it('lists the page’s entries and workflows by title after the conversation, beside the page’s state', async () => {
    const { messages } = await systemPromptOn('/voices', 'index');
    const last = text(messages.at(-1)!);
    expect(messages.slice(0, -1).map(text).join('\n')).not.toContain(KNOWLEDGE_INDEX_OPEN);
    expect(last.indexOf('<page_state>')).toBeLessThan(last.indexOf(KNOWLEDGE_INDEX_OPEN));
    const index = last.slice(last.indexOf(KNOWLEDGE_INDEX_OPEN), last.indexOf(KNOWLEDGE_INDEX_CLOSE) + KNOWLEDGE_INDEX_CLOSE.length);
    expect(index).toBe(
      [
        KNOWLEDGE_INDEX_OPEN,
        'What the app knows about the page the user is on, by title. Read one with `ui_guide` before you rely on what it says: an entry by its title (`entry`, and `from` to continue a long one), a workflow with its steps by its name (`workflow`).',
        'Entries: "Voices (/voices)", "How Voices relate".',
        'Workflows: "Make a voice".',
        KNOWLEDGE_INDEX_CLOSE,
      ].join('\n'),
    );
    // The map is in the system prompt, not listed again.
    expect(index).not.toContain('The app’s pages');
  });

  it('reads each entry and workflow the index names with ui_guide', async () => {
    const t = tab();
    const saw: unknown[] = [];
    model = async (opts) => {
      const toolCalls = [
        { toolName: 'ui_guide', toolCallId: 'c1', input: { entry: 'Voices (/voices)' } },
        { toolName: 'ui_guide', toolCallId: 'c2', input: { workflow: 'Make a voice' } },
        { toolName: 'ui_guide', toolCallId: 'c3', input: { entry: 'How Voices relate' } },
      ];
      for (const call of toolCalls) saw.push(JSON.parse(await opts.tools[call.toolName].execute(call.input, { toolCallId: call.toolCallId })));
      return [{ text: 'done', toolCalls }];
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(t.channel, 'index'), turn(t, '/voices', 'what can I do here?'));
    const [entry, workflow, relationships] = saw as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ entry: 'Voices (/voices)', from: 0 });
    expect(entry.text).toContain('Voices: everything it offers.');
    expect(workflow).toEqual({ workflow: 'Make a voice', text: 'Trigger: Making a voices item\nSteps:\n1. Open it.\n2. Fill it in.\n3. Save it.' });
    expect(relationships).toMatchObject({ entry: 'How Voices relate', text: "Voices's parts and what leads where." });
    // Its description says where the titles are, and is the same on every page.
    expect(seenOpts[0].tools.ui_guide.description).toContain('<page_knowledge>');
  });
});

describe('the parts', () => {
  const voices = readClientKnowledge({ uiKnowledge: resolveKnowledge(knowledge, '/voices') })!;

  it('reads the placement, and refuses one it does not know', () => {
    expect(readKnowledgePlacement(undefined)).toBe('prompt');
    expect(readKnowledgePlacement('index')).toBe('index');
    expect(() => readKnowledgePlacement('system')).toThrow('ui.knowledgePlacement must be one of prompt, index');
  });

  it('renders the map alone into the system prompt with the index placement', () => {
    const context = { uiKnowledge: resolveKnowledge(knowledge, '/voices') };
    expect(withClientKnowledge('Host.', context, EVERY_TOOL, 'index')).toBe(`Host.\n\n## The App: The app’s pages\n\n${MAP}`);
    expect(withClientKnowledge('Host.', context, EVERY_TOOL)).toBe(withClientKnowledge('Host.', context, EVERY_TOOL, 'prompt'));
  });

  it('says nothing of ui_guide to a step that does not offer it', () => {
    const index = knowledgeIndexText(voices, offeredTools(['ui_act']))!;
    expect(index).not.toContain('ui_guide');
    expect(index).toContain('They are not shown here.');
  });

  it('is nothing for a page with no entries or workflows, and names at most what fits, then how many more', () => {
    expect(knowledgeIndexText({ map: knowledge.overview, entries: [knowledge.overview], workflows: [] })).toBeNull();
    const many = { entries: Array.from({ length: 200 }, (_, i) => ({ title: `Entry number ${i}`, content: 'x' })), workflows: [] };
    const index = knowledgeIndexText(many)!;
    expect(index.length).toBeLessThan(1_400);
    expect(index).toMatch(/, and \d+ more\.\n/);
  });
});
