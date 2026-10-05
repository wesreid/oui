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
import { readClientPage, withoutClientSnapshot } from '../ui/snapshot.js';
import { pageOf } from './support/page.js';

// ─── Mock the `ai` module ────────────────────────────────────────────────────

type StreamOpts = {
  tools: Record<string, { execute: (args: unknown, o: { toolCallId: string }) => Promise<string>; description: string }>;
  messages: Array<{ role: string; content: unknown }>;
  stopWhen: unknown[];
  prepareStep: (o: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>;
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
  it('gives the model three UI tools whatever the page offers, and the page wins an action id over a host tool', async () => {
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

    // The model's tools do not grow with the page: it gets the index on the
    // message, and three tools to work it with (ADR-0245 §2.2).
    const tools = seenOpts[0].tools;
    expect(Object.keys(tools).sort()).toEqual(['ui_act', 'ui_describe', 'ui_read']);
    const message = String(seenOpts[0].messages.at(-1)!.content);
    expect(message).toContain('- navigate: Go to a page (takes path: string)');
    expect(message).toContain('- projects_create: Create a project (takes nothing)');
    // The host's `navigate` would be a second thing with the action's id: withheld.
    expect(errors.mock.calls.some((c) => String(c[0]).includes('Host tools collide with UI tools or action ids'))).toBe(true);
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
        modelSaw = await opts.tools.ui_act.execute({ action: 'navigate', input: { path: '/media-projects' } }, { toolCallId: 'call-1' });
        return [{ text: 'done', toolCalls: [{ toolName: 'ui_act', toolCallId: 'call-1' }] }];
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
        modelSaw = await opts.tools.ui_act.execute({ action: 'navigate', input: { path: '/productions/new' } }, { toolCallId: 'call-2' });
        return [{ text: '', toolCalls: [{ toolName: 'ui_act', toolCallId: 'call-2' }] }];
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
        modelSaw = await opts.tools.ui_act.execute({ action: 'navigate', input: { path: '/x' } }, { toolCallId: 'call-3' });
        return [{ text: '', toolCalls: [{ toolName: 'ui_act', toolCallId: 'call-3' }] }];
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
        for (let i = 0; i < 4; i++) outputs.push(await opts.tools.ui_act.execute({ action: 'navigate', input: { path: `/p${i}` } }, { toolCallId: `q-${i}` }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell]));
    expect(outputs.every((o) => !o.includes('quotaExceeded'))).toBe(true);
  });
});

