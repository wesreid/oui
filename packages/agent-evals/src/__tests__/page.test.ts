/**
 * What nova-api's DEOS suite (#718) needed of the harness, end to end through
 * the SDK's own turn runner and a model scripted through OpenAI's real
 * provider package, recorded and then replayed:
 *
 * - a page that answers: a fixture surface runtime, from the suite's own
 *   surfaces or from the product's manifest, that navigates and filters, and
 *   sends each turn from where it went;
 * - a call no tool ran (the page's action called as if it were a tool) no
 *   longer breaks the next turn;
 * - the product's own history window is what later turns read;
 * - the agent's provider options reach the model;
 * - call counts, token budgets, the prompt cache's share and choice buttons
 *   are assertions of the suite;
 * - a judge that answers no verdict is asked again, and one that never does
 *   is reported apart from a failure.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import { loadBuiltinTools, type RegisteredTool } from '@ouispec/agent-worker';
import {
  deriveInputSchema,
  LOCATION_OBSERVATION_ID,
  NAVIGATE_ACTION_ID,
  NAVIGATION_SURFACE_ID,
  toolName,
  type OuiManifest,
} from '@ouispec/bindings';
import type { AgentEvalPage, AgentEvalSuite } from '@ouispec/contract';
import { runEvals, type EvalReport } from '../run.js';
import { createMemoryHistory } from '../memory.js';
import { createFixturePage, EvalPageError } from '../page.js';
import { formatReport, junitReport } from '../report.js';
import { JUDGE_INSTRUCTIONS } from '../judge.js';
import { agent, backendCalls, configFor, recordWith, scratch, TOOLS } from './support.js';

const dirs: Array<() => void> = [];
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};
afterAll(() => dirs.forEach((cleanup) => cleanup()));
beforeEach(() => {
  backendCalls.length = 0;
});

// ─── The model's side ────────────────────────────────────────────────────────

const lastUser = (request: ChatRequest) => {
  const said = [...conversationOf(request)].reverse().find((m) => m.role === 'user');
  return said ? messageText(said) : '';
};
const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};
/** The page's index and state, as the model was sent them: after the system prompt, and after the conversation. */
const pageText = (request: ChatRequest) => request.messages.map((m) => messageText(m)).join('\n');
const isJudge = (request: ChatRequest) => request.messages.some((m) => m.role === 'system' && String(m.content).startsWith(JUDGE_INSTRUCTIONS.slice(0, 40)));
const act = (id: string, action: string, input?: Record<string, unknown>) => ({ id, name: 'ui_act', args: { action, ...(input ? { input } : {}) } });

const PRESENT_OPTIONS = loadBuiltinTools().filter((t) => t.name === 'present_options');
const withChoices = (): RegisteredTool[] => [...TOOLS, ...PRESENT_OPTIONS];

// ─── A page declared in the suite ────────────────────────────────────────────

const LANE_PAGE: AgentEvalPage = {
  at: '/home',
  surfaces: [
    {
      id: 'page:home',
      name: 'Home',
      description: 'What needs doing first.',
      routes: ['/home'],
      state: { state: { firstThing: 'Declined work: 4 repair orders' } },
      actions: [{ id: 'home_refresh', description: 'Reloads the Home.', effect: 'view' }],
    },
    {
      id: 'page:lane',
      name: 'Service lane',
      description: 'Repair orders by lane, filtered.',
      routes: ['/lane'],
      state: { state: { view: 'open', advisor: null } },
      actions: [
        {
          id: 'lane_view',
          description: 'Shows one view of the lane.',
          effect: 'view',
          input: { type: 'object', properties: { value: { enum: ['open', 'declined'] } }, required: ['value'], additionalProperties: false },
          cases: [{ when: { value: 'declined' }, result: { success: true, data: { view: 'declined', rows: 4 } }, state: { state: { view: 'declined', advisor: null } } }],
        },
        {
          id: 'lane_advisor',
          description: 'Filters the lane to one advisor.',
          effect: 'view',
          input: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
          state: { state: { view: 'declined', advisor: 'Avery Thackeray' } },
        },
      ],
    },
  ],
};

