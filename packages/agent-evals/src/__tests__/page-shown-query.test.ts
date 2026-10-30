/**
 * What nova-api's DEOS suite (#723) still needed of the fixture page, and of
 * the history it reads through:
 *
 * - what a page shows that is not a control (`shown`: the Home's numbers, a
 *   list's cards) and the problems it shows, declared in the fixture, in the
 *   shape the runtime reports them, indexed by `x-rows` and read further with
 *   `ui_read`; the product's displays named as its manifest records them;
 * - a control bound to a query parameter takes its value from the address
 *   (`/dashboard/service-lane?view=declined` selects the declined tab), follows
 *   `app.navigate`'s query, and writes its value back to the address;
 * - the product's `getHistory` is given the turn it reads for.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import {
  defineQuery,
  deriveInputSchema,
  generatedNavigationSurface,
  PROBLEMS_OBSERVATION_ID,
  PROBLEMS_SCHEMA,
  SHOWN_ROWS,
  toolName,
  type OuiManifest,
} from '@ouispec/bindings';
import { OUI_READ_ACTION, OUI_RUNTIME_SURFACE, type OUIActionResult } from 'oui-spec/spec';
import type { AgentEvalPage, AgentEvalShown, AgentEvalSuite } from '@ouispec/contract';
import { runEvals } from '../run.js';
import { createMemoryHistory, type EvalHistoryRequest } from '../memory.js';
import { createFixturePage, EvalPageError, type EvalPage } from '../page.js';
import { agent, backendCalls, configFor, recordWith, scratch } from './support.js';

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

// ─── The product: its manifest, as the generator writes it ───────────────────

const LANE_QUERY = defineQuery({
  view: { values: [{ value: 'lane', label: 'The lane' }, { value: 'declined', label: 'Declined work' }], default: 'lane', description: 'Which repair orders' },
  advisor: { type: 'string', description: 'A service advisor, by name as the lane shows it' },
});

const control = (id: string, surface: string, kind: 'tabs' | 'choice' | 'text', title: string, options?: string[]) => ({
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

const PAGE_OBSERVATIONS = [
  {
    id: 'state',
    description: 'What the page shows.',
    schema: { type: 'object' as const, properties: { shown: { type: 'array' as const, items: { type: 'object' as const }, 'x-rows': { ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] } } } },
  },
  { id: PROBLEMS_OBSERVATION_ID, description: 'What the page cannot show.', schema: PROBLEMS_SCHEMA },
];

const MANIFEST: OuiManifest = {
  version: 1,
  buildId: 'eval',
  surfaces: [
    generatedNavigationSurface([
      { path: '/admin', title: 'Admin' },
      { path: '/dashboard', title: 'Home' },
      { path: '/dashboard/service-lane', title: 'Service lane', query: LANE_QUERY },
    ]),
    {
      id: 'page:dashboard',
      kind: 'page',
      title: 'Home',
      description: 'The Home.',
      routes: ['/dashboard'],
      actions: [control('dashboard.search', 'dashboard', 'text', 'Search')],
      observations: PAGE_OBSERVATIONS,
      displays: [
        { id: 'home.gross', title: 'Gross this month', description: 'The store’s gross, month to date', labels: ['Gross', 'Deals'] },
        { id: 'home.topic', title: 'Topic', description: 'What needs attention', labels: [] },
      ],
    },
    {
      id: 'page:service-lane',
      kind: 'page',
      title: 'Service lane',
      description: 'Repair orders, by view and advisor.',
      routes: ['/dashboard/service-lane'],
      actions: [
        control('service-lane.view', 'service-lane', 'tabs', 'View', ['lane', 'declined']),
        control('service-lane.declined.advisor', 'service-lane', 'choice', 'Advisor', ['Avery Thackeray', 'Jordan Lee']),
      ],
      observations: PAGE_OBSERVATIONS,
      displays: [{ id: 'lane.ro-card', title: 'Repair order', description: 'One repair order', labels: ['Customer', 'Declined'] }],
    },
  ],
};

const ro = (i: number, view: 'lane' | 'declined'): AgentEvalShown => ({
  id: 'lane.ro-card',
  title: `RO ${7000 + i}`,
  facts: { Customer: `Customer ${i}`, Vehicle: '2022 Toyota Camry SE', Advisor: 'Avery Thackeray', ...(view === 'declined' ? { Declined: `$${400 + i}` } : { Status: 'In progress' }) },
  item: { key: `ro-${7000 + i}`, title: `RO ${7000 + i} · Customer ${i}` },
  query: { view },
});

// ─── Reading the page as the agent does ──────────────────────────────────────

let requests = 0;
async function execute(page: EvalPage, surfaceId: string, actionId: string, params: Record<string, unknown>): Promise<OUIActionResult> {
  const requestId = `t${++requests}`;
  await page.channel.dispatch('eval-room', { requestId, surfaceId, actionId, params, timestamp: 0 });
  return (await page.channel.awaitResult(requestId, 1_000))!;
}
const read = async (page: EvalPage, surface: string, observation: string, at?: { path: string; offset?: number; limit?: number }) =>
  (await execute(page, OUI_RUNTIME_SURFACE, OUI_READ_ACTION, { surface, observation, ...at })).data as { value?: unknown; rows?: unknown[]; total?: number };
const stateOf = async (page: EvalPage, surface: string) => (await read(page, surface, 'state')).value as { values?: Record<string, unknown>; shown?: unknown[] };
const navigate = (page: EvalPage, params: Record<string, unknown>) => execute(page, 'app:navigation', 'app_navigate', params);

const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};
const pageText = (request: ChatRequest) => request.messages.map((m) => messageText(m)).join('\n');

// ─── What the product's pages show ───────────────────────────────────────────

describe('what the product’s pages show, declared in the fixture', () => {
  it('is reported in the page state as the runtime reports it: by display, titled as the manifest records it, each fact as text', async () => {
    const page = createFixturePage(
      {
        at: '/dashboard',
        allControls: true,
        shown: [
          { id: 'home.gross', facts: { Gross: '$182k', Deals: 41, Pending: '' } },
          { id: 'home.topic', title: 'Needs attention', facts: { Waiting: '7 customers' }, item: { key: 'needs_attention', title: 'Needs attention' } },
          { id: 'home.topic', title: 'Declined work', facts: { Open: '$12,882' }, item: { key: 'declined', title: 'Declined work' } },
          ro(1, 'lane'),
        ],
      },
      { manifest: MANIFEST },
    );
    expect((await stateOf(page, 'page:dashboard')).shown).toEqual([
      { id: 'home.gross', title: 'Gross this month', facts: { Gross: '$182k', Deals: '41' } },
      { id: 'home.topic', title: 'Needs attention', facts: { Waiting: '7 customers' }, item: { key: 'needs_attention', title: 'Needs attention' } },
      { id: 'home.topic', title: 'Declined work', facts: { Open: '$12,882' }, item: { key: 'declined', title: 'Declined work' } },
    ]);
    // A display the manifest records on another page is shown there, and only there.
    await navigate(page, { path: '/dashboard/service-lane' });
    expect((await stateOf(page, 'page:service-lane')).shown).toEqual([
      { id: 'lane.ro-card', title: 'RO 7001', facts: { Customer: 'Customer 1', Vehicle: '2022 Toyota Camry SE', Advisor: 'Avery Thackeray', Status: 'In progress' }, item: { key: 'ro-7001', title: 'RO 7001 · Customer 1' } },
    ]);
    page.close();
  });

  it('refuses a display the manifest does not record, and displays with no manifest to show them on', () => {
    expect(() => createFixturePage({ at: '/dashboard', shown: [{ id: 'home.nope', facts: {} }] }, { manifest: MANIFEST })).toThrow(/the manifest records no display "home.nope"/);
    expect(() => createFixturePage({ at: '/', shown: [{ id: 'home.gross', facts: {} }] })).toThrow(EvalPageError);
    // A manifest generated before 0.10 records no displays, and any is taken where `routes` says.
    const older: OuiManifest = { ...MANIFEST, surfaces: MANIFEST.surfaces.map(({ displays: _displays, ...s }) => s) };
    expect(() => createFixturePage({ at: '/dashboard', shown: [{ id: 'home.nope', routes: ['/dashboard'], facts: {} }] }, { manifest: older })).not.toThrow();
  });

  it('reports problems with the page that shows them, and with the navigation surface where no page is open', async () => {
    const page = createFixturePage(
      {
        at: '/dashboard',
        allControls: true,
        problems: [
          { source: 'home.gross', routes: ['/dashboard'], problems: [{ kind: 'load-failed', message: 'The gross could not be loaded.' }] },
          { routes: ['/admin'], problems: [{ kind: 'access-required', message: 'Only a store manager can open Admin.' }] },
        ],
      },
      { manifest: MANIFEST },
    );
    expect((await read(page, 'page:dashboard', PROBLEMS_OBSERVATION_ID)).rows).toEqual([{ kind: 'load-failed', message: 'The gross could not be loaded.' }]);
    await navigate(page, { path: '/admin' });
    expect((await read(page, 'app:navigation', PROBLEMS_OBSERVATION_ID)).rows).toEqual([{ kind: 'access-required', message: 'Only a store manager can open Admin.' }]);
    page.close();
  });
});

describe('what a declared surface shows', () => {
  const fixture: AgentEvalPage = {
    at: '/lane?view=lane',
    surfaces: [
      {
        id: 'page:lane',
        name: 'Service lane',
        description: 'Repair orders, by view.',
        routes: ['/lane'],
        state: { state: { view: 'lane' } },
        shown: [{ id: 'lane.summary', title: 'Service lane', facts: { Open: 60, Late: 7 } }, ...Array.from({ length: 3 }, (_, i) => ro(i, 'lane')), ro(9, 'declined')],
        problems: [{ problems: [{ kind: 'stale', message: 'The lane was last read 20 minutes ago.' }] }],
        actions: [{ id: 'lane_refresh', description: 'Reads the lane again.', effect: 'view', state: { problems: [] } }],
      },
    ],
  };

  it('reports it in its state, beside what its state says, its rows declared with x-rows, and its problems until an action clears them', async () => {
    const page = createFixturePage(fixture);
    const state = await stateOf(page, 'page:lane');
    expect(state).toMatchObject({ view: 'lane' });
    // A card whose query the address does not hold (the page declares none: ?view as written) is not shown.
    expect(state.shown!.map((s) => (s as { item?: { key: string } }).item?.key ?? 'summary')).toEqual(['summary', 'ro-7000', 'ro-7001', 'ro-7002']);
    expect(state.shown![0]).toEqual({ id: 'lane.summary', title: 'Service lane', facts: { Open: '60', Late: '7' } });
    const surface = ((await page.context()).oui as { index: Array<{ id: string; observations?: Array<{ id: string; schema?: { properties?: { shown?: Record<string, unknown> } } }> }> }).index.find((s) => s.id === 'page:lane')!;
    expect(surface.observations!.find((o) => o.id === 'state')!.schema!.properties!.shown!['x-rows']).toEqual({ ...SHOWN_ROWS, index: [...SHOWN_ROWS.index] });
    expect((await read(page, 'page:lane', PROBLEMS_OBSERVATION_ID)).rows).toEqual([{ kind: 'stale', message: 'The lane was last read 20 minutes ago.' }]);
    await execute(page, 'page:lane', 'lane_refresh', {});
    expect((await read(page, 'page:lane', PROBLEMS_OBSERVATION_ID)).rows).toEqual([]);
    page.close();
  });
});

describe('a long list of cards, over the page state’s budget', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'long-lane',
    page: {
      at: '/dashboard/service-lane',
      allControls: true,
      // Sixty cards on whatever view the lane is on.
      shown: Array.from({ length: 60 }, (_, i) => {
        const { query: _query, ...card } = ro(i, 'lane');
        return card;
      }),
    },
    scenarios: [
      {
        id: 'names-the-last-ro',
        title: 'Reads the rows the page state left out, and names the last repair order',
        turns: [{ user: 'Which is the last repair order on the lane?', expect: { says: ['RO 7059'], calls: [{ tool: 'ui_read', min: 1 }] } }],
      },
    ],
  };
  /** The `ui_read` call the page state names for the rows it left out, as the model reads it. */
  const readCall = (text: string) => {
    const marker = /read them with ui_read (\{[^}]*\})/.exec(text.replace(/\\"/g, '"'));
    return marker ? (JSON.parse(marker[1]) as Record<string, unknown>) : null;
  };
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const answered = lastTool(request);
    if (answered?.includes('RO 7059')) return { text: 'The last one is RO 7059.' };
    // The rows left out, from the page state's marker, then page by page as each answer says where the next begins.
    const next = answered === null ? readCall(pageText(request)) : /"next":(\d+)/.exec(answered) ? { ...readCall(pageText(request)), offset: Number(/"next":(\d+)/.exec(answered)![1]) } : null;
    if (!next) return { text: 'The page named no way to read the rest.' };
    return { toolCalls: [{ id: `call_read_${String(next.offset)}`, name: 'ui_read', args: next }] };
  };

  it('keeps an index of its rows, and the rest is read with ui_read from the page', async () => {
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      page: { manifest: MANIFEST },
      agent: () => ({ ...agent(), uiActions: { maxObservationChars: 3_000 } }),
    });
    const { result, requests: sent } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    // The cards the page state kept are named by their rows, as index rows, never a bare count; the rest are read at the display's own offset.
    expect(pageText(sent[0])).toContain('"key":"ro-7000"');
    expect(pageText(sent[0])).not.toMatch(/"\d+ more"/);
    expect(readCall(pageText(sent[0]))).toMatchObject({ surface: 'page:service-lane', observation: 'state', path: '/shown', offset: 12 });
    expect(result.cases[0].turns[0].reply).toBe('The last one is RO 7059.');
    expect((await runEvals(config)).failed).toBe(0);
  });
});

