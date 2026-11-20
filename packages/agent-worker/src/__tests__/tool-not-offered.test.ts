/**
 * A call to a tool its step does not offer runs nothing, asks the user
 * nothing, and ends no turn: the model is told the tool is not available and
 * answers in words, in the same turn. Through the real `ai` loop and the real
 * OpenAI provider, with only the model a stand-in.
 *
 * Nova, 2026-11-19 (agent-worker 0.32.2): the turn policy held a step to one
 * tool (`activeTools`), leaving out `present_options`. The SDK's rules still
 * named `present_options`, and the model called it beside the allowed tool.
 * The call failed (`AI_NoSuchToolError`) and never ran, but it never went
 * into `callsNotRun`, so the turn counted it as a question to the user and
 * ended after that round, with no reply; Nova's runtime fell back.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import { runAgentTurn, unavailableToolError } from '../index.js';
import { buildAgentSystemPrompt } from '../prompt/builder.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import type { TurnPolicy } from '../turn-policy.js';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { respondingOpenAI, type ChatRequest, type ScriptedReply } from './support/replay.js';
import { names } from './support/tool-names.js';

const searchInventory: RegisteredTool = {
  name: 'searchInventory',
  description: 'Searches the dealership’s inventory.',
  effect: 'view',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: vi.fn(async () => ({ success: true, data: { matches: [{ stock: 'R1', model: 'RAV4 XLE', color: 'blue' }, { stock: 'R2', model: 'RAV4 XSE', color: 'blue' }] } })),
};

const choice = { context: 'I found two blue RAV4s.', prompt: 'Which one should I open?', options: [{ label: 'The XLE', value: 'R1' }, { label: 'The XSE', value: 'R2' }] };

/** Nova's limit: the turn's first step searches and does nothing else; every later step is free. */
const searchFirst: TurnPolicy = {
  classifyTurn: () => 'sales',
  prepareStep: vi.fn(async ({ steps }) => (steps.length === 0 ? { toolChoice: 'required' as const, activeTools: ['searchInventory'] } : {})),
};

const persona = {
  name: 'Desk',
  identity: 'You are Desk, the assistant of a car dealership.',
  instructions: ['Answer in the customer’s language.'],
};

interface Emitted {
  event: string;
  data: Record<string, unknown>;
}

/** Runs one turn the model answers with `replies`, under `policy`. */
async function turn(replies: ScriptedReply[], policy: TurnPolicy = searchFirst, extra: Partial<AgentWorkerConfig> = {}) {
  const m = respondingOpenAI((_request, i) => replies[i]);
  const emitted: Emitted[] = [];
  const stored: Array<{ role: string; content?: string | null; toolCallId?: string; toolCalls?: Array<{ id: string; name: string }> }> = [];
  const result = await runAgentTurn(
    {
      tools: createToolRegistry([searchInventory, ...loadBuiltinTools()]),
      emit: { emit: async (_room, event, data) => void emitted.push({ event, data: data as Record<string, unknown> }) },
      // The SDK's whole prompt, as Nova builds it: every rule, the choice tool's included.
      systemPrompt: buildAgentSystemPrompt(persona, { userId: 'u1', accountId: 'a1', context: null }),
      model: m.model,
      turnPolicy: policy,
      beforeTurnComplete: async ({ newMessages }) => void stored.push(...(newMessages as typeof stored)),
      ...extra,
    },
    { turnId: 'turn-nova', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:turn-nova', content: 'Any blue RAV4s?' },
  );
  const said = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN).map((e) => String(e.data.text)).join('');
  return { result, requests: m.requests, emitted, stored, said };
}

/** Everything a request tells the model in words: its messages' text, and its tools' names and descriptions. */
const wordsOf = (request: ChatRequest) => JSON.stringify([request.messages, request.tools ?? []]);
const toolNames = (request: ChatRequest) => (request.tools ?? []).map((t) => t.function.name);
/** The result the model was given for one call, in the request after it. */
const resultIn = (request: ChatRequest, callId: string) =>
  String(request.messages.find((msg) => msg.role === 'tool' && msg.tool_call_id === callId)?.content ?? '');