const LANE_SUITE: AgentEvalSuite = {
  version: 1,
  name: 'lane',
  page: LANE_PAGE,
  scenarios: [
    {
      id: 'navigates-and-filters',
      title: 'Opens the lane once, sets its view, then filters it, and pastes nothing',
      turns: [
        {
          user: 'Show me the declined work',
          expect: {
            page: {
              at: '/lane',
              ran: [{ action: 'app.navigate', input: { path: '/lane' } }, { action: 'lane_view', input: { value: 'declined' } }],
            },
            calls: [
              { action: 'app.navigate', times: 1 },
              { action: 'lane_view', args: { value: 'declined' } },
              { tool: 'lookup', times: 0 },
            ],
            usage: { modelCalls: { max: 3 }, firstCallInputTokens: { max: 20000 }, callInputTokens: { max: 40000 } },
            says: ['declined work'],
          },
        },
        {
          user: "Only Avery's",
          expect: {
            page: { at: '/lane', ran: [{ action: 'lane_advisor', input: { value: 'Avery Thackeray' } }], notRan: ['app_navigate'] },
            calls: [{ action: 'app_navigate', times: 0 }],
            usage: { cachedShare: { min: 0.6 } },
          },
        },
      ],
    },
  ],
};

/** A model that works the lane as the suite asks, its second turn reading most of its input from the cache. */
function laneModel(request: ChatRequest): ScriptedReply | undefined {
  const said = lastUser(request);
  const answered = lastTool(request);
  if (said.includes('declined work')) {
    if (answered === null) return { toolCalls: [act('call_nav', 'app_navigate', { path: '/lane' })] };
    if (answered.includes('navigatedTo')) return { toolCalls: [act('call_view', 'lane_view', { value: 'declined' })] };
    return { text: 'The service lane is open on its declined work.' };
  }
  if (said.includes('Avery')) {
    const usage = { inputTokens: 10000, cachedInputTokens: 8000 };
    // Sent from the lane, its declined view set: the page the first turn left it on.
    if (!pageText(request).includes('lane_advisor')) return { text: 'I am not on the lane.', usage };
    if (answered === null) return { toolCalls: [act('call_avery', 'lane_advisor', { value: 'Avery Thackeray' })], usage };
    return { text: 'Now only Avery Thackeray’s declined work.', usage };
  }
  return undefined;
}