// ─── A control that follows the address ──────────────────────────────────────

describe('a control bound to a query parameter', () => {
  const lane = (at: string, extra: Partial<AgentEvalPage> = {}): EvalPage =>
    createFixturePage(
      {
        at,
        controls: { 'service-lane.view': { query: 'view', value: 'lane' }, 'service-lane.declined.advisor': { query: 'advisor' }, 'dashboard.search': {} },
        ...extra,
      },
      { manifest: MANIFEST },
    );
  const valuesOf = async (page: EvalPage) => (await stateOf(page, 'page:service-lane')).values;

  it('takes its value from the address the page opens at, read as the page’s declared query reads it', async () => {
    const declined = lane('/dashboard/service-lane?view=declined&advisor=Jordan%20Lee');
    expect(await valuesOf(declined)).toEqual({ 'service-lane.view': 'declined', 'service-lane.declined.advisor': 'Jordan Lee' });
    declined.close();
    // Left out of the address: the declaration's default; a value it does not take falls back to it too.
    const plain = lane('/dashboard/service-lane?view=closed');
    expect(await valuesOf(plain)).toEqual({ 'service-lane.view': 'lane' });
    plain.close();
  });

  it('follows the address when app.navigate changes its query', async () => {
    const page = lane('/dashboard');
    expect((await navigate(page, { path: '/dashboard/service-lane', query: { view: 'declined' } })).success).toBe(true);
    expect(page.location()).toBe('/dashboard/service-lane?view=declined');
    expect(await valuesOf(page)).toMatchObject({ 'service-lane.view': 'declined' });
    await navigate(page, { path: '/dashboard/service-lane?view=lane&advisor=Avery%20Thackeray' });
    expect(await valuesOf(page)).toEqual({ 'service-lane.view': 'lane', 'service-lane.declined.advisor': 'Avery Thackeray' });
    await navigate(page, { path: '/dashboard/service-lane' });
    expect(await valuesOf(page)).toEqual({ 'service-lane.view': 'lane' });
    page.close();
  });

  it('writes the value it is given to the address, and what the page shows follows it', async () => {
    const page = lane('/dashboard/service-lane', { shown: [ro(1, 'lane'), ro(2, 'declined')] });
    expect((await stateOf(page, 'page:service-lane')).shown).toHaveLength(1);
    expect((await execute(page, 'page:service-lane', 'service_lane_view', { value: 'declined' })).success).toBe(true);
    expect(page.location()).toBe('/dashboard/service-lane?view=declined');
    const state = await stateOf(page, 'page:service-lane');
    expect(state.values).toMatchObject({ 'service-lane.view': 'declined' });
    expect(state.shown).toEqual([expect.objectContaining({ item: { key: 'ro-7002', title: 'RO 7002 · Customer 2' } })]);
    // The default leaves the address plain, as `writeQuery` writes it.
    await execute(page, 'page:service-lane', 'service_lane_view', { value: 'lane' });
    expect(page.location()).toBe('/dashboard/service-lane');
    page.close();
  });

  it('is refused when no page declares the parameter, or on a list’s control', () => {
    expect(() => createFixturePage({ at: '/dashboard', controls: { 'service-lane.view': { query: 'tab' } } }, { manifest: MANIFEST })).toThrow(
      /the control "service-lane.view" follows \?tab, and no page’s query takes it \(the manifest’s app.navigate declares \?view, \?advisor\)/,
    );
    expect(() =>
      createFixturePage({ at: '/dashboard', controls: { 'service-lane.view': { query: 'view', rows: [{ key: 'a', title: 'A' }] } } }, { manifest: MANIFEST }),
    ).toThrow(/is a list’s, one per row/);
  });

  it('opens the lane filtered in one call, and the next request sees the tab and the rows it selects', async () => {
    const suite: AgentEvalSuite = {
      version: 1,
      name: 'filtered',
      page: { at: '/dashboard', controls: { 'service-lane.view': { query: 'view' }, 'dashboard.search': {} }, shown: [ro(1, 'lane'), ro(2, 'declined')] },
      scenarios: [
        {
          id: 'declined-in-one-call',
          title: 'Opens the lane on its declined work with the address alone',
          turns: [
            {
              user: 'Show me the declined work',
              expect: {
                page: { at: '/dashboard/service-lane?view=declined', notRan: ['service-lane.view'] },
                calls: [{ action: 'app.navigate', times: 1 }],
                says: ['RO 7002'],
              },
            },
          ],
        },
      ],
    };
    const script = (request: ChatRequest): ScriptedReply | undefined => {
      const answered = lastTool(request);
      if (answered === null) return { toolCalls: [{ id: 'call_nav', name: 'ui_act', args: { action: 'app_navigate', input: { path: '/dashboard/service-lane', query: { view: 'declined' } } } }] };
      const text = pageText(request);
      const selected = text.includes('"service-lane.view":"declined"');
      return { text: selected && text.includes('RO 7002') && !text.includes('RO 7001') ? 'The lane shows RO 7002, declined.' : 'The tab did not follow the address.' };
    };
    const config = configFor(tempDir(), { suites: [suite], channels: { web_chat: {} }, page: { manifest: MANIFEST } });
    const { result } = await recordWith(script, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    expect(result.cases[0].turns[0].page?.at).toBe('/dashboard/service-lane?view=declined');
  });
});

// ─── The turn a history is read for ──────────────────────────────────────────

describe('the product’s conversation store', () => {
  it('is given the turn each read is for: its id, scenario, channel, customer, context and page', async () => {
    const suite: AgentEvalSuite = {
      version: 1,
      name: 'history-turn',
      context: { viewAs: { persona: 'sales_associate' } },
      page: { at: '/dashboard', controls: { 'dashboard.search': {} } },
      scenarios: [{ id: 'two-turns', title: 'Two turns', context: { timeZone: 'America/New_York' }, turns: [{ user: 'Hello' }, { user: 'Again' }] }],
    };
    const seen: EvalHistoryRequest[] = [];
    const windows: EvalHistoryRequest[] = [];
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      page: { manifest: MANIFEST },
      customer: { userId: 'u-avery', accountId: 'a-quillhaven' },
      history: () => {
        const store = createMemoryHistory({
          window: (messages, request) => {
            windows.push(request);
            // A step context written from where the turn is sent from, as a product's worker writes it from the payload.
            return { messages: [...messages], stepContext: `<page>${String(request.turn?.context.currentPath)}</page>` };
          },
        });
        return {
          ...store,
          getHistory: (conversationId, request) => {
            seen.push(request);
            return store.getHistory(conversationId, request);
          },
        };
      },
    });
    const { result, requests: sent } = await recordWith(() => ({ text: 'Hi.' }), () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
    expect(seen.map((r) => r.turn!.turnId)).toEqual(seen.map((r) => r.turnId));
    expect(seen.map((r) => ({ index: r.turn!.index, kind: r.turn!.kind, scenario: r.turn!.scenario.id, suite: r.turn!.suite.name, channel: r.turn!.channel, user: r.turn!.user, at: r.turn!.at }))).toEqual([
      { index: 0, kind: 'user', scenario: 'two-turns', suite: 'history-turn', channel: 'web_chat', user: { userId: 'u-avery', accountId: 'a-quillhaven' }, at: '/dashboard' },
      { index: 1, kind: 'user', scenario: 'two-turns', suite: 'history-turn', channel: 'web_chat', user: { userId: 'u-avery', accountId: 'a-quillhaven' }, at: '/dashboard' },
    ]);
    // The context the turn is sent with: the suite's and the scenario's (its view), and the page's.
    expect(seen[0].turn!.context).toMatchObject({ viewAs: { persona: 'sales_associate' }, timeZone: 'America/New_York', currentPath: '/dashboard' });
    expect(seen[0].turn!.context.oui).toBeDefined();
    expect(windows.map((w) => w.turn?.turnId)).toEqual(seen.map((r) => r.turnId));
    expect(pageText(sent[0])).toContain('<page>/dashboard</page>');
  });
});
