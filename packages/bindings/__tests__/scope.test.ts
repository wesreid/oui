/**
 * The build as a session sees it: a build serving several brands gates some
 * routes (`routeGates`), and the host says which gates the session's person
 * has (`allows`). The map, the pages `app.navigate` goes to, the app-wide
 * search and the page guide then name only the pages open to them. Without
 * `allows`, or in a build with no gates, nothing changes.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it, vi } from 'vitest';

import {
  appMapContent,
  buildGates,
  createBindingRegistry,
  defineQuery,
  generatedNavigationSurface,
  NAVIGATION_SURFACE_ID,
  routeOpen,
  routeScope,
  scopedNavigationSurface,
  scopeText,
  scopeKnowledge,
  scopeManifest,
  type AppMapLine,
  type GeneratedKnowledge,
  type ManifestSurface,
  type NavigationRoute,
  type OuiManifest,
  type PageKnowledge,
} from '../src/index.js';
import { connectBindings, type AppNavigation } from '../src/oui.js';

// One declaration per page, as the generator reads each page's.
const VIEW = defineQuery({ view: { values: ['open', 'closed'], default: 'open', description: 'Which campaigns' } });
const PERIOD = defineQuery({ period: { values: ['week', 'month'], default: 'week', description: 'Which period' } });
const ROUTES: NavigationRoute[] = [
  { path: '/', title: 'Home' },
  { path: '/campaigns', title: 'Campaigns', query: VIEW },
  { path: '/clients/:id', title: 'Person' },
  { path: '/help', title: 'Help' },
  { path: '/people/:id', title: 'Person' },
  { path: '/reports', title: 'Reports', query: PERIOD },
];
const GATES: Record<string, Record<string, string[]>> = {
  'page:CampaignsPage': { '/campaigns': ['campaigns'] },
  'page:ReportsPage': { '/reports': ['reports'] },
  'page:PersonPage': { '/clients/:id': ['clients'], '/people/:id': ['people'] },
};
const PAGES: [string, string, string[]][] = [
  ['page:HomePage', 'Home', ['/']],
  ['page:CampaignsPage', 'Campaigns', ['/campaigns']],
  ['page:HelpPage', 'Help', ['/help']],
  ['page:PersonPage', 'Person', ['/clients/:id', '/people/:id']],
  ['page:ReportsPage', 'Reports', ['/reports']],
];

const pageSurface = ([id, title, routes]: [string, string, string[]]): ManifestSurface => ({
  id,
  kind: 'page',
  title,
  description: `${title}.`,
  routes,
  actions: [],
  observations: [],
  ...(GATES[id] ? { gates: GATES[id] } : {}),
});
const room: ManifestSurface = {
  id: 'room:planner',
  kind: 'room',
  title: 'Planner',
  description: 'Plans campaigns.',
  routes: ['/campaigns'],
  actions: [],
  observations: [],
};
const manifest: OuiManifest = {
  version: 1,
  buildId: 'b',
  surfaces: [...PAGES.map(pageSurface), room, generatedNavigationSurface(ROUTES)],
};

const pageKnowledge = ([surface, title, routes]: [string, string, string[]], adjacent: string[] = []): PageKnowledge => ({
  surface,
  routes,
  summary: { title, content: `${title}.` },
  detail: { title: `${title} (${routes.join(', ')})`, content: `All of ${title}.` },
  relationships: null,
  recipes: [],
  adjacent,
  ...(GATES[surface] ? { gates: GATES[surface] } : {}),
});

const MAP: AppMapLine[] = [
  { kind: 'text', text: 'Every page.' },
  { kind: 'heading', text: 'Main:' },
  { kind: 'page', surface: 'page:HomePage', depth: 0, title: 'Home', route: '/', offers: 'Start' },
  { kind: 'heading', text: 'Marketing:' },
  { kind: 'page', surface: 'page:CampaignsPage', depth: 0, title: 'Campaigns', route: '/campaigns' },
  { kind: 'page', surface: 'page:ReportsPage', depth: 0, title: 'Reports', route: '/reports', offers: 'Export' },
  { kind: 'heading', text: 'Opened by address only:' },
  { kind: 'page', surface: 'page:HelpPage', depth: 0, title: 'Help', route: '/help' },
  { kind: 'page', surface: 'page:PersonPage', depth: 0, title: 'Person', route: '/clients/:id', from: 'Open' },
  { kind: 'text', text: 'Go to any page by its address.' },
];
const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'b',
  overview: { title: 'The app’s pages', content: appMapContent(MAP) },
  map: MAP,
  pages: PAGES.map(p => pageKnowledge(p, p[0] === 'page:HomePage' ? ['page:CampaignsPage', 'page:HelpPage'] : [])),
};

const only =
  (...gates: string[]) =>
  (gate: string) =>
    gates.includes(gate);

describe('the app’s map, line by line', () => {
  it('renders every line when every page is shown', () => {
    expect(appMapContent(MAP).split('\n')).toEqual([
      'Every page.',
      'Main:',
      '- Home /: Start',
      'Marketing:',
      '- Campaigns /campaigns',
      '- Reports /reports: Export',
      'Opened by address only:',
      '- Help /help',
      '- Person /clients/:id (from Open)',
      'Go to any page by its address.',
    ]);
  });

  it('leaves out the pages a session may not see, a heading with none left, and names a page by a route it may see', () => {
    const seen = scopeKnowledge(knowledge, only('people')).overview.content.split('\n');
    expect(seen).toEqual([
      'Every page.',
      'Main:',
      '- Home /: Start',
      'Opened by address only:',
      '- Help /help',
      '- Person /people/:id (from Open)',
      'Go to any page by its address.',
    ]);
  });
});

describe('scoping the knowledge and the manifest', () => {
  it('is the very same build without allows, or for a build with no gates', () => {
    expect(scopeKnowledge(knowledge)).toBe(knowledge);
    expect(scopeManifest(manifest)).toBe(manifest);
    const ungated: OuiManifest = { ...manifest, surfaces: manifest.surfaces.map(({ gates: _g, ...s }) => s) };
    expect(scopeManifest(ungated, only())).toBe(ungated);
    expect(buildGates(knowledge.pages)).toEqual(['campaigns', 'clients', 'people', 'reports']);
  });

  it('keeps a page with only its open routes, and only the open pages beside it', () => {
    const seen = scopeKnowledge(knowledge, only('people'));
    expect(seen.pages.map(p => [p.surface, p.routes])).toEqual([
      ['page:HomePage', ['/']],
      ['page:HelpPage', ['/help']],
      ['page:PersonPage', ['/people/:id']],
    ]);
    expect(seen.pages[0].adjacent).toEqual(['page:HelpPage']);
    expect(seen.map).toBeUndefined();
    expect(routeOpen(GATES['page:PersonPage'], '/clients/:id', only('people'))).toBe(false);
    expect(routeOpen(undefined, '/help', only())).toBe(true);
  });

  it('leaves out a room on no page the session may see', () => {
    expect(scopeManifest(manifest, only('reports')).surfaces.map(s => s.id)).not.toContain('room:planner');
    expect(scopeManifest(manifest, only('campaigns')).surfaces.map(s => s.id)).toContain('room:planner');
  });
});

describe('the navigation surface, scoped', () => {
  const nav = manifest.surfaces.find(s => s.id === NAVIGATION_SURFACE_ID)!;
  const title = (route: string) => ROUTES.find(r => r.path === route)!.title;

  it('is what the generator emits for only the open pages, their query alternatives included', () => {
    for (const keep of [
      (r: string) => r !== '/campaigns',
      (r: string) => r !== '/reports',
      (r: string) => r !== '/campaigns' && r !== '/reports',
      () => true,
    ]) {
      expect(scopedNavigationSurface(nav, keep, title)).toEqual(generatedNavigationSurface(ROUTES.filter(r => keep(r.path))));
    }
  });

  it('offers a session only the pages it may see, and refuses going to another', async () => {
    let path = '/';
    const navigation: AppNavigation = { navigate: vi.fn((to: string) => (path = to)), location: () => path, subscribe: () => () => {} };
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation, knowledge, allows: only('reports') });
    const offered = runtime.snapshot().surfaces.find(s => s.id === NAVIGATION_SURFACE_ID)!.actions[0];
    const description = (offered.input as { properties: { path: { description: string } } }).properties.path.description;
    expect(description).toContain('/reports (Reports; ?period)');
    expect(description).not.toContain('/campaigns');
    const go = (to: string) =>
      runtime.execute({ requestId: to, surfaceId: NAVIGATION_SURFACE_ID, actionId: 'app_navigate', params: { path: to }, timestamp: 0 });
    expect(await go('/campaigns')).toMatchObject({ success: false, error: { code: 'UNKNOWN_ROUTE' } });
    expect(await go('/reports')).toMatchObject({ success: true });
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    // The guide answers only of the pages it may see.
    const guide = (page: string) =>
      runtime.execute({ requestId: page, surfaceId: 'oui', actionId: 'guide', params: { page }, timestamp: 0 });
    expect(await guide('Campaigns')).toMatchObject({ success: false });
    expect(await guide('Reports')).toMatchObject({ success: true });
    disconnect();
  });
});

describe('a text as a session sees it', () => {
  const scope = routeScope(
    [
      { routes: ['/', '/help', '/dashboard', '/dashboard/war-room', '/people/:id', '/clients/:id'], gates: { '/dashboard/war-room': ['government'], '/clients/:id': ['clients'] } },
    ],
    only(),
  );

  it('leaves a sentence out that names a page it may not see, by its route or an address on it', () => {
    expect(scopeText('Press "Brief": See the brief. It goes to /dashboard/war-room.', scope)).toBe('Press "Brief": See the brief.');
    expect(scopeText('Open [open_client] leads to Client (/clients/c_1).\nHelp [help] leads to Help (/help).', scope)).toBe('Help [help] leads to Help (/help).');
  });

  it('takes such a route out of a list of routes, wherever it is in it', () => {
    expect(scopeText('Feedback Bar, on /, /dashboard/war-room.', scope)).toBe('Feedback Bar, on /.');
    expect(scopeText('Person (/clients/:id, /people/:id)', scope)).toBe('Person (/people/:id)');
    expect(scopeText('Around /clients/:id, /dashboard/war-room, /help (Frame): Search', scope)).toBe('Around /help (Frame): Search');
  });

  it('leaves out the whole of an item that names one, its own words too', () => {
    expect(scopeText('In the menu:\n- Brief [brief]: Goes to the brief. Read it each morning. (goes to /dashboard/war-room)\n- Help [help]', scope)).toBe(
      'In the menu:\n- Help [help]',
    );
  });

  it('drops a heading whose items all went, and keeps one with an item left', () => {
    const text = 'What you can do here:\nOn the page:\n- Brief [brief] (goes to /dashboard/war-room)\nIn the Help dialog:\n- Search [search]\n- Open [open] (goes to /clients/:id)';
    expect(scopeText(text, scope)).toBe('What you can do here:\nIn the Help dialog:\n- Search [search]');
  });

  it('keeps a path prefix, a slash between words, a page it may see, and a text that names none, as written', () => {
    for (const text of ['Notes, on every page under /dashboard.', 'Group (⌘G / Ctrl+G).', 'It goes to /people/p_1.', 'Nothing here names a page.']) {
      expect(scopeText(text, scope)).toBe(text);
    }
    expect(scopeText('It goes to /dashboard/war-room.', routeScope([{ routes: ['/dashboard/war-room'], gates: { '/dashboard/war-room': ['government'] } }], () => true))).toBe(
      'It goes to /dashboard/war-room.',
    );
  });
});