describe('a turn of many actions (session 24611234)', () => {
  const editor: OUISurface = {
    id: 'editor',
    name: 'Editor',
    description: 'A slide editor',
    actions: [
      {
        id: 'set_slot',
        description: 'Set one slot of a slide',
        input: {
          type: 'object',
          properties: { slide: { type: 'integer' }, slot: { type: 'string' }, value: { type: 'string' } },
          required: ['slide', 'slot', 'value'],
        },
      },
    ],
  };
  // The page as every answer reports it: some thousands of characters after it is fitted, as the editor's was.
  const slides = Array.from({ length: 12 }, (_, i) => ({ id: `slide-${i}`, number: i + 2, title: `Chapter ${i + 2} `.repeat(30) }));
  const answer = (req: OUIActionRequest): OUIActionResult => ({
    requestId: req.requestId,
    success: true,
    timestamp: 1,
    data: { changed: [{ list: 'slides', ref: `slide-${(req.params as { slide: number }).slide}` }] },
    surfaces: [editor],
    observations: { editor: { slides } },
  });
  const fill = (slide: number, slot: string) => ({ action: 'set_slot', input: { slide, slot, value: `${slot} of ${slide}` } });

  it('runs one action as often as the work needs: 12 slides of 3 slots is 36 calls, none refused', async () => {
    const { channel, dispatched } = makeChannel(answer);
    const outputs: string[] = [];
    segmentImpls = [
      async (opts) => {
        let n = 0;
        for (let slide = 0; slide < 12; slide++)
          for (const slot of ['number', 'title', 'description'])
            outputs.push(await opts.tools.ui_act.execute(fill(slide, slot), { toolCallId: `fill-${n++}` }));
        return [{ text: 'Filled.', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([editor], { editor: { slides } }));
    expect(dispatched).toHaveLength(36);
    expect(outputs.filter((o) => o.includes('quotaExceeded') || o.includes('repeatedCall'))).toEqual([]);
  });

  it('runs the same call as often as each run changes the page: undo five times is five undos', async () => {
    let version = 0;
    const { channel, dispatched } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      timestamp: 1,
      surfaces: [editor],
      observations: { editor: { slides, version: ++version } },
    }));
    const outputs: string[] = [];
    segmentImpls = [
      async (opts) => {
        for (let i = 0; i < 5; i++) outputs.push(await opts.tools.ui_act.execute(fill(3, 'undo'), { toolCallId: `undo-${i}` }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([editor], { editor: { slides } }));
    expect(dispatched).toHaveLength(5);
    expect(outputs.filter((o) => o.includes('repeatedCall'))).toEqual([]);
  });

  it('refuses an identical call that keeps changing nothing: on its fourth when the page says so, and says why', async () => {
    const { channel, dispatched } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      timestamp: 1,
      data: { changed: [] },
      surfaces: [editor],
      observations: { editor: { slides } },
    }));
    const outputs: string[] = [];
    segmentImpls = [
      async (opts) => {
        for (let i = 0; i < 4; i++) outputs.push(await opts.tools.ui_act.execute(fill(3, 'title'), { toolCallId: `same-${i}` }));
        outputs.push(await opts.tools.ui_act.execute(fill(3, 'number'), { toolCallId: 'other' }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([editor], { editor: { slides } }));
    expect(dispatched).toHaveLength(4);
    const fourth = JSON.parse(outputs[3]);
    expect(fourth).toMatchObject({ repeatedCall: true });
    expect(fourth.error).toContain('has changed nothing the last 3 times it ran in this turn');
    expect(JSON.parse(outputs[4]).repeatedCall).toBeUndefined();
  });

  it('judges by the page’s state when the answer does not say: the same page after each run, refused on the fifth', async () => {
    const { channel, dispatched } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      timestamp: 1,
      surfaces: [editor],
      observations: { editor: { slides } },
    }));
    const outputs: string[] = [];
    segmentImpls = [
      async (opts) => {
        for (let i = 0; i < 5; i++) outputs.push(await opts.tools.ui_act.execute(fill(3, 'zoom'), { toolCallId: `zoom-${i}` }));
        return [{ text: '', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([editor], { editor: { slides } }));
    expect(dispatched).toHaveLength(4);
    expect(JSON.parse(outputs[4])).toMatchObject({ repeatedCall: true });
  });

  it('sends the page’s state with the newest answer only: 20 actions cost about what one does, plus what each did', async () => {
    const { channel } = makeChannel(answer);
    let one = 0;
    let twenty = 0;
    let sent: Array<{ role: string; content: unknown }> = [];
    segmentImpls = [
      async (opts) => {
        const messages: Array<{ role: string; content: unknown }> = [...opts.messages];
        for (let i = 0; i < 20; i++) {
          const id = `step-${i}`;
          const input = fill(i % 12, i < 12 ? 'title' : 'description');
          const text = await opts.tools.ui_act.execute(input, { toolCallId: id });
          messages.push(
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'ui_act', input }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'ui_act', output: { type: 'text', value: text } }] },
          );
          const prepared = await opts.prepareStep({ steps: [], messages });
          sent = (prepared.messages ?? messages) as typeof sent;
          if (i === 0) one = JSON.stringify(sent).length;
        }
        twenty = JSON.stringify(sent).length;
        return [{ text: 'Done.', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([editor], { editor: { slides } }));

    const answers = sent
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse((m.content as Array<{ output: { value: string } }>)[0].output.value));
    const { SUPERSEDED_STATE } = await import('../ui/newest-page-state.js');
    // The newest answer has the page; every earlier one says where it is, and keeps what it did.
    expect(JSON.stringify(answers[19].state)).toContain('Chapter');
    for (const earlier of answers.slice(0, 19)) {
      expect(earlier.state).toBe(SUPERSEDED_STATE);
      expect(earlier.result.changed[0].list).toBe('slides');
    }
    // Twenty answers add only what each did: far less than twenty pages.
    const page = JSON.stringify(answers[19].state).length;
    expect(page).toBeGreaterThan(3_000);
    // With every page kept, the nineteen later answers would add nineteen pages.
    expect(twenty - one).toBeLessThan(19 * 1_000);
    expect(twenty - one).toBeLessThan((19 * page) / 4);
  });
});

describe('work an action starts', () => {
  const studio: OUISurface = {
    id: 'room:vector-studio',
    name: 'Vector studio',
    description: 'graphics',
    actions: [
      {
        id: 'vector_generate_picture',
        description: 'Generate a picture',
        input: { type: 'object', properties: {} },
        async: true,
        // Up to 16 min: a picture can wait behind a live conversation.
        polling: { intervalMs: 1000, maxDurationMs: 960_000 },
      },
      { id: 'vector_cancel_generation', description: 'Cancel a picture', input: { type: 'object', properties: {} } },
    ],
  };

  it('is reported still running once the call’s budget is spent, and the turn goes on and ends: the person can cancel it in the same turn', async () => {
    const dispatched: string[] = [];
    const finalWaits: number[] = [];
    const channel: UIActionChannel = {
      dispatch: vi.fn(async (_room, request) => void dispatched.push(request.actionId)),
      awaitResult: vi.fn(async (requestId, opts) => {
        if (opts.final) {
          finalWaits.push(opts.timeoutMs);
          // The job runs for a minute: nothing arrives within the wait.
          await new Promise((r) => setTimeout(r, opts.timeoutMs));
          return null;
        }
        return requestId === 'call-gen'
          ? { requestId, success: true, interim: true, data: { status: 'started', jobId: 'job-1' }, timestamp: 1 }
          : { requestId, success: true, data: { cancelled: 'job-1' }, timestamp: 2 };
      }),
    };
    let generated = '';
    let cancelled = '';
    segmentImpls = [
      async (opts) => {
        generated = await opts.tools.ui_act.execute({ action: 'vector_generate_picture', input: {} }, { toolCallId: 'call-gen' });
        cancelled = await opts.tools.ui_act.execute({ action: 'vector_cancel_generation', input: {} }, { toolCallId: 'call-cancel' });
        return [{ text: 'Started it, then cancelled it as you asked.', toolCalls: [] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    const config = makeConfig(channel);
    config.ui = { ...config.ui!, jobWaitMs: 50 };
    const began = Date.now();
    const result = await runAgentTurn(config, makeInput([studio]));

    expect(Date.now() - began).toBeLessThan(5_000);
    expect(finalWaits).toHaveLength(1);
    expect(finalWaits[0]).toBeLessThanOrEqual(50);
    expect(JSON.parse(generated)).toMatchObject({ status: 'running', result: { status: 'started', jobId: 'job-1' } });
    expect(JSON.parse(cancelled)).toMatchObject({ result: { cancelled: 'job-1' } });
    expect(dispatched).toEqual(['vector_generate_picture', 'vector_cancel_generation']);
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: 'Started it, then cancelled it as you asked.' });
  });
});

describe('the index follows the page', () => {
  it('after a navigation that changes the page, the answer carries the new page\'s index and the turn carries on in it', async () => {
    const { channel, dispatched } = makeChannel((req) => ({
      requestId: req.requestId,
      success: true,
      data: { navigatedTo: '/media-projects' },
      timestamp: 1,
      surfaces: [shell, projects],
    }));
    let modelSawNav = '';
    let modelSawCreate = '';
    let stopAfterNav: boolean[] = [];
    segmentImpls = [
      async (opts) => {
        modelSawNav = await opts.tools.ui_act.execute({ action: 'navigate', input: { path: '/media-projects' } }, { toolCallId: 'nav' });
        stopAfterNav = opts.stopWhen.filter((c): c is () => boolean => typeof c === 'function').map((c) => c());
        // The same response carries on: the action is looked up in the page as it is now.
        modelSawCreate = await opts.tools.ui_act.execute({ action: 'projects_create', input: {} }, { toolCallId: 'create' });
        return [
          { text: 'On it.', toolCalls: [{ toolName: 'ui_act', toolCallId: 'nav' }] },
          { text: 'Created.', toolCalls: [{ toolName: 'ui_act', toolCallId: 'create' }] },
        ];
      },
    ];

    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(makeConfig(channel), makeInput([shell, home]));

    // The model's tools did not change, so nothing stops the turn for a new set of them.
    expect(stopAfterNav).not.toContain(true);
    expect(seenOpts).toHaveLength(1);
    const nav = JSON.parse(modelSawNav);
    expect(nav.page.nowOffers).toContain('Projects (projects-library): projects');
    expect(nav.page.nowOffers).toContain('- projects_create: Create a project (takes nothing)');
    expect(nav.page.noLongerOnScreen).toEqual(['Home']);
    expect(JSON.parse(modelSawCreate)).toMatchObject({ page: { surfaces: ['App Shell', 'Projects'] } });
    expect(dispatched.map((d) => d.request.actionId)).toEqual(['navigate', 'projects_create']);
    expect(result.rounds).toBe(2);
    expect(result.newMessages.filter((m) => m.role === 'tool').map((m) => m.name)).toEqual(['ui_act', 'ui_act']);
  });

  it('refuses an action the page does not offer, naming what is near', async () => {
    const { channel, dispatched } = makeChannel(() => null);
    let modelSaw = '';
    segmentImpls = [
      async (opts) => {
        modelSaw = await opts.tools.ui_act.execute({ action: 'projects', input: {} }, { toolCallId: 'x' });
        return [{ text: '', toolCalls: [{ toolName: 'ui_act', toolCallId: 'x' }] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, projects]));
    expect(JSON.parse(modelSaw)).toMatchObject({ success: false, notRun: true });
    expect(modelSaw).toContain('is not an action of the page as it is now');
    expect(modelSaw).toContain('projects_create');
    expect(dispatched).toEqual([]);
  });

  it('names nothing new when the page did not change', async () => {
    const { channel } = makeChannel((req) => ({ requestId: req.requestId, success: true, timestamp: 1, surfaces: [shell, home] }));
    segmentImpls = [
      async (opts) => {
        await opts.tools.ui_act.execute({ action: 'navigate', input: { path: '/home' } }, { toolCallId: 'n' });
        return [{ text: 'Already here.', toolCalls: [{ toolName: 'ui_act', toolCallId: 'n' }] }];
      },
    ];
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(makeConfig(channel), makeInput([shell, home]));
    expect(seenOpts).toHaveLength(1);
  });
});

describe('the client snapshot', () => {
  it('is read from context.oui, and a malformed one is an error rather than "no UI"', () => {
    expect(readClientPage({ currentPath: '/x' })).toBeNull();
    // A client that sends definitions gives the same page as one that sends an index, and its definitions with it.
    const full = readClientPage({ oui: { surfaces: [shell] } })!;
    expect(full.page).toEqual(pageOf([shell]));
    expect(full.observations).toEqual({});
    expect([...full.held.values()]).toEqual(shell.actions);
    const indexed = readClientPage({ oui: { index: pageOf([shell]) } })!;
    expect(indexed.page).toEqual(full.page);
    expect(indexed.held.size).toBe(0);
    expect(() => readClientPage({ oui: { surfaces: [{ id: 'x' }] } })).toThrow(/not an OUI surface manifest/);
    expect(() => readClientPage({ oui: { index: [{ id: 'x' }] } })).toThrow(/not an OUI surface index/);
    expect(() => readClientPage({ oui: {} })).toThrow(/as index\[\] or surfaces\[\]/);
    expect(() => readClientPage({ oui: 'nope' })).toThrow(/must be an object/);
  });

  it('is removed from the context that prompts render', () => {
    expect(withoutClientSnapshot({ currentPath: '/x', oui: { surfaces: [] } })).toEqual({ currentPath: '/x' });
  });
});
