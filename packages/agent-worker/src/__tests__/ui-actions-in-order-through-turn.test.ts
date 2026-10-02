/**
 * A turn's UI actions reach the page in the order the model called them, even
 * when what runs before dispatch (the host's tool policy, the "tool call
 * started" emit) finishes in a different order.
 *
 * On dev (2026-09-30, agent-sdk-worker 5.3.0) the model called a clip's name
 * then its prompt in one response. Both went through the orchestrator's policy
 * check and emit before joining the UI queue; the prompt's got through first,
 * so the prompt ran first and its result showed the name still empty. The
 * direct test (ui-actions-in-order.test.ts) calls the UI tools themselves and
 * could not see it; these go through runAgentTurn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { ToolPolicy } from '../authz/tool-policy.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';

// ─── Mock the `ai` module: one segment whose step calls several tools at once ──

type ExecuteFn = (args: unknown, o: { toolCallId: string }) => Promise<string>;
type StreamOpts = { tools: Record<string, { execute: ExecuteFn }> };
let segment: (opts: StreamOpts) => Promise<void>;
let calls: Array<{ toolName: string; toolCallId: string }>;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    const steps = segment(opts).then(() => [{ text: 'done', toolCalls: calls }]);
    return {
      textStream: (async function* () {
        for (const s of await steps) yield s.text;
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const field = (id: string) => ({
  id,
  description: `Set the ${id}`,
  input: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
});
const form: OUISurface = {
  id: 'page:ClipCreator',
  name: 'Clip creator',
  description: 'create a clip',
  actions: [field('clips_name'), field('clips_prompt'), { id: 'clips_generate', description: 'Generate', input: { type: 'object', properties: {} } }],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page that answers after `answerMs`, keeping what each action set, and logs what happened when. */
function makePage(answerMs = 5) {
  const log: string[] = [];
  const values: Record<string, unknown> = {};
  const dispatched: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: vi.fn(async (_room, request) => {
      log.push(`dispatch ${request.actionId}`);
      dispatched.push(request);
    }),
    awaitResult: vi.fn(async (requestId): Promise<OUIActionResult> => {
      const req = dispatched.find((d) => d.requestId === requestId)!;
      await sleep(answerMs);
      if (req.params && typeof req.params === 'object' && 'value' in req.params) values[req.actionId] = req.params.value;
      log.push(`answer ${req.actionId}`);
      return { requestId, success: true, timestamp: Date.now(), surfaces: [form], data: { values: { ...values } } };
    }),
  };
  return { channel, log, values };
}

/** Delays, per tool, for the host's policy check and the "tool call started" emit. */
function makeConfig(channel: UIActionChannel, delays: { policy?: Record<string, number>; emit?: Record<string, number> }, deny: string[] = []): AgentWorkerConfig {
  const toolPolicy: ToolPolicy = {
    evaluate: async ({ toolName }) => {
      await sleep(delays.policy?.[toolName] ?? 0);
      return deny.includes(toolName) ? { action: 'deny', reason: `${toolName} is not allowed` } : { action: 'allow' };
    },
  };
  return {
    tools: createToolRegistry([]),
    emit: {
      emit: vi.fn(async (_room: string, event: string, payload: Record<string, unknown>) => {
        if (event === 'agent:tool_call_started') await sleep(delays.emit?.[payload.name as string] ?? 0);
      }),
    },
    model: 'test-model',
    systemPrompt: 'test',
    toolPolicy,
    ui: { channel, resultTimeoutMs: 1000 },
  };
}

const input: AgentTurnInput = {
  turnId: 'turn-order',
  conversationId: 'conv',
  userId: 'user-1',
  accountId: 'acct',
  socketRoom: 'agent:turn:turn-order',
  content: 'name it, prompt it, generate',
  history: [{ role: 'user', content: 'name it, prompt it, generate' }],
  context: { currentPath: '/clips/create', oui: { surfaces: [form], observations: {} } },
};

/** The model's step: every call issued at once, in this order, as the AI SDK does. */
function callAll(order: Array<[string, Record<string, unknown>]>, results: Record<string, string>) {
  calls = order.map(([toolName], i) => ({ toolName, toolCallId: `call-${i}` }));
  segment = async (opts) => {
    await Promise.all(
      order.map(async ([toolName, args], i) => {
        results[toolName] = await opts.tools[toolName].execute(args, { toolCallId: `call-${i}` });
      }),
    );
  };
}