describe('a page declared in the suite', () => {
  const cassettes = tempDir();
  const config = () => configFor(cassettes, { suites: [LANE_SUITE], channels: { web_chat: {} } });
  let recorded: { result: EvalReport; requests: ChatRequest[] };

  it('answers the agent’s page actions: it navigates, runs what is there, and sends the next turn from where it went', async () => {
    recorded = await recordWith(laneModel, () => runEvals(config(), { mode: 'record' }));
    const [lane] = recorded.result.cases;
    expect(lane.failures).toEqual([]);
    expect(lane.turns[0].page).toEqual({
      at: '/lane',
      ran: [
        { action: 'app_navigate', id: NAVIGATE_ACTION_ID, surface: NAVIGATION_SURFACE_ID, input: { path: '/lane' }, at: '/home' },
        { action: 'lane_view', id: 'lane_view', surface: 'page:lane', input: { value: 'declined' }, at: '/lane' },
      ],
    });
    // The model was told what the page then offered and showed, from the page's own answers.
    const afterView = recorded.requests.find((r) => lastTool(r)?.includes('"rows":4'));
    expect(afterView).toBeDefined();
    // The second turn was sent from the lane, its view as the first turn left it.
    const second = recorded.requests.find((r) => lastUser(r).includes('Avery'))!;
    expect(pageText(second)).toContain('lane_advisor');
    expect(pageText(second)).toContain('declined');
    expect(pageText(second)).not.toContain('home_refresh');
    expect(lane.turns[1].usage).toMatchObject({ inputTokens: 20000, cacheReadTokens: 16000, cachedShare: 0.8, firstCallInputTokens: 10000 });
    expect(backendCalls).toEqual([]);
  });

  it('replays the same page from the recording', async () => {
    const report = await runEvals(config());
    expect(report.cases.map((c) => [c.status, c.failures])).toEqual([['passed', []]]);
  });

  it('fails the counts, the page and the budgets a turn breaks, each by name', async () => {
    const strict: AgentEvalSuite = {
      ...LANE_SUITE,
      scenarios: [
        {
          ...LANE_SUITE.scenarios[0],
          turns: [
            {
              user: 'Show me the declined work',
              expect: {
                page: { at: '/home', ran: [{ action: 'lane_advisor' }], notRan: ['*'] },
                calls: [{ action: 'app.navigate', times: 0 }, { tool: 'lookup', min: 1 }],
                usage: { modelCalls: { max: 2 }, firstCallInputTokens: { max: 100 }, callInputTokens: { max: 400 }, outputTokens: { max: 10 } },
              },
            },
            { user: "Only Avery's", expect: { usage: { cachedShare: { min: 0.9 } } } },
          ],
        },
      ],
    };
    const dir = tempDir();
    const strictConfig = configFor(dir, { suites: [strict], channels: { web_chat: {} } });
    await recordWith(laneModel, () => runEvals(strictConfig, { mode: 'record' }));
    const [lane] = (await runEvals(strictConfig)).cases;
    expect(lane.status).toBe('failed');
    expect(lane.failures.map((f) => [f.turn, f.assertion, f.kind])).toEqual([
      [0, 'calls', 'assertion'],
      [0, 'calls', 'assertion'],
      [0, 'usage.modelCalls', 'assertion'],
      [0, 'usage.firstCallInputTokens', 'assertion'],
      [0, 'usage.outputTokens', 'assertion'],
      [0, 'usage.callInputTokens', 'assertion'],
      [0, 'page.at', 'assertion'],
      [0, 'page.ran', 'assertion'],
      [0, 'page.notRan', 'assertion'],
      [1, 'usage.cachedShare', 'assertion'],
    ]);
    const message = (assertion: string) => lane.failures.find((f) => f.assertion === assertion)!.message;
    expect(message('calls')).toBe(
      'the page\'s action app.navigate was called 1 time, not 0; the agent called ui_act app_navigate {"path":"/lane"}; ui_act lane_view {"value":"declined"}',
    );
    expect(message('usage.modelCalls')).toBe('the turn used 3 model calls, not at most 2');
    expect(message('usage.callInputTokens')).toBe('call 1 used 500, call 2 used 500, call 3 used 500 input tokens, not at most 400 each');
    expect(message('page.at')).toBe('the page is at /lane, not /home');
    expect(message('usage.cachedShare')).toBe('80% of its input (16,000 of 20,000 tokens) was read from the prompt cache, not at least 90%');
  });

  it('refuses a page that cannot be built, and a turn held to a page in a scenario with none', async () => {
    expect(() => createFixturePage({ at: '/', controls: { 'a.b': {} } })).toThrow(EvalPageError);
    expect(() => createFixturePage({ at: '/', controls: { 'a.b': {} } })).toThrow(/no manifest/);
    const noPage: AgentEvalSuite = { version: 1, name: 'x', scenarios: [{ id: 'a', title: 'a', page: false, turns: [{ user: 'hi', expect: { page: { at: '/' } } }] }] };
    await expect(runEvals(configFor(tempDir(), { suites: [noPage] }))).rejects.toThrow(/the scenario has no page to hold to it/);
  });
});

// ─── The product's own controls, from its manifest ───────────────────────────

const control = (id: string, surface: string, kind: 'tabs' | 'choice' | 'text' | 'button', title: string, options?: string[]) => ({
  name: toolName(id),
  id,
  source: 'control' as const,
  control: kind,
  title,
  description: title,
  effect: 'view' as const,
  input: deriveInputSchema(kind, options ? { options: options.map((value) => ({ value, title: value })) } : {}),
  reach: [],
  declaredIn: `${surface}.tsx`,
});

