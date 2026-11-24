/**
 * A surface whose action ids share a start says it once, in its heading, and
 * the model may name an action as its line does. Through a whole turn: the
 * index the model reads, `ui_act`, `ui_describe` and an action called as a tool
 * all take the line's name, run the one action it means, and never guess one a
 * name could mean on two surfaces.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { sharedPrefixNote } from '../ui/page-index.js';

type PromptPart = { type: string; toolName?: string; input?: unknown; output?: { type: string; value: unknown } };
type PromptMessage = { role: string; content: string | PromptPart[] };

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A model that makes these calls, one step each, then answers. Each step's prompt is kept. */
function scripted(calls: Array<{ tool: string; input: Record<string, unknown> }>) {
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      const call = calls[prompts.length - 1];
      const chunks = call
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${prompts.length}`, toolName: call.tool, input: JSON.stringify(call.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Done.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

const EDITOR = ['add_clip', 'remove_clips', 'set_zoom', 'run_command', 'add_marker', 'add_track', 'set_playhead'];
const STUDIO = ['add_text', 'add_shape', 'run_command', 'set_grid', 'export', 'add_guide', 'set_swatch'];

/** A tab with two rooms, a video editor and a vector studio docked on it: each run is counted by its full id. */
function tab() {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const ran: string[] = [];
  const room = (id: string, name: string, prefix: string, names: string[]) =>
    defineSurface({
      id,
      name,
      description: `The ${name}.`,
      actions: names.map((n) => ({
        id: `${prefix}${n}`,
        title: n,
        description: `Does ${n.replace('_', ' ')}.`,
        effect: 'edit' as const,
        input: { type: 'object', properties: { value: { type: 'string', description: `What to ${n.replace('_', ' ')}` } }, additionalProperties: false },
        handler: async () => {
          ran.push(`${prefix}${n}`);
          return { success: true, data: { done: n } };
        },
      })),
    });
  runtime.mount(room('room:video-editor', 'Video editor', 'video_editor_', EDITOR), () => ({}));
  runtime.mount(room('room:vector-studio', 'Vector Studio', 'vector_studio_', STUDIO), () => ({}));
  const sent: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      sent.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => runtime.execute(sent.find((r) => r.requestId === requestId)!),
  };
  return { channel, sent, ran, snapshot: () => runtime.snapshot() };
}

function config(model: unknown, channel: UIActionChannel): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    systemPrompt: 'You are the assistant.',
    ui: { channel, resultTimeoutMs: 500 },
  };
}

function input(snapshot: unknown): AgentTurnInput {
  return {
    turnId: 'turn-prefix',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-prefix',
    content: 'add a title',
    history: [{ role: 'user', content: 'add a title' }],
    context: { currentPath: '/media-projects/p1/editor', oui: snapshot },
  };
}

const toolCalls = (prompt: PromptMessage[]) =>
  prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool-call') : []));
const toolResults = (prompt: PromptMessage[]) =>
  prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool-result') : []));
const promptText = (prompt: PromptMessage[]) => JSON.stringify(prompt);

async function turn(calls: Array<{ tool: string; input: Record<string, unknown> }>) {
  const page = tab();
  const { model, prompts } = scripted(calls);
  const { runAgentTurn } = await import('../orchestrator.js');
  await runAgentTurn(config(model, page.channel), input(page.snapshot()));
  return { page, prompts };
}

describe('an index whose surfaces share an id start', () => {
  it('says each room’s start once in its heading, and its lines give the rest', async () => {
    const { prompts } = await turn([]);
    const text = promptText(prompts[0]);
    expect(text).toContain(`Video editor (room:video-editor; ${sharedPrefixNote('video_editor_')}): The Video editor.`);
    expect(text).toContain(`Vector Studio (room:vector-studio; ${sharedPrefixNote('vector_studio_')}): The Vector Studio.`);
    expect(text).toContain('- add_text: Does add text.');
    expect(text).not.toContain('- vector_studio_add_text');
  });

  it('runs the one action a line’s name means through ui_act, and the answer names it by its full id', async () => {
    const { page, prompts } = await turn([{ tool: 'ui_act', input: { action: 'add_text', input: { value: 'Title' } } }]);
    expect(page.ran).toEqual(['vector_studio_add_text']);
    expect(page.sent.filter((r) => r.actionId === 'vector_studio_add_text')).toHaveLength(1);
    expect(promptText(prompts[1])).not.toContain('is not an action of the page');
  });

  it('runs a full id exactly as before', async () => {
    const { page } = await turn([{ tool: 'ui_act', input: { action: 'video_editor_add_clip', input: { value: 'a' } } }]);
    expect(page.ran).toEqual(['video_editor_add_clip']);
  });

  it('refuses a name two rooms’ actions end in, listing their full ids, and runs nothing', async () => {
    const { page, prompts } = await turn([{ tool: 'ui_act', input: { action: 'run_command', input: {} } }]);
    expect(page.ran).toEqual([]);
    expect(page.sent.filter((r) => r.actionId.endsWith('run_command'))).toEqual([]);
    const answer = JSON.stringify(toolResults(prompts[1]));
    expect(answer).toContain('video_editor_run_command, vector_studio_run_command');
    expect(answer).toContain('Call it by its full id');
  });

  it('describes an action named as its line names it', async () => {
    const { prompts } = await turn([{ tool: 'ui_describe', input: { actions: ['set_grid'] } }]);
    const answer = JSON.stringify(toolResults(prompts[1]));
    expect(answer).toContain('vector_studio_set_grid');
    expect(answer).toContain('What to set grid');
    expect(answer).not.toContain('notOnThePage');
  });

  it('refuses to describe a name two rooms’ actions end in, listing their full ids', async () => {
    const { prompts } = await turn([{ tool: 'ui_describe', input: { actions: ['run_command'] } }]);
    expect(JSON.stringify(toolResults(prompts[1]))).toContain('video_editor_run_command, vector_studio_run_command');
  });

  it('runs an action called as a tool by its line’s name once, recorded as the ui_act call of its full id', async () => {
    const { page, prompts } = await turn([{ tool: 'add_marker', input: { value: 'here' } }]);
    expect(page.ran).toEqual(['video_editor_add_marker']);
    expect(toolCalls(prompts[1])).toEqual([
      expect.objectContaining({ toolName: 'ui_act', input: { action: 'video_editor_add_marker', input: { value: 'here' } } }),
    ]);
  });
});
