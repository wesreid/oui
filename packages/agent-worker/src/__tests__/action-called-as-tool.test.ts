/**
 * An action of the page called as a tool of its own runs once, as `ui_act`.
 *
 * DEOS, 2026-10-30: the model called `app_navigate` as if it were a tool,
 * then again through `ui_act`, and the person saw it navigate twice. Here the
 * whole turn runs through the real `ai` loop with only the model a stand-in:
 * the call is repaired into the `ui_act` call it means before anything runs,
 * the page runs it once, and the model's next prompt shows one `ui_act` call.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { actionCallAsUiAct } from '../ui/action-as-tool.js';

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
            { type: 'text-delta', id: '0', delta: 'Opened.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

/** A tab with the generated navigation surface: going to a page is counted. */
function tab() {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const went: string[] = [];
  runtime.mount(
    defineSurface({
      id: 'app:navigation',
      name: 'Pages',
      description: 'Every page of the app.',
      actions: [
        {
          id: 'app_navigate',
          title: 'Go to a page',
          description: 'Go to a page of the app.',
          effect: 'navigate',
          input: {
            type: 'object',
            properties: { path: { type: 'string' }, query: { type: 'object' } },
            required: ['path'],
            additionalProperties: false,
          },
          handler: async (params) => {
            went.push(`${String(params.path)}?${new URLSearchParams(params.query as Record<string, string>).toString()}`);
            return { success: true, data: { navigatedTo: params.path } };
          },
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
  return { channel, sent, went, snapshot: () => runtime.snapshot() };
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
    turnId: 'turn-nav',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-nav',
    content: 'show me the declined work',
    history: [{ role: 'user', content: 'show me the declined work' }],
    context: { currentPath: '/', oui: snapshot },
  };
}

const toolCalls = (prompt: PromptMessage[]) =>
  prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool-call') : []));

describe('an action called as a tool', () => {
  it('runs once, through ui_act, and the model sees one ui_act call', async () => {
    const page = tab();
    const { model, prompts } = scripted([{ tool: 'app_navigate', input: { path: '/service-lane', query: { view: 'declined' } } }]);
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(model, page.channel), input(page.snapshot()));

    expect(page.went).toEqual(['/service-lane?view=declined']);
    // The page is asked for the action's definition (index form), then runs it once.
    expect(page.sent.map((r) => r.actionId).filter((id) => id === 'app_navigate')).toHaveLength(1);
    expect(prompts).toHaveLength(2);
    expect(toolCalls(prompts[1])).toEqual([
      expect.objectContaining({ toolName: 'ui_act', input: { action: 'app_navigate', input: { path: '/service-lane', query: { view: 'declined' } } } }),
    ]);
    expect(result.rounds).toBe(2);
  });

  it('leaves a name that is no action of the page to the SDK: nothing runs, and the model is told there is no such tool', async () => {
    const page = tab();
    const { model, prompts } = scripted([{ tool: 'service_lane_open', input: { view: 'declined' } }]);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(model, page.channel), input(page.snapshot()));

    expect(page.sent.filter((r) => r.actionId !== 'describe')).toEqual([]);
    expect(page.went).toEqual([]);
    const answer = JSON.stringify(prompts[1]);
    expect(answer).toContain('service_lane_open');
    expect(answer).toMatch(/unavailable tool|no such tool/i);
  });
});

describe('actionCallAsUiAct', () => {
  const tools = { ui_act: {}, ui_read: {} };
  const isAction = (name: string) => name === 'app_navigate';
  const call = (toolName: string, input: string) => ({ toolCallId: 'c1', toolName, input });

  it('is the ui_act call the action means', () => {
    expect(actionCallAsUiAct(call('app_navigate', '{"path":"/x"}'), tools, isAction, 'ui_act')).toEqual({
      toolCallId: 'c1',
      toolName: 'ui_act',
      input: '{"action":"app_navigate","input":{"path":"/x"}}',
    });
    expect(actionCallAsUiAct(call('app_navigate', ''), tools, isAction, 'ui_act')?.input).toBe('{"action":"app_navigate","input":{}}');
  });

  it('is nothing for a tool of the turn, a name the page does not offer, a turn with no ui_act, or an input that is not an object', () => {
    expect(actionCallAsUiAct(call('ui_read', '{}'), tools, () => true, 'ui_act')).toBeNull();
    expect(actionCallAsUiAct(call('nope', '{}'), tools, isAction, 'ui_act')).toBeNull();
    expect(actionCallAsUiAct(call('app_navigate', '{}'), { ui_read: {} }, isAction, 'ui_act')).toBeNull();
    expect(actionCallAsUiAct(call('app_navigate', '[1]'), tools, isAction, 'ui_act')).toBeNull();
    expect(actionCallAsUiAct(call('app_navigate', '{not json'), tools, isAction, 'ui_act')).toBeNull();
  });
});
