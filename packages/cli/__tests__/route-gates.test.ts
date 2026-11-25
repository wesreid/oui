/**
 * One build, several brands: routes a gating wrapper opens only to some
 * sessions (`routeGates`), and the build as each session sees it.
 *
 * nova-ui is one build serving several brands, each opening some pages
 * (`<FeatureRoute feature={FEATURE_KEYS.campaigns}>`). The generator read the
 * wrapper as a wrapper and nothing more, so every page was in the map and the
 * app-wide search for every brand: a person of one brand would be told of
 * another's pages. Each route now records its gates, the map is carried line
 * by line, and a tab given what the session may see (`allows`) tells the
 * assistant only of the pages open to it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appMapContent,
  createKnowledgeLookup,
  NAVIGATION_SURFACE_ID,
  resolveKnowledge,
  scopeManifest,
  type ControlTable,
  type GateFilter,
} from '@ouispec/bindings';

import { generate, resolveConfig, type GenerateResult } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};

const ROUTES = [
  "import { Outlet, Route, Routes } from 'react-router';",
  "import { FeatureRoute } from './FeatureRoute';",
  "import { FEATURES } from './features';",
  "import { CampaignsPage, HelpPage, HomePage, NewCampaignPage, PeoplePage, PersonPage, ReportsPage } from './pages';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/" element={<HomePage />} />',
  '      <Route path="/campaigns" element={<FeatureRoute feature="campaigns"><CampaignsPage /></FeatureRoute>} />',
  '      <Route path="/campaigns/new" element={<FeatureRoute feature="campaigns"><NewCampaignPage /></FeatureRoute>} />',
  '      <Route path="/help" element={<HelpPage />} />',
  '      <Route path="/reports" element={<FeatureRoute feature={FEATURES.reports}><ReportsPage /></FeatureRoute>} />',
  '      <Route path="/admin" element={<FeatureRoute feature="admin"><Outlet /></FeatureRoute>}>',
  '        <Route path="users" element={<FeatureRoute feature={FEATURES.people}><PeoplePage /></FeatureRoute>} />',
  '      </Route>',
  '      <Route path="/people/:id" element={<FeatureRoute feature="people"><PersonPage /></FeatureRoute>} />',
  '      <Route path="/clients/:id" element={<FeatureRoute feature="clients"><PersonPage /></FeatureRoute>} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const page = (name: string, id: string, description: string, extra = '') =>
  [
    `/** ${description} */`,
    `export function ${name}() {`,
    '  const navigate = useNavigate();',
    `  return <>${extra}<Button agent={{ id: '${id}', description: '${description}' }} onClick={() => {}}>Go</Button></>;`,
    '}',
  ].join('\n');

const PAGES = [
  "import { useNavigate } from 'react-router';",
  "import { Button } from '@fixture/ds';",
  page('HomePage', 'home.start', 'Start the day from the overview of everything'),
  page(
    'CampaignsPage',
    'campaigns.refresh',
    'Every campaign the brand runs, newest first',
    "<Button agent={{ id: 'campaigns.new', description: 'Start a new campaign' }} onClick={() => navigate('/campaigns/new')}>New campaign</Button>" +
      "<Button agent={{ id: 'campaigns.help', description: 'Read how campaigns work' }} onClick={() => navigate('/help')}>Help</Button>",
  ),
  page('NewCampaignPage', 'campaigns.create', 'Make a campaign from a template and an audience'),
  page('HelpPage', 'help.search', 'Answers to what people ask about the app'),
  page('ReportsPage', 'reports.export', 'Every report the brand reads, by week'),
  page('PeoplePage', 'people.invite', 'Who can sign in to the account, and their roles'),
  page('PersonPage', 'person.edit', 'One person: their details, their history and their notes'),
].join('\n');

const NAV = [
  'export const NAV = [',
  "  { label: 'Home', route: '/', group: 'Main' },",
  "  { label: 'Campaigns', route: '/campaigns', group: 'Marketing' },",
  "  { label: 'Reports', route: '/reports', group: 'Marketing' },",
  '];',
].join('\n');

function app(routes = ROUTES): string {
  const root = tempApp([DS], routes);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('src/pages.tsx', PAGES);
  write('src/nav.ts', NAV);
  write('src/features.ts', "export const FEATURES = { reports: 'reports', people: 'people' } as const;");
  write(
    'src/FeatureRoute.tsx',
    'export function FeatureRoute({ children }: { feature: string; children?: unknown }) { return <>{children}</>; }',
  );
  return root;
}

const SETTINGS = {
  tsconfig: 'tsconfig.json',
  routes: 'src/routes.tsx',
  nav: ['src/nav.ts'],
  designSystem: ['@fixture/ds'],
  apiSpec: null,
  out: 'out',
  routeWrappers: ['FeatureRoute'],
  routeGates: { FeatureRoute: 'feature' },
};

const run = (root: string, settings: Record<string, unknown> = SETTINGS) => generate(resolveConfig(root, settings));
const surface = (r: GenerateResult, id: string) => r.manifest.surfaces.find(s => s.id === id);
const only =
  (...gates: string[]): GateFilter =>
  gate =>
    gates.includes(gate);

describe('a gated route, in the generated build', () => {
  it('records each route’s gates, outermost first, read from literals and constants', async () => {
    const r = await run(app());
    expect(r.errors).toEqual([]);
    expect(surface(r, 'page:HomePage')!.gates).toBeUndefined();
    expect(surface(r, 'page:CampaignsPage')!.gates).toEqual({ '/campaigns': ['campaigns'] });
    expect(surface(r, 'page:ReportsPage')!.gates).toEqual({ '/reports': ['reports'] });
    // A parent route's gate, then its own.
    expect(surface(r, 'page:PeoplePage')!.gates).toEqual({ '/admin/users': ['admin', 'people'] });
    // One page on two routes, each with its own gate.
    expect(surface(r, 'page:PersonPage')!.gates).toEqual({ '/clients/:id': ['clients'], '/people/:id': ['people'] });
    // The knowledge's pages carry them as the manifest's do.
    for (const p of r.knowledge.pages) expect(p.gates).toEqual(surface(r, p.surface)!.gates);
  });

  it('carries the map line by line, which renders as the overview with every page shown', async () => {
    const r = await run(app());
    expect(r.knowledge.map).toBeDefined();
    expect(appMapContent(r.knowledge.map!)).toBe(r.knowledge.overview.content);
    const line = (surfaceId: string) => r.knowledge.map!.find(l => l.kind === 'page' && l.surface === surfaceId);
    // Under the page that opens it when that page is open whenever it is.
    expect(line('page:NewCampaignPage')).toMatchObject({ depth: 1, from: 'New campaign' });
    // Never under a page some session may not see: Help is open to every session, Campaigns is not.
    expect(line('page:HelpPage')).toMatchObject({ depth: 0 });
    expect(line('page:HelpPage')).not.toHaveProperty('from');
  });

  it('fails a gate the build cannot read, and a gating wrapper that names none, as it fails an unreadable path', async () => {
    const routes = ROUTES.replace('feature={FEATURES.reports}', 'feature={pickFeature()}')
      .replace('<FeatureRoute feature="clients">', '<FeatureRoute>')
      .replace('export function AppRoutes()', 'declare function pickFeature(): string;\nexport function AppRoutes()');
    const r = await run(app(routes));
    expect(r.errors.map(e => e.message).sort()).toEqual([
      '<FeatureRoute> must name its gate in feature: the route would otherwise be open to every session',
      '<FeatureRoute>’s feature must be readable at build time: a literal or a constant, never computed when the page renders',
    ]);
  });

  it('refuses a gate that is not a route wrapper', () => {
    expect(() => resolveConfig(app(), { ...SETTINGS, routeWrappers: [] })).toThrow(
      '"routeGates" names FeatureRoute, which "routeWrappers" does not list',
    );
  });
});

describe('the build as a session sees it', () => {
  it('gives the map without the pages it may not see, headings included', async () => {
    const r = await run(app());
    const map = (allows: GateFilter) => resolveKnowledge(r.knowledge, '/', { allows }).map!.content;
    const seen = map(only('reports'));
    expect(seen).toContain('- Reports /reports');
    expect(seen).not.toContain('/campaigns');
    expect(seen).not.toContain('Campaigns');
    expect(seen).toContain('- Help /help');
    expect(seen).not.toContain('/admin/users');
    // A page on two routes is named by the one the session may see.
    expect(map(only('clients'))).toContain('/clients/:id');
    expect(map(only('clients'))).not.toContain('/people/:id');
    // Nothing of a group the session sees no page of.
    expect(map(only()).split('\n')).not.toContain('Marketing:');
    // Every gate allowed, or no predicate: the whole map.
    expect(map(() => true)).toBe(r.knowledge.overview.content);
    expect(resolveKnowledge(r.knowledge, '/').map!.content).toBe(r.knowledge.overview.content);
  });

  it('gives no page’s knowledge on a page it may not see, and leaves such pages out of the neighbours', async () => {
    const r = await run(app());
    const onCampaigns = resolveKnowledge(r.knowledge, '/campaigns', { allows: only() });
    expect(onCampaigns.entries.map(e => e.title)).toEqual(['The app’s pages']);
    const allowed = resolveKnowledge(r.knowledge, '/campaigns', { allows: only('campaigns') });
    expect(allowed.entries.map(e => e.title)).toContain('Campaigns (/campaigns)');
    expect(allowed.entries.map(e => e.title)).toContain('New Campaign');
  });

  it('searches and guides only the pages it may see', async () => {
    const r = await run(app());
    const lookup = (allows?: GateFilter) => createKnowledgeLookup({ knowledge: r.knowledge, manifest: r.manifest, location: () => '/', ...(allows ? { allows } : {}) });
    const tools = (allows?: GateFilter) => {
      const answer = lookup(allows).find({ query: 'campaign', limit: 10 });
      expect(answer.success).toBe(true);
      return ((answer as { data: { results: { tool: string }[] } }).data.results).map(x => x.tool);
    };
    expect(tools()).toContain('campaigns_create');
    expect(tools(only('reports'))).not.toContain('campaigns_create');
    expect(tools(only('campaigns'))).toContain('campaigns_create');

    const guide = lookup(only('reports')).guide({ page: '/campaigns' });
    expect(guide.success).toBe(false);
    expect(lookup(only('reports')).guide({ page: 'Campaigns' }).success).toBe(false);
    expect(lookup(only('campaigns')).guide({ page: '/campaigns' }).success).toBe(true);
    // An address on a page the session may not see is no page, never a less specific one.
    expect(lookup(only('people')).guide({ page: '/clients/c1' }).success).toBe(false);
    expect(lookup(only('people')).guide({ page: '/people/p1' }).success).toBe(true);
  });

  it('offers only the pages it may see to go to', async () => {
    const r = await run(app());
    const nav = (allows?: GateFilter) => scopeManifest(r.manifest, allows).surfaces.find(s => s.id === NAVIGATION_SURFACE_ID)!;
    expect(nav(only('reports')).routes).toEqual(['/', '/help', '/reports']);
    expect(nav(only('reports')).actions[0].input.properties!.path.description).not.toContain('/campaigns');
    expect(nav(only('admin', 'people')).routes).toEqual(['/', '/admin/users', '/help', '/people/:id']);
    expect(nav()).toEqual(r.manifest.surfaces.find(s => s.id === NAVIGATION_SURFACE_ID));
    expect(scopeManifest(r.manifest, () => true)).toEqual(r.manifest);
  });
});