describe('a call to a tool the step does not offer (the Nova case)', () => {
  it('runs nothing, ends no turn, and the model answers in words in the same turn', async () => {
    const { result, requests, emitted, stored, said } = await turn([
      {
        toolCalls: [
          { id: 'call_choice', name: 'present_options', args: choice },
          { id: 'call_search', name: 'searchInventory', args: { query: 'blue RAV4' } },
        ],
      },
      { text: 'We have two blue RAV4s in stock: an XLE and an XSE. Want to see either one?' },
    ]);

    // The turn went on after the round, and ended with the model's reply.
    expect(requests).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.stopReason).toBe('complete');
    expect(said).toBe('We have two blue RAV4s in stock: an XLE and an XSE. Want to see either one?');
    expect(stored.at(-1)).toEqual({ role: 'assistant', content: 'We have two blue RAV4s in stock: an XLE and an XSE. Want to see either one?' });

    // The allowed tool ran; the choice did not, and the person was shown no card.
    expect(searchInventory.execute).toHaveBeenCalledTimes(1);
    const completes = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE);
    expect(completes.find((e) => e.data.toolUseId === 'call_choice')?.data).toMatchObject({ name: 'present_options', success: false, result: { refused: true } });
    expect(JSON.stringify(emitted)).not.toContain('__present_options');

    // The first round is not the turn's last word; the second is.
    const rounds = emitted.filter((e) => e.event === AGENT_SOCKET_EVENTS.ROUND_END).map((e) => e.data.final);
    expect(rounds).toEqual([false, true]);

    // The model read, as the choice's result, that it is not a tool it can use now, never `ai`'s own error.
    const answered = resultIn(requests[1], 'call_choice');
    expect(JSON.parse(answered)).toEqual({
      success: false,
      notRun: true,
      unavailable: true,
      error: unavailableToolError('present_options'),
    });
    expect(unavailableToolError('present_options')).toBe(
      '"present_options" is not one of the tools you can use now, so the call did not run and nothing was shown to the user. Carry on with the tools you have, or answer in words.',
    );
    expect(JSON.stringify(requests[1])).not.toContain('Model tried to call unavailable tool');
    expect(resultIn(requests[1], 'call_search')).toContain('RAV4 XLE');

    // The conversation stores the same result, with every call paired with its own.
    const choiceResult = stored.find((msg) => msg.role === 'tool' && msg.toolCallId === 'call_choice');
    expect(choiceResult?.content).toBe(answered);
    expect(stored.map((msg) => msg.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
  });

  it('tells the limited step about no tool it does not offer, and the step after it about all of them', async () => {
    const { requests } = await turn([
      { toolCalls: [{ id: 'call_search', name: 'searchInventory', args: { query: 'blue RAV4' } }] },
      { text: 'Two blue RAV4s are in stock.' },
    ]);
    // The limited step is given one tool, and the rules text it reads never names the choice tool.
    expect(toolNames(requests[0])).toEqual(['searchInventory']);
    expect(names(wordsOf(requests[0]), 'present_options')).toBe(false);
    expect(wordsOf(requests[0])).not.toContain('Options Presentation');
    // The next step offers it again, and its rules say how to use it.
    expect(toolNames(requests[1])).toContain('present_options');
    expect(String(requests[1].messages[0].content)).toContain('offer it with present_options');
  });

  it('shows the turn policy which calls ran and why one did not', async () => {
    const policy: TurnPolicy = { classifyTurn: () => 'sales', prepareStep: vi.fn(searchFirst.prepareStep) };
    await turn(
      [
        { toolCalls: [{ id: 'call_choice', name: 'present_options', args: choice }, { id: 'call_search', name: 'searchInventory', args: { query: 'blue RAV4' } }] },
        { text: 'Two blue RAV4s are in stock.' },
      ],
      policy,
    );
    const second = vi.mocked(policy.prepareStep).mock.calls[1][0];
    expect(second.steps[0].toolCalls).toEqual([
      { toolName: 'present_options', ran: false, notRun: expect.stringContaining('"present_options" is not one of the tools you can use now') },
      { toolName: 'searchInventory', ran: true },
    ]);
  });

  it('goes on when the model calls only the tool it was not given', async () => {
    const { result, requests, said } = await turn(
      [{ toolCalls: [{ id: 'call_choice', name: 'present_options', args: choice }] }, { text: 'Two blue RAV4s are in stock, an XLE and an XSE.' }],
      { classifyTurn: () => 'sales', prepareStep: async ({ steps }) => (steps.length === 0 ? { activeTools: ['searchInventory'] } : {}) },
    );
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('complete');
    expect(said).toBe('Two blue RAV4s are in stock, an XLE and an XSE.');
  });

  it('still ends the turn on a choice the step offered, which ran', async () => {
    const { result, requests } = await turn(
      [{ text: 'Two are blue.', toolCalls: [{ id: 'call_choice', name: 'present_options', args: choice }] }],
      { classifyTurn: () => 'sales', prepareStep: async () => ({}) },
    );
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe('present_options');
  });

  it('goes on after a tool the turn has never had', async () => {
    const { result, requests, said } = await turn(
      [{ toolCalls: [{ id: 'call_made_up', name: 'book_test_drive', args: { stock: 'R1' } }] }, { text: 'I can’t book that here, but the store can.' }],
      { classifyTurn: () => 'sales', prepareStep: async () => ({}) },
    );
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('complete');
    expect(said).toBe('I can’t book that here, but the store can.');
    expect(JSON.parse(resultIn(requests[1], 'call_made_up'))).toMatchObject({ notRun: true, unavailable: true });
  });
});

// ─── A call whose input cannot be read ──────────────────────────────────────

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