const ROUTES = ['/dashboard', '/dashboard/service-lane'];
const MANIFEST: OuiManifest = {
  version: 1,
  buildId: 'eval',
  surfaces: [
    {
      id: NAVIGATION_SURFACE_ID,
      kind: 'navigation',
      title: 'Pages',
      description: 'Every page of the app, by its address, and the page the person is on.',
      routes: ROUTES,
      actions: [
        {
          name: toolName(NAVIGATE_ACTION_ID),
          id: NAVIGATE_ACTION_ID,
          source: 'navigation',
          title: 'Go to a page',
          description: `Go to a page of the app. The pages: ${ROUTES.join(', ')}.`,
          input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
          reach: [],
        },
      ],
      observations: [{ id: LOCATION_OBSERVATION_ID, description: 'Where the person is.', schema: { type: 'object' } }],
    },
    {
      id: 'page:dashboard',
      kind: 'page',
      title: 'Home',
      description: 'The Home.',
      routes: ['/dashboard'],
      actions: [control('dashboard.search', 'dashboard', 'text', 'Search')],
      observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
    },
    {
      id: 'page:service-lane',
      kind: 'page',
      title: 'Service lane',
      description: 'Repair orders, by view and advisor.',
      routes: ['/dashboard/service-lane'],
      actions: [
        control('service-lane.view', 'service-lane', 'tabs', 'View', ['open', 'declined']),
        control('service-lane.declined.advisor', 'service-lane', 'choice', 'Advisor', ['Avery Thackeray', 'Jordan Lee']),
      ],
      observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
    },
  ],
};

describe('a page of the product’s own controls, from its manifest', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'manifest',
    page: { at: '/dashboard', allControls: true, controls: { 'service-lane.view': { value: 'open' }, 'service-lane.declined.advisor': {} } },
    scenarios: [
      {
        id: 'opens-the-lane-declined',
        title: 'Goes to the service lane and sets its view with the lane’s own control',
        turns: [
          {
            user: 'Show me the declined work',
            expect: {
              page: { at: '/dashboard/service-lane', ran: [{ action: 'service-lane.view', input: { value: 'declined' } }] },
              calls: [{ action: 'app.navigate', times: 1 }],
            },
          },
        ],
      },
    ],
  };
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const answered = lastTool(request);
    if (answered === null) return { toolCalls: [act('call_nav', 'app_navigate', { path: '/dashboard/service-lane' })] };
    if (answered.includes('navigatedTo')) return { toolCalls: [act('call_view', 'service_lane_view', { value: 'declined' })] };
    return { text: 'The service lane shows its declined work.' };
  };

  it('mounts them as the product’s tab does, at each address, and runs them', async () => {
    const dir = tempDir();
    const config = configFor(dir, { suites: [suite], channels: { web_chat: {} }, page: { manifest: MANIFEST } });
    const { result, requests } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    const [lane] = result.cases;
    expect(lane.failures).toEqual([]);
    // Sent from the Home: its search field (every control, with `allControls`), and none of the lane's.
    expect(pageText(requests[0])).toContain('dashboard_search');
    expect(pageText(requests[0])).not.toContain('service_lane_view');
    // After it went there, the page's answer offered the lane's own controls.
    expect(lastTool(requests[1])).toContain('service_lane_view');
    expect(lane.turns[0].page?.ran.map((r) => [r.id, r.input])).toEqual([
      [NAVIGATE_ACTION_ID, { path: '/dashboard/service-lane' }],
      ['service-lane.view', { value: 'declined' }],
    ]);
    // And the page's state, read after the conversation, shows the value the control took.
    expect(pageText(requests[2])).toContain('"service-lane.view":"declined"');
    expect((await runEvals(config)).failed).toBe(0);
  });

  it('refuses a control the manifest does not declare', async () => {
    const bad: AgentEvalSuite = { ...suite, page: { at: '/dashboard', controls: { 'service-lane.nope': {} } } };
    const [c] = (await runEvals(configFor(tempDir(), { suites: [bad], channels: { web_chat: {} }, page: { manifest: MANIFEST } }), { mode: 'live' })).cases;
    expect(c.failures).toEqual([expect.objectContaining({ turn: -1, assertion: 'page', kind: 'case', message: expect.stringContaining('the manifest declares no control "service-lane.nope"') })]);
  });
});

