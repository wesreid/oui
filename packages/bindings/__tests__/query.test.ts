/**
 * The query a page reads from its address: declared once, read and written
 * by the page, and taken by the generated `app.navigate`, which builds the
 * address safely and refuses what the page does not take.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createBindingRegistry,
  defineQuery,
  LOCATION_OBSERVATION_ID,
  NAVIGATE_ACTION_ID,
  NAVIGATION_QUERY_ROUTES,
  NAVIGATION_SURFACE_ID,
  navigationQueries,
  navigationTarget,
  pageQueryOf,
  pageQueryProblems,
  pageQuerySchema,
  readQuery,
  sameAddress,
  toolName,
  writeQuery,
  type OuiManifest,
} from '../src/index.js';
import { connectBindings, type AppNavigation } from '../src/oui.js';

const LANE_VIEWS = [
  { value: 'lane', label: 'The lane' },
  { value: 'declined', label: 'Declined work', description: 'closed repair orders with work the customer declined' },
] as const;

const LANE_QUERY = defineQuery({
  view: { values: LANE_VIEWS, default: 'lane', description: 'Which repair orders' },
  period: { values: ['this_week', 'this_month', 'last_month'], default: 'this_month', description: 'The declined list’s period' },
  advisor: { type: 'string', description: 'A service advisor, by name as the lane shows it' },
  page: { type: 'integer', minimum: 1, default: 1, description: 'The page of the list' },
  late: { type: 'boolean', description: 'Only repair orders past their promised time' },
  signals: { values: ['no_show', 'unconfirmed'], multiple: true, description: 'Only cards raised by these signals' },
  from: { type: 'date', description: 'The first day' },
});

describe('readQuery and writeQuery', () => {
  it('reads each parameter as declared, typed, with its default when the address leaves it out', () => {
    const q = readQuery(LANE_QUERY, new URLSearchParams('view=declined&advisor=Avery%20Ng&page=3&late=1&signals=no_show,unconfirmed&from=2026-10-01'));
    expect(q).toEqual({
      view: 'declined',
      period: 'this_month',
      advisor: 'Avery Ng',
      page: 3,
      late: true,
      signals: ['no_show', 'unconfirmed'],
      from: '2026-10-01',
    });
    // The types follow the declaration.
    const view: 'lane' | 'declined' = q.view;
    const advisor: string | undefined = q.advisor;
    const page: number = q.page;
    const signals: ('no_show' | 'unconfirmed')[] = q.signals;
    expect([view, advisor, page, signals]).toBeTruthy();
  });

  it('falls back on a value the page does not take: a hand-written address never breaks the page', () => {
    expect(readQuery(LANE_QUERY, '?view=closed&page=0&late=maybe&signals=no_show,bogus&from=2026-02-30')).toEqual({
      view: 'lane',
      period: 'this_month',
      advisor: undefined,
      page: 1,
      late: false,
      signals: ['no_show'],
      from: undefined,
    });
  });

  it('reads an address the same way from the declaration a manifest records (pageQueryOf)', () => {
    const recorded = pageQueryOf(pageQuerySchema(LANE_QUERY));
    expect(Object.keys(recorded)).toEqual(Object.keys(LANE_QUERY));
    expect(pageQueryProblems(recorded)).toEqual([]);
    for (const address of [
      '',
      '?view=declined&advisor=Avery%20Ng&page=3&late=1&signals=no_show,unconfirmed&from=2026-10-01',
      '?view=closed&page=0&late=maybe&signals=no_show,bogus&from=2026-02-30',
      '?period=last_month&late=0',
    ]) {
      expect(readQuery(recorded, address)).toEqual(readQuery(LANE_QUERY, address));
    }
    expect(writeQuery(recorded, 'view=declined', { view: 'lane', late: true }).toString()).toBe(
      writeQuery(LANE_QUERY, 'view=declined', { view: 'lane', late: true }).toString(),
    );
    // Its schema is the page's own, so the navigation action checks it the same way.
    expect(pageQuerySchema(recorded).properties?.view).toMatchObject({ enum: ['lane', 'declined'], default: 'lane' });
    expect(pageQueryOf({ type: 'object', properties: { odd: { type: 'object' } } })).toEqual({});
  });

  it('writes changes, keeps every other parameter, and leaves out defaults and empties', () => {
    const next = writeQuery(LANE_QUERY, 'open=ro-1&view=declined&page=2', { view: 'lane', page: 1, advisor: 'Avery', late: true, signals: ['no_show'] });
    expect(next.toString()).toBe('open=ro-1&advisor=Avery&late=1&signals=no_show');
    expect(writeQuery(LANE_QUERY, next, { advisor: '', late: false, signals: [] }).toString()).toBe('open=ro-1');
    expect(() => writeQuery(LANE_QUERY, '', { nope: 'x' } as never)).toThrow(/"nope" is not a parameter/);
  });

  it('refuses a declaration whose default it would never read back', () => {
    expect(
      pageQueryProblems({
        view: { values: ['a', 'b', 'a'], default: 'c', description: 'x' },
        tags: { values: ['x,y'], multiple: true, description: 'x' },
        page: { type: 'integer', minimum: 1, default: 0, description: 'x' },
        names: { type: 'string', multiple: true, default: 'a', description: 'x' },
      }),
    ).toEqual([
      '?view lists "a" twice',
      '?view\'s default "c" is not one of its values (a, b, a)',
      '?tags takes several values, comma-separated, so no value can hold a comma: "x,y"',
      "?page's default 0 is not a value it takes",
      '?names takes several values and has a default: leave the default out (none is the empty list)',
    ]);
    expect(pageQueryProblems(LANE_QUERY)).toEqual([]);
  });

  it('is one object schema, each value with its meaning', () => {
    const schema = pageQuerySchema(LANE_QUERY);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.view).toEqual({
      type: 'string',
      enum: ['lane', 'declined'],
      default: 'lane',
      description: 'Which repair orders. lane (The lane); declined (Declined work: closed repair orders with work the customer declined).',
    });
    expect(schema.properties?.page).toMatchObject({ type: 'integer', minimum: 1, default: 1 });
    expect(schema.properties?.signals).toMatchObject({ type: 'array', items: { enum: ['no_show', 'unconfirmed'] }, uniqueItems: true });
    expect(schema.properties?.from).toMatchObject({ type: 'string', format: 'date' });
  });
});

const ROUTES = ['/', '/voices', '/voices/:id', '/dashboard/service-lane', '/dashboard/inventory/:unitId'];
const QUERIES = [{ routes: ['/dashboard/service-lane'], schema: pageQuerySchema(LANE_QUERY) }];

describe('navigationTarget', () => {
  const go = (path: string, extra: Record<string, unknown> = {}) => navigationTarget({ path, ...extra }, ROUTES, QUERIES);

  it('builds the address from the path, the route’s parameters and the query, each encoded, in the order the page declares them', () => {
    expect(go('/dashboard/service-lane', { query: { advisor: 'Avery Ng & Co', view: 'declined', period: 'this_month', page: '2' } })).toEqual({
      ok: true,
      route: '/dashboard/service-lane',
      address: '/dashboard/service-lane?view=declined&period=this_month&advisor=Avery+Ng+%26+Co&page=2',
    });
    expect(go('/dashboard/inventory/:unitId', { params: { unitId: 'u 7/../x' } })).toMatchObject({
      ok: true,
      address: '/dashboard/inventory/u%207%2F..%2Fx',
    });
    expect(go('/voices/v_123')).toMatchObject({ ok: true, address: '/voices/v_123', route: '/voices/:id' });
    expect(go('/')).toMatchObject({ ok: true, address: '/' });
  });

  it('reads a query written in the path the same way, and refuses one given twice differently', () => {
    expect(go('/dashboard/service-lane?view=declined&late=true', { query: { signals: ['no_show', 'unconfirmed'] } })).toMatchObject({
      ok: true,
      address: '/dashboard/service-lane?view=declined&late=1&signals=no_show%2Cunconfirmed',
    });
    expect(go('/dashboard/service-lane?view=declined', { query: { view: 'lane' } })).toMatchObject({ ok: false, code: 'INVALID_QUERY' });
  });

  it('refuses what the page does not take, naming what it takes', () => {
    expect(go('/dashboard/service-lane', { query: { show: 'declined' } })).toEqual({
      ok: false,
      code: 'UNKNOWN_QUERY',
      message: '/dashboard/service-lane does not take ?show: it takes ?view, ?period, ?advisor, ?page, ?late, ?signals, ?from',
    });
    const bad = go('/dashboard/service-lane', { query: { view: 'closed' } });
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_QUERY' });
    expect(!bad.ok && bad.message).toContain('?view must be one of "lane", "declined"');
    expect(go('/dashboard/service-lane', { query: { page: 0 } })).toMatchObject({ ok: false, code: 'INVALID_QUERY' });
    expect(go('/dashboard/service-lane', { query: { from: '2026-13-01' } })).toMatchObject({ ok: false, code: 'INVALID_QUERY' });
  });

  it('passes a query through as before on a page that declares none', () => {
    expect(go('/voices?sort=newest', { query: { tag: ['a', 'b'], n: 2 } })).toMatchObject({ ok: true, address: '/voices?sort=newest&tag=a%2Cb&n=2' });
  });

  it('never leaves the app or climbs out of a route', () => {
    for (const path of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/voices/../admin', '/voices/./x', '/voices//x', '/voices/%2e%2e', '/voices/\u0000x', '/voices/%zz']) {
      const target = go(path);
      expect(target.ok, path).toBe(false);
    }
    expect(go('/voices/:id')).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(go('/voices', { params: { id: 'x' } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(go('/nowhere')).toMatchObject({ ok: false, code: 'UNKNOWN_ROUTE' });
  });

  it('knows two encodings of one address are the same address', () => {
    expect(sameAddress('/dashboard/service-lane?view=declined&advisor=Avery%20Ng', '/dashboard/service-lane?advisor=Avery+Ng&view=declined')).toBe(true);
    expect(sameAddress('/voices/', '/voices')).toBe(true);
    expect(sameAddress('/voices?a=1', '/voices?a=2')).toBe(false);
  });
});

describe('app.navigate with a page’s query', () => {
  const navigateInput = {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const },
      params: { type: 'object' as const, additionalProperties: { type: 'string' as const } },
      query: { type: 'object' as const, anyOf: [{ ...pageQuerySchema(LANE_QUERY), description: 'Service lane', [NAVIGATION_QUERY_ROUTES]: ['/dashboard/service-lane'] }] },
    },
    required: ['path'],
    additionalProperties: false as const,
  };
  const manifest: OuiManifest = {
    version: 1,
    buildId: 'test',
    surfaces: [
      {
        id: NAVIGATION_SURFACE_ID,
        kind: 'navigation',
        title: 'Pages',
        description: 'Every page',
        routes: ROUTES,
        actions: [
          {
            name: toolName(NAVIGATE_ACTION_ID),
            id: NAVIGATE_ACTION_ID,
            source: 'navigation',
            title: 'Go to a page',
            description: 'Go to a page',
            input: navigateInput,
            reach: [],
          },
        ],
        observations: [{ id: LOCATION_OBSERVATION_ID, description: 'Where', schema: { type: 'object' } }],
      },
    ],
  };

  function router(start: string) {
    let at = start;
    const navigation: AppNavigation = {
      navigate: vi.fn((to: string) => {
        at = to;
      }),
      location: () => at,
      subscribe: () => () => {},
    };
    return navigation;
  }

  let requests = 0;
  const run = (runtime: ReturnType<typeof createSurfaceRuntime>, params: Record<string, unknown>) =>
    runtime.execute({ requestId: `r${++requests}`, surfaceId: NAVIGATION_SURFACE_ID, actionId: 'app_navigate', params, timestamp: 0 });

  it('reads the queries from the action’s input', () => {
    expect(navigationQueries(navigateInput).map(q => q.routes)).toEqual([['/dashboard/service-lane']]);
    expect(navigationQueries({ type: 'object', properties: { path: { type: 'string' } } })).toEqual([]);
  });

  it('opens the page filtered in one call, and a second identical call does not navigate again', async () => {
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const navigation = router('/');
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation });
    const call = { path: '/dashboard/service-lane', query: { view: 'declined', period: 'this_month', advisor: 'Avery' } };

    const first = await run(runtime, call);
    expect(first).toMatchObject({ success: true, data: { navigatedTo: '/dashboard/service-lane?view=declined&period=this_month&advisor=Avery' } });
    const second = await run(runtime, call);
    expect(second).toMatchObject({ success: true, data: { alreadyThere: true } });
    expect(navigation.navigate).toHaveBeenCalledTimes(1);

    const refused = await run(runtime, { path: '/dashboard/service-lane', query: { show: 'declined' } });
    expect(refused).toMatchObject({ success: false, error: { code: 'UNKNOWN_QUERY' } });
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    disconnect();
  });
});
