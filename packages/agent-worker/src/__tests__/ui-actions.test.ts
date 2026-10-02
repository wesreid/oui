/**
 * UI actions (ADR-0209): the client's surfaces become the turn's UI tools,
 * every UI action is answered by the client, and the tool set follows the
 * page across a navigation within one turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import type { RegisteredTool } from '../tools/types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { readClientSnapshot, withoutClientSnapshot } from '../ui/snapshot.js';

// ─── Mock the `ai` module ────────────────────────────────────────────────────

type StreamOpts = {
  tools: Record<string, { execute: (args: unknown, o: { toolCallId: string }) => Promise<string>; description: string }>;
  messages: Array<{ role: string; content: unknown }>;
  stopWhen: unknown[];
};
let segmentImpls: Array<(opts: StreamOpts) => Promise<Array<{ text: string; toolCalls: Array<{ toolName: string; toolCallId: string }> }>>>;
let seenOpts: StreamOpts[];

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seenOpts.push(opts);
    const impl = segmentImpls[seenOpts.length - 1];
    if (!impl) throw new Error(`unexpected segment ${seenOpts.length}`);
    const steps = impl(opts);
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const shell: OUISurface = {
  id: 'app-shell',
  name: 'App Shell',
  description: 'global',
  actions: [
    {
      id: 'navigate',
      description: 'Go to a page',
      input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
};
const home: OUISurface = { id: 'home', name: 'Home', description: 'home', actions: [] };
const projects: OUISurface = {
  id: 'projects-library',
  name: 'Projects',
  description: 'projects',
  actions: [{ id: 'projects_create', description: 'Create a project', input: { type: 'object', properties: {} } }],
};

function makeChannel(answer: (req: OUIActionRequest) => OUIActionResult | null) {
  const dispatched: Array<{ room: string; request: OUIActionRequest }> = [];
  const channel: UIActionChannel = {
    dispatch: vi.fn(async (room, request) => {
      dispatched.push({ room, request });
    }),
    awaitResult: vi.fn(async (requestId) => {
      const req = dispatched.find((d) => d.request.requestId === requestId)!.request;
      return answer(req);
    }),
  };
  return { channel, dispatched };
}

function makeConfig(channel: UIActionChannel | undefined, hostTools: RegisteredTool[] = []): AgentWorkerConfig {
  return {
    tools: createToolRegistry(hostTools),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    systemPrompt: 'test',
    ...(channel ? { ui: { channel, resultTimeoutMs: 1000 } } : {}),
  };
}

function makeInput(surfaces: OUISurface[] | null, observations: Record<string, Record<string, unknown>> = {}): AgentTurnInput {
  return {
    turnId: 'turn-ui',
    conversationId: 'conv',
    userId: 'user-1',
    accountId: 'acct',
    socketRoom: 'agent:turn:turn-ui',
    content: 'take me to create a video production',
    history: [{ role: 'user', content: 'take me to create a video production' }],
    context: surfaces ? { currentPath: '/home', oui: { surfaces, observations } } : { currentPath: '/home' },
  };
}

beforeEach(() => {
  segmentImpls = [];
  seenOpts = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UI tools from the client snapshot', () => {
  it('gives the model one tool per mounted action, and the UI action wins a name over a host tool', async () => {
    const hostNavigate: RegisteredTool = {
      name: 'navigate',
      description: 'host navigate',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({ success: true })),
    };
    const { channel } = makeChannel(() => null);
    segmentImpls = [async () => [{ text: 'ok', toolCalls: [] }]];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel, [hostNavigate]), makeInput([shell, projects]));

    const tools = seenOpts[0].tools;
    expect(Object.keys(tools).sort()).toEqual(['navigate', 'projects_create']);
    expect(tools.navigate.description).toContain('[UI · App Shell]');
    expect(errors.mock.calls.some((c) => String(c[0]).includes('collide with host tools'))).toBe(true);
    errors.mockRestore();
  });

  it('puts the page state on the user message, not in the system prompt', async () => {
    const { channel } = makeChannel(() => null);
    segmentImpls = [async () => [{ text: 'ok', toolCalls: [] }]];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, home], { home: { characters: 6 } }));

    const last = seenOpts[0].messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('<page_state>');
    expect(String(last.content)).toContain('App Shell (app-shell)');
    expect(String(last.content)).toContain('"characters":6');
  });

  it('refuses a turn that carries surfaces when there is no channel to answer them', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await expect(runAgentTurn(makeConfig(undefined), makeInput([shell]))).rejects.toThrow(/no UI action channel/);
  });

  it('stops the turn after any tool that asks the user', async () => {
    const { channel } = makeChannel(() => null);
    segmentImpls = [async () => [{ text: 'ok', toolCalls: [] }]];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell]));
    expect(seenOpts[0].stopWhen).toEqual(
      expect.arrayContaining(['hasToolCall(present_options)', 'hasToolCall(confirm_action)', 'hasToolCall(request_user_decision)']),
    );
  });
});

describe('a UI action is answered', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the request to the turn room with the tool call id, and returns the real result', async () => {
    // The clock stands still, so the first wait is the whole result window: the
    // worker takes its deadline before it dispatches and measures what is left
    // after, and a millisecond passing in between made it 999 (a flake on CI).
    vi.useFakeTimers({ toFake: ['Date'] });
    const { channel, dispatched } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      data: { navigatedTo: '/media-projects' },
      timestamp: 1,
      surfaces: [shell, home],
      settled: true,
    }));
    let modelSaw = '';
    segmentImpls = [
      async (opts) => {
        modelSaw = await opts.tools.navigate.execute({ path: '/media-projects' }, { toolCallId: 'call-1' });
        return [{ text: 'done', toolCalls: [{ toolName: 'navigate', toolCallId: 'call-1' }] }];
      },
    ];

    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, home]));

    expect(dispatched).toEqual([
      {
        room: 'agent:turn:turn-ui',
        request: expect.objectContaining({ requestId: 'call-1', surfaceId: 'app-shell', actionId: 'navigate', params: { path: '/media-projects' } }),
      },
    ]);
    expect(channel.awaitResult).toHaveBeenCalledWith('call-1', expect.objectContaining({ userId: 'user-1', timeoutMs: 1000 }));
    expect(JSON.parse(modelSaw)).toMatchObject({ result: { navigatedTo: '/media-projects' }, page: { surfaces: ['App Shell', 'Home'] } });
  });

  it('reports a rejected action as a failure with the page\'s error, not a success', async () => {
    const { channel } = makeChannel((req) => ({
      requestId: req.requestId,
      success: false,
      error: { code: 'UNKNOWN_ROUTE', message: "'/productions/new' is not a route in this application." },
      timestamp: 1,
      surfaces: [shell, home],
    }));
    let modelSaw = '';
    segmentImpls = [
      async (opts) => {
        modelSaw = await opts.tools.navigate.execute({ path: '/productions/new' }, { toolCallId: 'call-2' });
        return [{ text: '', toolCalls: [{ toolName: 'navigate', toolCallId: 'call-2' }] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, home]));

    const parsed = JSON.parse(modelSaw);
    expect(parsed.error).toMatchObject({ code: 'UNKNOWN_ROUTE' });
    expect(JSON.stringify(parsed)).toContain('is not a route');
  });

  it('says the page did not answer when no result arrives, instead of claiming success', async () => {
    const { channel } = makeChannel(() => null);
    let modelSaw = '';
    segmentImpls = [
      async (opts) => {
        modelSaw = await opts.tools.navigate.execute({ path: '/x' }, { toolCallId: 'call-3' });
        return [{ text: '', toolCalls: [{ toolName: 'navigate', toolCallId: 'call-3' }] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell]));
    expect(modelSaw).toContain('did not answer');
  });

  it('does not cap UI actions at the two-call backend side-effect quota', async () => {
    const { channel } = makeChannel((req) => ({ requestId: req.requestId, success: true, timestamp: 1, surfaces: [shell] }));
    const outputs: string[] = [];
    segmentImpls = [
      async (opts) => {
        for (let i = 0; i < 4; i++) outputs.push(await opts.tools.navigate.execute({ path: `/p${i}` }, { toolCallId: `q-${i}` }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell]));
    expect(outputs.every((o) => !o.includes('quotaExceeded'))).toBe(true);
  });
});

describe('the tool set follows the page', () => {
  it('after a navigation that changes the page, continues the same turn with the new page\'s tools', async () => {
    const { channel } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      data: { navigatedTo: '/media-projects' },
      timestamp: 1,
      surfaces: [shell, projects],
    }));
    let modelSawNav = '';
    let stopAfterNav: boolean[] = [];
    segmentImpls = [
      async (opts) => {
        modelSawNav = await opts.tools.navigate.execute({ path: '/media-projects' }, { toolCallId: 'nav' });
        stopAfterNav = opts.stopWhen.filter((c): c is () => boolean => typeof c === 'function').map((c) => c());
        return [{ text: 'On it.', toolCalls: [{ toolName: 'navigate', toolCallId: 'nav' }] }];
      },
      async (opts) => {
        await opts.tools.projects_create.execute({}, { toolCallId: 'create' });
        return [{ text: 'Created.', toolCalls: [{ toolName: 'projects_create', toolCallId: 'create' }] }];
      },
    ];

    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(makeConfig(channel), makeInput([shell, home]));

    expect(stopAfterNav).toContain(true);
    expect(JSON.parse(modelSawNav).page.toolsAdded).toEqual(['projects_create']);
    expect(seenOpts).toHaveLength(2);
    expect(Object.keys(seenOpts[1].tools).sort()).toEqual(['navigate', 'projects_create']);
    // The second segment continues the conversation, including the first segment's response.
    expect(seenOpts[1].messages.length).toBeGreaterThan(seenOpts[0].messages.length);
    expect(result.rounds).toBe(2);
    expect(result.newMessages.filter((m) => m.role === 'tool').map((m) => m.name)).toEqual(['navigate', 'projects_create']);
  });

  it('does not start a new segment when the page did not change', async () => {
    const { channel } = makeChannel((req) => ({ requestId: req.requestId, success: true, timestamp: 1, surfaces: [shell, home] }));
    segmentImpls = [
      async (opts) => {
        await opts.tools.navigate.execute({ path: '/home' }, { toolCallId: 'n' });
        return [{ text: 'Already here.', toolCalls: [{ toolName: 'navigate', toolCallId: 'n' }] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, home]));
    expect(seenOpts).toHaveLength(1);
  });
});

describe('the client snapshot', () => {
  it('is read from context.oui, and a malformed one is an error rather than "no UI"', () => {
    expect(readClientSnapshot({ currentPath: '/x' })).toBeNull();
    expect(readClientSnapshot({ oui: { surfaces: [shell] } })).toEqual({ surfaces: [shell], observations: {} });
    expect(() => readClientSnapshot({ oui: { surfaces: [{ id: 'x' }] } })).toThrow(/not an OUI surface manifest/);
    expect(() => readClientSnapshot({ oui: 'nope' })).toThrow(/must be an object/);
  });

  it('is removed from the context that prompts render', () => {
    expect(withoutClientSnapshot({ currentPath: '/x', oui: { surfaces: [] } })).toEqual({ currentPath: '/x' });
  });
});