// ─── A call no tool ran ──────────────────────────────────────────────────────
// (A page's action called as a tool is now run as the `ui_act` call it means;
// a tool the model invents still has no tool to run it.)

describe('a call no tool ran', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'dangling',
    page: LANE_PAGE,
    scenarios: [
      {
        id: 'action-as-a-tool',
        title: 'Calls a tool it was not given, and the next turn still runs',
        turns: [
          { user: 'Show me the declined work', expect: { calls: [{ tool: 'open_page', times: 1 }, { action: 'app.navigate', times: 1 }] } },
          { user: 'yes please', expect: { says: ['still here'] } },
        ],
      },
    ],
  };
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const said = lastUser(request);
    const answered = lastTool(request);
    if (said.includes('yes please')) return { text: 'Yes, still here.' };
    // It names a tool it was not given beside the right call, then works on: the result of a later step was moved up a call before.
    if (answered === null) return { toolCalls: [{ id: 'call_bad', name: 'open_page', args: { path: '/lane' } }, act('call_nav', 'app_navigate', { path: '/lane' })] };
    if (!conversationOf(request).some((m) => m.role === 'tool' && messageText(m).includes('"rows":4'))) return { toolCalls: [act('call_view', 'lane_view', { value: 'declined' })] };
    return { text: 'The lane is open on its declined work.' };
  };

  it('is stored with the error the model was given, and the next turn sends every result after its call', async () => {
    const dir = tempDir();
    const config = configFor(dir, { suites: [suite], channels: { web_chat: {} } });
    const { result, requests } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    const [c] = result.cases;
    expect(c.failures).toEqual([]);
    expect(c.turns[1].reply).toBe('Yes, still here.');
    // The next turn's conversation: every tool call answered right after it, in order.
    const next = requests.find((r) => lastUser(r).includes('yes please'))!;
    const sent = conversationOf(next) as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content?: unknown }>;
    const order = sent.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((t) => `call ${t.id}`) : m.role === 'tool' ? [`result ${m.tool_call_id}`] : []));
    expect(order).toEqual(['call call_bad', 'call call_nav', 'result call_bad', 'result call_nav', 'call call_view', 'result call_view']);
    const bad = sent.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bad')!;
    expect(JSON.parse(messageText(bad as never))).toMatchObject({ success: false, notRun: true });
  });
});

// ─── The product's history window ────────────────────────────────────────────

describe('the product’s own conversation store', () => {
  it('is what a later turn reads: its window, and its step context', async () => {
    const suite: AgentEvalSuite = {
      version: 1,
      name: 'window',
      stubs: { lookup: [{ result: { success: true, data: { stock: 'T1', price: '$10,000', notes: 'x'.repeat(200) } } }] },
      scenarios: [{ id: 'cut', title: 'A cut tool result', turns: [{ user: 'What is the price of T1?' }, { user: 'And again?' }] }],
    };
    const persisted: string[] = [];
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      history: () => {
        const store = createMemoryHistory({
          // The product's window: a tool result over 100 characters is cut, and a summary rides beside the messages.
          window: (messages) => ({
            messages: messages.map((m) => (m.role === 'tool' && m.content.length > 100 ? { ...m, content: '[cut: read it again]' } : m)),
            stepContext: '<summary>The customer asked about T1.</summary>',
          }),
        });
        return {
          ...store,
          persistMessages: async (turn) => {
            persisted.push(turn.turnId);
            return store.persistMessages(turn);
          },
        };
      },
    });
    const script = (request: ChatRequest): ScriptedReply | undefined => {
      if (lastUser(request).includes('And again')) return { text: 'It is $10,000.' };
      return lastTool(request) === null ? { toolCalls: [{ id: 'call_lookup', name: 'lookup', args: { stock: 'T1' } }] } : { text: 'T1 is $10,000.' };
    };
    const { result, requests } = await recordWith(script, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    expect(persisted).toEqual(['eval-cut-web_chat-0', 'eval-cut-web_chat-1']);
    const second = requests.find((r) => lastUser(r).includes('And again'))!;
    expect(conversationOf(second).find((m) => m.role === 'tool')).toMatchObject({ content: '[cut: read it again]' });
    expect(pageText(second)).toContain('<summary>The customer asked about T1.</summary>');
  });
});