describe('a call whose input cannot be read (an invalid tool call)', () => {
  it('runs nothing, ends no turn, and is stored as a call that did not run', async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options: { prompt: unknown }) => {
        prompts.push(structuredClone(options.prompt));
        const chunks =
          prompts.length === 1
            ? [
                { type: 'stream-start', warnings: [] },
                // The choice, offered, with input that is not JSON.
                { type: 'tool-call', toolCallId: 'call-bad', toolName: 'present_options', input: '{"prompt": "Which one?", "options": [' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Which one would you like: the XLE or the XSE?' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    } as never);
    const stored: Array<{ role: string; content?: string | null; toolCallId?: string }> = [];
    const result = await runAgentTurn(
      {
        tools: createToolRegistry(loadBuiltinTools()),
        emit: { emit: vi.fn(async () => {}) },
        systemPrompt: 'You help on a dealer’s site.',
        model: model as AgentWorkerConfig['model'],
        beforeTurnComplete: async ({ newMessages }) => void stored.push(...(newMessages as typeof stored)),
      },
      { turnId: 'turn-bad', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:turn-bad', content: 'Which RAV4?' },
    );
    expect(prompts).toHaveLength(2);
    expect(result.stopReason).toBe('complete');
    const kept = JSON.parse(stored.find((msg) => msg.toolCallId === 'call-bad')!.content!);
    expect(kept).toMatchObject({ success: false, notRun: true, invalidInput: true });
    expect(kept.error).toMatch(/^Invalid input for tool present_options/);
    expect(JSON.stringify(prompts[1])).toContain('Invalid input for tool present_options');
  });
});

// ─── A page turn: the UI tools, the camera, photos and the call's devices ────

/** A tab with one surface: its runtime answers the turn's UI requests. */
function tab() {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  runtime.mount(
    defineSurface({
      id: 'inventory:list',
      name: 'Inventory',
      description: 'The cars in stock.',
      actions: [
        {
          id: 'inventory_open',
          title: 'Open a car',
          description: 'Opens a car’s page.',
          effect: 'navigate',
          input: { type: 'object', properties: { stock: { type: 'string' } }, required: ['stock'], additionalProperties: false },
          handler: async () => ({ success: true }),
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
  return { channel, snapshot: () => runtime.snapshot() };
}

const route = { url: 'https://api.example.com/sessions/s1', token: 'tok', expiresAt: '2030-01-01T00:00:00Z' };

describe('a page turn on a live call, held to one tool', () => {
  it('names none of the SDK’s tools to the limited step, in its prompt, its page index or its turn’s context, and all of them to the next', async () => {
    const page = tab();
    const m = respondingOpenAI(
      (_request, i) =>
        [
          { toolCalls: [{ id: 'call_search', name: 'searchInventory', args: { query: 'blue RAV4' } }] },
          { text: 'Two blue RAV4s are in stock.' },
        ][i],
    );
    const input: AgentTurnInput = {
      turnId: 'turn-page',
      conversationId: 'c1',
      userId: 'u1',
      accountId: 'a1',
      socketRoom: 'agent:turn:turn-page',
      content: 'Any blue RAV4s?',
      context: { oui: page.snapshot() },
      vision: { seeing: true, remarks: false, canLook: true, absent: null, look: route, observation: null },
      capture: { plans: [{ key: 'trade-in', title: 'Trade-in photos', offerWhen: 'the caller has a car to trade in' }], control: route, active: null, update: null },
      handoff: { control: route, device: { formFactor: 'desktop', switches: 0 }, offer: null, update: null },
    };
    const result = await runAgentTurn(
      {
        tools: createToolRegistry([searchInventory, ...loadBuiltinTools()]),
        emit: { emit: vi.fn(async () => {}) },
        systemPrompt: buildAgentSystemPrompt(persona, { userId: 'u1', accountId: 'a1', context: null }),
        model: m.model,
        ui: { channel: page.channel, resultTimeoutMs: 500 },
        turnPolicy: searchFirst,
      },
      input,
    );
    expect(result.stopReason).toBe('complete');
    const sdkTools = ['present_options', 'ui_act', 'ui_describe', 'ui_read', 'look', 'capture_start', 'capture_status', 'capture_stop', 'call_handoff'];

    // The limited step: one tool, and not one word naming another.
    expect(toolNames(m.requests[0])).toEqual(['searchInventory']);
    expect(sdkTools.filter((tool) => names(wordsOf(m.requests[0]), tool))).toEqual([]);
    const limited = wordsOf(m.requests[0]);
    expect(limited).toContain('<page_index>');
    expect(limited).toContain('You cannot look at the caller at this step');
    expect(limited).toContain('Photos cannot be started at this step.');
    expect(limited).toContain('The call cannot be moved to another device at this step.');

    // The next step offers them all, and is told how to use each.
    expect(toolNames(m.requests[1])).toEqual(expect.arrayContaining(sdkTools));
    expect(sdkTools.filter((tool) => !names(wordsOf(m.requests[1]), tool))).toEqual([]);
  });
});