beforeEach(() => {
  calls = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UI actions called in one response, through runAgentTurn', () => {
  it('reach the page in the model\'s order when the policy check and the emit finish in reverse', async () => {
    const { channel, log } = makePage();
    const results: Record<string, string> = {};
    callAll(
      [
        ['clips_name', { value: 'PA same-turn check' }],
        ['clips_prompt', { value: 'a hot air balloon at dawn' }],
        ['clips_generate', {}],
      ],
      results,
    );
    // The first call is the slowest to get through both awaits, the last the fastest.
    const config = makeConfig(channel, {
      policy: { clips_name: 40, clips_prompt: 20, clips_generate: 0 },
      emit: { clips_name: 30, clips_prompt: 15, clips_generate: 0 },
    });

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config, input);

    expect(log).toEqual([
      'dispatch clips_name',
      'answer clips_name',
      'dispatch clips_prompt',
      'answer clips_prompt',
      'dispatch clips_generate',
      'answer clips_generate',
    ]);
    // The prompt's result shows the page the name left: the name is set.
    expect(JSON.parse(results.clips_prompt)).toMatchObject({
      result: { values: { clips_name: 'PA same-turn check', clips_prompt: 'a hot air balloon at dawn' } },
    });
  });

  it('gives up the place of a call the policy refuses, so the ones after it still run, in order', async () => {
    const { channel, log } = makePage();
    const results: Record<string, string> = {};
    callAll(
      [
        ['clips_name', { value: 'n' }],
        ['clips_prompt', { value: 'p' }],
        ['clips_generate', {}],
      ],
      results,
    );
    const config = makeConfig(channel, { policy: { clips_name: 30, clips_prompt: 10 } }, ['clips_prompt']);

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config, input);

    expect(log).toEqual(['dispatch clips_name', 'answer clips_name', 'dispatch clips_generate', 'answer clips_generate']);
    expect(JSON.parse(results.clips_prompt)).toMatchObject({ success: false, policyDenied: true });
  });

  it('gives up the place of a call with invalid input, so the ones after it still run, in order', async () => {
    const { channel, log } = makePage();
    const results: Record<string, string> = {};
    callAll(
      [
        ['clips_name', { value: 'n' }],
        ['clips_prompt', {}],
        ['clips_generate', {}],
      ],
      results,
    );
    const config = makeConfig(channel, { emit: { clips_name: 20 } });

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config, input);

    expect(log).toEqual(['dispatch clips_name', 'answer clips_name', 'dispatch clips_generate', 'answer clips_generate']);
    expect(JSON.parse(results.clips_prompt)).toMatchObject({ success: false, invalidInput: true });
  });
});

describe('the surfaces a turn holds, by hash (oui-spec 0.6)', () => {
  it('names the snapshot\'s hash on every request while the page keeps it, and takes the answers that omit surfaces as that page', async () => {
    const dispatched: OUIActionRequest[] = [];
    const channel: UIActionChannel = {
      dispatch: vi.fn(async (_room, request) => {
        dispatched.push(request);
      }),
      // A tab on oui-spec 0.6: the page has not changed, so no surfaces, only their hash.
      awaitResult: vi.fn(
        async (requestId): Promise<OUIActionResult> => ({ requestId, success: true, timestamp: Date.now(), surfacesHash: 'fnv1a64:form' }),
      ),
    };
    const results: Record<string, string> = {};
    callAll(
      [
        ['clips_name', { value: 'Balloon' }],
        ['clips_prompt', { value: 'at dawn' }],
      ],
      results,
    );
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel, {}), {
      ...input,
      context: { currentPath: '/clips/create', oui: { surfaces: [form], observations: {}, surfacesHash: 'fnv1a64:form' } },
    });
    expect(dispatched.map((r) => r.knownSurfaces)).toEqual(['fnv1a64:form', 'fnv1a64:form']);
    // The page each result describes is the one held under that hash.
    expect(JSON.parse(results.clips_prompt).page.surfaces).toEqual(['Clip creator']);
  });

  it('names no hash when the client sent none, so an older tab still answers with its surfaces', async () => {
    const { channel } = makePage();
    const results: Record<string, string> = {};
    callAll([['clips_name', { value: 'x' }]], results);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel, {}), input);
    const [request] = vi.mocked(channel.dispatch).mock.calls.map(([, r]) => r);
    expect(request).not.toHaveProperty('knownSurfaces');
  });
});