// ─── The agent's settings ────────────────────────────────────────────────────

describe('the agent’s own settings', () => {
  it('reach the model: its provider options, and its UI settings', async () => {
    const suite: AgentEvalSuite = { version: 1, name: 'settings', page: LANE_PAGE, scenarios: [{ id: 'hi', title: 'Says hello', turns: [{ user: 'Hello' }] }] };
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      agent: () => ({ ...agent(), modelProviderOptions: { openai: { user: 'eval-provider-options' } }, forcedToolChoice: false, uiActions: { maxIndexChars: 100 } }),
    });
    const { result, requests } = await recordWith(() => ({ text: 'Hello.' }), () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    expect((requests[0] as ChatRequest & { user?: string }).user).toBe('eval-provider-options');
    // The index past 100 characters is listed by action id only.
    expect(pageText(requests[0])).not.toContain('Reloads the Home.');
  });
});

// ─── Choice buttons ──────────────────────────────────────────────────────────

describe('choice buttons', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'choices',
    scenarios: [
      {
        id: 'offers-to-stop-viewing',
        title: 'Offers to stop viewing as Avery',
        turns: [
          {
            user: 'Send the first video in my queue',
            expect: {
              choices: { options: ['Stop viewing', { pattern: 'keep', flags: 'i' }], question: [{ pattern: 'viewing as Avery' }], count: { min: 2, max: 2 } },
              calls: [{ tool: 'present_options', times: 1 }],
            },
          },
          { user: 'Thanks', expect: { choices: false } },
        ],
      },
    ],
  };
  const script = (request: ChatRequest): ScriptedReply | undefined =>
    lastUser(request).includes('Thanks')
      ? { text: 'You are welcome.' }
      : {
          toolCalls: [
            {
              id: 'call_options',
              name: 'present_options',
              args: {
                context: 'Nothing can be changed while viewing as Avery.',
                prompt: 'Stop viewing as Avery to send it yourself?',
                options: [
                  { label: 'Stop viewing', value: 'stop' },
                  { label: 'Keep viewing', value: 'keep' },
                ],
              },
            },
          ],
        };

  it('are read from the turn, with no stub: the SDK’s interaction tools reach no backend', async () => {
    const config = configFor(tempDir(), { suites: [suite], channels: { web_chat: {} }, agent: () => ({ ...agent(), tools: withChoices() }) });
    const { result } = await recordWith(script, () => runEvals(config, { mode: 'record' }));
    const [c] = result.cases;
    expect(c.failures).toEqual([]);
    expect(c.turns[0].choices).toEqual([
      {
        question: 'Nothing can be changed while viewing as Avery.\n\nStop viewing as Avery to send it yourself?',
        options: [
          { label: 'Stop viewing', value: 'stop' },
          { label: 'Keep viewing', value: 'keep' },
        ],
      },
    ]);
  });

  it('fail when missing, or when offered where none should be', async () => {
    const strict: AgentEvalSuite = {
      ...suite,
      scenarios: [{ ...suite.scenarios[0], turns: [{ user: 'Send the first video in my queue', expect: { choices: false } }, { user: 'Thanks', expect: { choices: { options: ['Stop viewing'] } } }] }],
    };
    const config = configFor(tempDir(), { suites: [strict], channels: { web_chat: {} }, agent: () => ({ ...agent(), tools: withChoices() }) });
    const { result } = await recordWith(script, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures.map((f) => [f.turn, f.message])).toEqual([
      [0, 'the turn offered choices: "Stop viewing", "Keep viewing"'],
      [1, 'the turn offered no choices; the agent called no tool'],
    ]);
  });
});

