/**
 * A page's query, from its declaration to `app.navigate`.
 *
 * A page declares the query it reads (`defineQuery`) and reads it
 * (`readQuery`), in itself, in a component it renders, or in an app hook.
 * The generator reads the declaration, holds it to the contract, and gives
 * `app.navigate` a `query` with one alternative per such page, so the
 * assistant opens the page filtered in one call. An app that declares no
 * query is generated as before.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NAVIGATION_QUERY_ROUTES, navigationQueries, navigationTarget, type ControlTable, type JsonSchema } from '@ouispec/bindings';

import { generate, resolveConfig } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};
/** The bindings' query API, as its published types declare it. */
const BINDINGS = {
  name: '@ouispec/bindings',
  packageJson: { types: './index.d.ts' },
  files: {
    'index.d.ts': [
      'export declare function defineQuery<const D>(declaration: D): D;',
      'export declare function readQuery<D>(declaration: D, source: { get(name: string): string | null } | string): Record<string, unknown>;',
    ].join('\n'),
  },
};

const ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { Button } from '@fixture/ds';",
  "import { ServiceLanePage } from './ServiceLanePage';",
  "import { AppointmentsPage } from './AppointmentsPage';",
  'function HomePage() {',
  "  return <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>;",
  '}',
  'function UnitPage() {',
  "  return <Button agent={{ id: 'unit.hold', description: 'Hold the unit' }} onClick={() => {}}>Hold</Button>;",
  '}',
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/" element={<HomePage />} />',
  '      <Route path="/service-lane" element={<ServiceLanePage />} />',
  '      <Route path="/lane" element={<ServiceLanePage />} />',
  '      <Route path="/appointments" element={<AppointmentsPage />} />',
  '      <Route path="/inventory/:unitId" element={<UnitPage />} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const FILES: Record<string, string> = {
  // The option list the page's select renders, in a module of its own.
  'src/lane.ts': [
    "import { defineQuery } from '@ouispec/bindings';",
    'export const LANE_VIEWS = [',
    "  { value: 'lane', label: 'The lane' },",
    "  { value: 'declined', label: 'Declined work', description: 'closed repair orders with work the customer declined' },",
    '] as const;',
    "const PERIODS = ['this_week', 'this_month', 'last_month'] as const;",
    "const ADVISOR = 'A service advisor, by name as the lane shows it';",
    'export const LANE_QUERY = defineQuery({',
    "  view: { values: LANE_VIEWS, default: 'lane', description: 'Which repair orders' },",
    "  period: { values: PERIODS, default: 'this_month', description: 'The declined list’s period' },",
    "  advisor: { type: 'string', description: ADVISOR },",
    '});',
  ].join('\n'),
  // An app hook that reads the query it is given.
  'src/use-url-query.ts': [
    "import { readQuery } from '@ouispec/bindings';",
    'declare function useSearchParams(): [URLSearchParams];',
    'export function useUrlQuery<D>(declaration: D) {',
    '  const [params] = useSearchParams();',
    '  return readQuery(declaration, params);',
    '}',
  ].join('\n'),
  'src/ServiceLanePage.tsx': [
    "import { defineQuery, readQuery as read } from '@ouispec/bindings';",
    "import { Button } from '@fixture/ds';",
    "import { LANE_QUERY } from './lane';",
    "const PAGING = defineQuery({ page: { type: 'integer', minimum: 1, default: 1, description: 'The page of the list' } });",
    'function Pager() {',
    "  const { page } = read(PAGING, '');",
    "  return <Button agent={{ id: 'lane.next', description: 'Next page' }} onClick={() => {}}>{String(page)}</Button>;",
    '}',
    'export function ServiceLanePage() {',
    "  const query = read(LANE_QUERY, '');",
    '  return <div>{String(query.view)}<Pager /></div>;',
    '}',
  ].join('\n'),
  'src/AppointmentsPage.tsx': [
    "import * as oui from '@ouispec/bindings';",
    "import { useUrlQuery } from './use-url-query';",
    'const APPOINTMENTS = oui.defineQuery({',
    "  status: { values: ['unconfirmed', 'confirmed', 'no_show'], multiple: true, description: 'Only appointments in these states' },",
    "  day: { type: 'date', description: 'The day' },",
    "  mine: { type: 'boolean', default: true, description: 'Only the person’s own book' },",
    '});',
    'export function AppointmentsPage() {',
    '  const q = useUrlQuery(APPOINTMENTS);',
    '  return <div>{String(q.day)}</div>;',
    '}',
  ].join('\n'),
};

