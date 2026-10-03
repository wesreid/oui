/**
 * A page for the live evals: a real oui-spec surface runtime in index form,
 * answering the worker in-process, and a turn run through the worker itself
 * (`runAgentTurn`) with a live model.
 *
 * The model is given what a product's assistant is given: the SDK's prompt,
 * the page's index, and `ui_act`, `ui_describe` and `ui_read`. What it did is
 * read from the page (what its handlers ran) and from the turn (what it called
 * and said), never from what it claims.
 */
import { displayedToolCall } from '@ouispec/agent-core';
import { createSurfaceRuntime, defineSurface, type ActionHandlerResult } from 'oui-spec/core';
import type { JSONSchema, OUIActionRequest, OUIActionResult, OUIEffectKind } from 'oui-spec/spec';

import { runAgentTurn } from '../../src/orchestrator.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../../src/model.js';
import { buildAgentSystemPrompt } from '../../src/prompt/index.js';
import { createToolRegistry } from '../../src/tools/types.js';
import { loadBuiltinTools } from '../../src/tools/builtin-tools.js';
import type { UIActionChannel } from '../../src/ui/channel.js';
import { LIVE_MODEL_ID, liveBedrock } from './bedrock.js';

export interface LiveAction {
  id: string;
  title?: string;
  description: string;
  effect?: OUIEffectKind;
  /** It changes what the person works in, or removes something: the approval card asks. */
  confirm?: boolean;
  input: JSONSchema;
  /** What the page does. Default: succeeds, returning nothing. */
  run?: (params: Record<string, unknown>) => ActionHandlerResult | Promise<ActionHandlerResult>;
}

export interface LiveSurface {
  id: string;
  name: string;
  description: string;
  actions: LiveAction[];
  /** What the surface reports, by observation id: read again after every action. */
  observations?: () => Record<string, unknown>;
}

export interface LivePage {
  channel: UIActionChannel;
  snapshot: () => unknown;
  /** Every action the page ran, in order: never the runtime's own `oui` reads. */
  ran: Array<{ action: string; params: Record<string, unknown> }>;
  /** Every request the page was sent, the runtime's own included. */
  requests: OUIActionRequest[];
  /** Make answers arrive without the page's state, as a relay that refuses them leaves them (oui-spec §7.3.6). */
  loseState: (times: number) => void;
}

export function livePage(surfaces: LiveSurface[]): LivePage {
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const ran: LivePage['ran'] = [];
  const requests: OUIActionRequest[] = [];
  let lose = 0;

  const mounts = surfaces.map((surface) => {
    const push = () => {
      for (const [id, value] of Object.entries(surface.observations?.() ?? {})) mounted.pushObservation(id, value);
    };
    const defined = defineSurface({
      id: surface.id,
      name: surface.name,
      description: surface.description,
      observations: Object.keys(surface.observations?.() ?? {}).map((id) => ({ id, description: id, schema: {} })),
      actions: surface.actions.map((action) => ({
        id: action.id,
        description: action.description,
        ...(action.title ? { title: action.title } : {}),
        ...(action.effect ? { effect: action.effect } : {}),
        ...(action.confirm ? { confirm: true } : {}),
        input: action.input,
        handler: async (params: Record<string, unknown>) => {
          ran.push({ action: action.id, params });
          const result = (await action.run?.(params)) ?? { success: true };
          push();
          return result;
        },
      })),
    });
    const mounted = runtime.mount(defined, () => ({}));
    push();
    return mounted;
  });
  void mounts;

  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      requests.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => {
      const request = requests.find((r) => r.requestId === requestId)!;
      let answer: OUIActionResult = await runtime.execute(request);
      if (lose > 0 && answer.observations) {
        lose--;
        const { index: _index, observations: _observations, ...rest } = answer;
        answer = { ...rest, delivery: { trimmed: true, reason: 'payload larger than 524288 bytes', omitted: ['index', 'observations'] } };
      }
      return answer;
    },
  };
  return { channel, snapshot: () => runtime.snapshot(), ran, requests, loseState: (times) => void (lose = times) };
}

const PERSONA = {
  name: 'Assistant',
  identity: 'You are the Assistant for a design app. You work in the user’s UI, as the user would.',
  capabilities: ['Work in the UI in real time, as the user would'],
  knowledge: [],
  workflows: [],
  instructions: [],
  fewShotExamples: [],
};

const bedrock = liveBedrock();

export interface LiveTurn {
  /** Everything the assistant said, in order. */
  text: string;
  /** What it said last: its reply, after whatever it looked up. */
  reply: string;
  /** Every tool it called, in order, as a person would see them: a `ui_act` call is the action it named. */
  calls: string[];
  /** What it asked the user through `present_options`: the question, and each option's words. */
  asked: string;
  /** Usage the worker reported for the turn. */
  usage: { peakPromptTokens: number; promptTokens: number };
  rounds: number;
}

/** One turn, as a product runs it: the SDK's prompt, the page's index, a live model. */
export async function liveTurn(page: LivePage, request: string, options: { maxRounds?: number; path?: string } = {}): Promise<LiveTurn> {
  const result = await runAgentTurn(
    {
      tools: createToolRegistry(loadBuiltinTools().filter((t) => t.name === 'present_options')),
      emit: { emit: async () => {} },
      model: bedrock(LIVE_MODEL_ID),
      promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
      systemPrompt: buildAgentSystemPrompt(PERSONA as never),
      maxToolRounds: options.maxRounds ?? 12,
      // A model that takes no temperature (Claude Sonnet 5.5 on Bedrock) is sent none.
      ...(process.env.EVAL_TEMPERATURE === 'none' ? { temperature: null } : {}),
      turnDeadlineMs: 170_000,
      ui: { channel: page.channel, resultTimeoutMs: 5_000 },
    },
    {
      turnId: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: 'eval',
      userId: 'eval-user',
      accountId: 'eval-account',
      socketRoom: 'agent:turn:eval',
      content: request,
      history: [{ role: 'user', content: request }],
      context: { currentPath: options.path ?? '/canvas', oui: page.snapshot() },
    },
  );
  const said = result.newMessages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content).map((m) => m.content as string);
  const calls = result.newMessages.flatMap((m) =>
    m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => displayedToolCall({ name: c.name, arguments: c.arguments as Record<string, unknown> }).name) : [],
  );
  // A model that hands the turn back with a question puts its words there, not in a reply.
  const asked = result.newMessages
    .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
    .filter((c) => c.name === 'present_options')
    .map((c) => {
      const input = (c.arguments ?? {}) as { context?: string; prompt?: string; options?: Array<{ label?: string; description?: string }> };
      return [[input.context, input.prompt].filter(Boolean).join(' '), ...(input.options ?? []).map((o) => `${o.label ?? ''} ${o.description ?? ''}`)].join('\n');
    })
    .join('\n');
  return {
    text: said.join('\n'),
    reply: said.at(-1) ?? '',
    calls,
    asked,
    usage: { peakPromptTokens: result.usage.peakPromptTokens ?? 0, promptTokens: result.usage.promptTokens },
    rounds: result.rounds,
  };
}

export { LIVE_MODEL_ID };