describe('a choice held for a reply (requireReplyBeforeChoice)', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'reply first',
    scenarios: [{ id: 'reply-first', title: 'Says what it found, then offers', turns: [{ user: 'Send the first video in my queue', expect: { choices: { count: { min: 1, max: 1 } }, says: ['viewing as Avery'] } }] }],
  };
  const offer = (id: string) => ({
    id,
    name: 'present_options',
    args: { context: 'Nothing can be changed here.', prompt: 'Stop viewing?', options: [{ label: 'Stop viewing', value: 'stop' }] },
  });
  // First the bare card; told to write first, the reply and the card again.
  const script = (request: ChatRequest): ScriptedReply | undefined =>
    (lastTool(request) ?? '').includes('not written a reply')
      ? { text: 'You are viewing as Avery, so nothing can be sent.', toolCalls: [offer('call_2')] }
      : { toolCalls: [offer('call_1')] };

  it('reaches the turn, and the card it sent back is not counted as offered', async () => {
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      agent: () => ({ ...agent(), tools: withChoices(), requireReplyBeforeChoice: true }),
    });
    const { result, requests } = await recordWith(script, () => runEvals(config, { mode: 'record' }));
    const [c] = result.cases;
    expect(requests.filter((r) => !isJudge(r))).toHaveLength(2);
    expect(c.failures).toEqual([]);
    expect(c.turns[0].reply).toContain('viewing as Avery');
    expect(c.turns[0].choices).toHaveLength(1);
  });
});

// ─── The judge ───────────────────────────────────────────────────────────────

describe('a judge that answers no verdict', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'judge',
    scenarios: [{ id: 'ai', title: 'Says it is an AI', turns: [{ user: 'Are you human?', expect: { says: [{ rubric: 'The reply says it is an AI assistant.' }] } }] }],
  };
  const replying = (judgeAnswers: string[]) => {
    let asked = 0;
    return (request: ChatRequest): ScriptedReply | undefined => {
      if (!isJudge(request)) return { text: "No, I'm Ava, an AI assistant." };
      return { text: judgeAnswers[Math.min(asked++, judgeAnswers.length - 1)] };
    };
  };

  it('is asked again, and its verdict counts once it gives one', async () => {
    const dir = tempDir();
    const config = configFor(dir, { suites: [suite], channels: { web_chat: {} } });
    const { result, requests } = await recordWith(replying(['Sure! The reply', '{"pass": true, "reason": "It says so."}']), () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    expect(requests.filter(isJudge)).toHaveLength(2);
    // The verdict was asked for as structured output.
    expect(JSON.stringify(requests.find(isJudge))).toContain('json_schema');
    expect((await runEvals(config)).cases[0].status).toBe('passed');
  });

  it('is reported as not judged, apart from a case that failed, after every retry', async () => {
    const dir = tempDir();
    const config = configFor(dir, { suites: [suite], channels: { web_chat: {} }, judgeOptions: { retries: 1 } });
    const { result, requests } = await recordWith(replying(['{"pass": tru']), () => runEvals(config, { mode: 'record' }));
    expect(requests.filter(isJudge)).toHaveLength(2);
    const [c] = result.cases;
    expect(c.status).toBe('unjudged');
    expect(c.passed).toBe(false);
    expect(c.failures).toEqual([expect.objectContaining({ kind: 'judge', assertion: 'says', message: expect.stringContaining('could not be judged: the judge gave no verdict in 2 attempts') })]);
    expect(result).toMatchObject({ passed: 0, failed: 0, unjudged: 1 });
    expect(formatReport(result)).toContain('JUDGE  judge › ai [web_chat]');
    expect(formatReport(result).split('\n').at(-1)).toBe('0 passed, 0 failed, 1 not judged (the judge gave no verdict), of 1 (recorded from the live model)');
    expect(junitReport(result)).toContain('<error message="turn 1, not judged, says:');
  });
});