function app(files: Record<string, string> = FILES, routes = ROUTES): string {
  const root = tempApp([DS, BINDINGS], routes);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function run(root = app()) {
  return generate(
    resolveConfig(root, {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      designSystem: ['@fixture/ds'],
      apiSpec: null,
      out: 'src/agent/generated',
    }),
  );
}

const navigate = (r: Awaited<ReturnType<typeof run>>) =>
  r.manifest.surfaces.find(s => s.id === 'app:navigation')!.actions.find(a => a.name === 'app_navigate')!;

describe('a page’s query', () => {
  it('is read from where the page reads it: the page, a component it renders, an app hook; renamed and namespace imports too', async () => {
    const r = await run();
    expect(r.errors.map(e => e.message)).toEqual([]);
    const input = navigate(r).input as JsonSchema;
    const query = input.properties!.query!;
    expect(query.anyOf!.map(alt => [alt[NAVIGATION_QUERY_ROUTES], Object.keys(alt.properties!)])).toEqual([
      [['/appointments'], ['status', 'day', 'mine']],
      [['/lane', '/service-lane'], ['view', 'period', 'advisor', 'page']],
    ]);
    const lane = query.anyOf![1].properties!;
    expect(lane.view).toEqual({
      type: 'string',
      enum: ['lane', 'declined'],
      default: 'lane',
      description: 'Which repair orders. lane (The lane); declined (Declined work: closed repair orders with work the customer declined).',
    });
    expect(lane.advisor).toEqual({ type: 'string', description: 'A service advisor, by name as the lane shows it.' });
    expect(query.anyOf![0].properties!.status).toMatchObject({ type: 'array', items: { enum: ['unconfirmed', 'confirmed', 'no_show'] } });
    // The path names each page's parameters beside it.
    expect(input.properties!.path.description).toContain('/service-lane (Service Lane; ?view, ?period, ?advisor, ?page)');
    expect(input.properties!.path.description).toContain('/inventory/:unitId (Unit)');
    expect(input.properties!.params).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
  });

  it('is what the runtime checks a call against', async () => {
    const r = await run();
    const action = navigate(r);
    const routes = r.manifest.surfaces.find(s => s.id === 'app:navigation')!.routes;
    const queries = navigationQueries(action.input);
    expect(navigationTarget({ path: '/lane', query: { view: 'declined', advisor: 'Avery Ng' } }, routes, queries)).toEqual({
      ok: true,
      route: '/lane',
      address: '/lane?view=declined&advisor=Avery+Ng',
    });
    expect(navigationTarget({ path: '/service-lane', query: { show: 'declined' } }, routes, queries)).toMatchObject({ ok: false, code: 'UNKNOWN_QUERY' });
    expect(navigationTarget({ path: '/inventory/:unitId', params: { unitId: 'u 7' } }, routes, queries)).toMatchObject({
      ok: true,
      address: '/inventory/u%207',
    });
  });

  it('is in the page’s knowledge and the overview', async () => {
    const r = await run();
    const lane = r.knowledge.pages.find(p => p.surface === 'page:ServiceLanePage')!;
    expect(lane.detail.content).toContain('Its address takes (open it filtered with [app_navigate], query):');
    expect(lane.detail.content).toContain('- view: lane|declined, default lane — Which repair orders.');
    expect(lane.detail.content).toContain('- page: integer ≥1, default 1 — The page of the list.');
    expect(lane.summary.content).toContain('Its address takes ?view, ?period, ?advisor, ?page.');
    expect(r.knowledge.overview.content).toContain('opens already filtered with its query, in one call');
    const appointments = r.knowledge.pages.find(p => p.surface === 'page:AppointmentsPage')!;
    expect(appointments.detail.content).toContain('- status: list of unconfirmed|confirmed|no_show — Only appointments in these states. Several may be given.');
    expect(appointments.detail.content).toContain('- day: date YYYY-MM-DD — The day.');
  });

  it('leaves an app that declares none as it was, with params beside path', async () => {
    const files = {
      'src/ServiceLanePage.tsx': 'export function ServiceLanePage() { return <div />; }',
      'src/AppointmentsPage.tsx': 'export function AppointmentsPage() { return <div />; }',
    };
    const r = await run(app(files));
    expect(r.errors).toEqual([]);
    const action = navigate(r);
    expect(Object.keys((action.input as JsonSchema).properties!)).toEqual(['path', 'params']);
    expect(action.description).toBe('Go to a page of the app, as following a link to it does. The page’s own tools are offered once it is open.');
    expect(r.knowledge.overview.content).toContain('its path lists every page.');
    expect(r.knowledge.overview.content).not.toContain('query');
  });

  it('fails the build for a declaration it cannot read, one the contract refuses, a default it would never read back, and a parameter declared twice differently', async () => {
    const files = {
      ...FILES,
      'src/ServiceLanePage.tsx': [
        "import { defineQuery, readQuery } from '@ouispec/bindings';",
        "import { LANE_QUERY } from './lane';",
        'declare function label(): string;',
        "const COMPUTED = defineQuery({ view: { values: ['a', label()], description: 'x' } });",
        "const WRONG = defineQuery({ view: { type: 'enum', description: 'x' } });",
        "const BAD_DEFAULT = defineQuery({ page: { type: 'integer', minimum: 1, default: 0, description: 'The page' } });",
        "const OTHER_VIEW = defineQuery({ view: { values: ['a', 'b'], description: 'Another view' } });",
        'export function ServiceLanePage() {',
        "  let q: unknown = '';",
        "  readQuery(COMPUTED, '');",
        "  readQuery(WRONG, '');",
        "  readQuery(BAD_DEFAULT, '');",
        "  readQuery(LANE_QUERY, '');",
        "  readQuery(OTHER_VIEW, '');",
        "  readQuery(q, '');",
        '  return <div />;',
        '}',
      ].join('\n'),
    };
    const r = await run(app(files));
    const messages = r.errors.map(e => `${e.file}:${e.line} ${e.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^src\/ServiceLanePage\.tsx:4 The query COMPUTED has values the build cannot read without running the app \(view\.values\[1\]\)/),
        expect.stringMatching(/^src\/ServiceLanePage\.tsx:5 The query WRONG does not match the OUI contract \(page-query\.json\)/),
        "src/ServiceLanePage.tsx:6 The query BAD_DEFAULT: ?page's default 0 is not a value it takes",
        expect.stringMatching(/^src\/ServiceLanePage\.tsx:7 ServiceLanePage reads \?view from two declarations that differ, LANE_QUERY \(src\/lane\.ts:\d+\) and OTHER_VIEW/),
        expect.stringMatching(/^src\/ServiceLanePage\.tsx:15 readQuery\(q, …\): its declaration must be a constant the build can read/),
      ]),
    );
  });
});
