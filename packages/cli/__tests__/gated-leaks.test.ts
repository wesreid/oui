/**
 * A page a session may not see is named nowhere the assistant reads.
 *
 * Upgrading nova-ui (2026-11-25), a tab of one brand still named another
 * brand's pages: the navigation action's description listed every page of the
 * build, and the shared Home's neighbours named a gated page. Here a gated
 * page (War Room) is reached from an ungated Home by a button, shares a part
 * with it, and is in the sidebar; for a session that may not see it, its name
 * and its route appear nowhere in the tab's snapshot (every surface's
 * actions, descriptions and observations), in the knowledge the turn carries
 * (the map, the page's entries and workflows), in the app-wide search or the
 * page guide.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSurfaceRuntime } from 'oui-spec/core';
import { describe, expect, it } from 'vitest';

import {
  createBindingRegistry,
  createKnowledgeLookup,
  resolveKnowledge,
  scopeKnowledge,
  scopeManifest,
  type ControlTable,
  type GateFilter,
} from '@ouispec/bindings';
import { connectBindings, type AppNavigation } from '@ouispec/bindings/oui';

import { generate, resolveConfig, type GenerateResult } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};

const ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { FeatureRoute } from './FeatureRoute';",
  "import { HomePage, WarRoomPage, WarRoomBriefPage, HelpPage } from './pages';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/" element={<HomePage />} />',
  '      <Route path="/help" element={<HelpPage />} />',
  '      <Route path="/war-room" element={<FeatureRoute feature="government"><WarRoomPage /></FeatureRoute>} />',
  '      <Route path="/war-room/brief" element={<FeatureRoute feature="government"><WarRoomBriefPage /></FeatureRoute>} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const PAGES = [
  "import { useNavigate } from 'react-router';",
  "import { Button } from '@fixture/ds';",
  // A part both Home and War Room render: a shared surface on both routes.
  'export function FeedbackBar() {',
  "  return <Button agent={{ id: 'feedback.send', description: 'Send feedback about the app' }} onClick={() => {}}>Send feedback</Button>;",
  '}',
  '/** Start the day from the overview of everything */',
  'export function HomePage() {',
  '  const navigate = useNavigate();',
  '  return (',
  '    <>',
  "      <Button agent={{ id: 'home.start', description: 'Start the day' }} onClick={() => {}}>Start</Button>",
  // An ungated page's control that goes to the gated page.
  "      <Button agent={{ id: 'home.brief', description: 'See the morning brief' }} onClick={() => navigate('/war-room')}>Morning brief</Button>",
  "      <Button agent={{ id: 'home.help', description: 'Read the answers' }} onClick={() => navigate('/help')}>Help</Button>",
  '      <FeedbackBar />',
  '    </>',
  '  );',
  '}',
  '/** Answers to what people ask about the app */',
  'export function HelpPage() {',
  '  const navigate = useNavigate();',
  "  return <Button agent={{ id: 'help.search', description: 'Search the answers' }} onClick={() => {}}>Search</Button>;",
  '}',
  '/** Where a campaign team follows the day hour by hour */',
  'export function WarRoomPage() {',
  '  const navigate = useNavigate();',
  '  return (',
  '    <>',
  "      <Button agent={{ id: 'warroom.refresh', description: 'Refresh the war room' }} onClick={() => {}}>Refresh</Button>",
  "      <Button agent={{ id: 'warroom.brief', description: 'Open the brief' }} onClick={() => navigate('/war-room/brief')}>Brief</Button>",
  "      <Button agent={{ id: 'warroom.home', description: 'Back to the overview' }} onClick={() => navigate('/')}>Overview</Button>",
  '      <FeedbackBar />',
  '    </>',
  '  );',
  '}',
  '/** The war room brief, written each morning */',
  'export function WarRoomBriefPage() {',
  "  return <Button agent={{ id: 'warroom.brief.print', description: 'Print the brief' }} onClick={() => {}}>Print</Button>;",
  '}',
].join('\n');

const NAV = [
  'export const NAV = [',
  "  { label: 'Home', route: '/', group: 'Main' },",
  "  { label: 'Help', route: '/help', group: 'Main' },",
  "  { label: 'War Room', route: '/war-room', group: 'Government' },",
  '];',
].join('\n');

function app(): string {
  const root = tempApp([DS], ROUTES);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('src/pages.tsx', PAGES);
  write('src/nav.ts', NAV);
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

/** What names the gated pages: their titles, their routes and their surfaces' ids. */
const NAMES = [/war room/i, /war-room/i, /WarRoom/];

/** Every place in a value where a text names a gated page, by its path. */
function leaks(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return NAMES.some(n => n.test(value)) ? [`${path}: ${value.slice(0, 160)}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [...(NAMES.some(n => n.test(k)) ? [`${path} key ${k}`] : []), ...leaks(v, `${path}.${k}`)]);
  }
  return [];
}

const noGovernment: GateFilter = gate => gate !== 'government';

function router(start: string): AppNavigation {
  let path = start;
  return { navigate: (to: string) => void (path = to), location: () => path, subscribe: () => () => {} };
}

/** The Home page's controls, registered as the page renders them. */
function renderHome(registry: ReturnType<typeof createBindingRegistry>): void {
  for (const [id, title] of [
    ['home.start', 'Start'],
    ['home.brief', 'Morning brief'],
    ['home.help', 'Help'],
    ['feedback.send', 'Send feedback'],
  ]) {
    registry.registerControl({ id, kind: 'button', title, valueSchema: null, run: () => ({ ok: true }) });
  }
}

describe('a page the session may not see', () => {
  let r: GenerateResult;
  const build = async () => (r ??= await run());
  const run = () => generate(resolveConfig(app(), SETTINGS));

  it('is gated, and named from the ungated page in the build as a whole', async () => {
    await build();
    expect(r.errors).toEqual([]);
    // The fixture does what it means to: the whole build names it from Home.
    expect(leaks(resolveKnowledge(r.knowledge, '/'))).not.toEqual([]);
    expect(leaks(r.manifest.surfaces.find(s => s.id === 'page:HomePage'))).not.toEqual([]);
  });

  it('is named nowhere in the tab’s snapshot: no surface, action, description or observation', async () => {
    await build();
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
    const disconnect = connectBindings({ registry, runtime, manifest: r.manifest, knowledge: r.knowledge, navigation: router('/'), allows: noGovernment });
    renderHome(registry);
    await new Promise(resolve => setTimeout(resolve, 0));
    const snapshot = runtime.snapshot();
    expect(snapshot.surfaces.map(s => s.id)).toContain('page:HomePage');
    expect(leaks(snapshot)).toEqual([]);
    // In the index form an agent worker reads too.
    const indexed = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
    const disconnectIndexed = connectBindings({ registry, runtime: indexed, manifest: r.manifest, knowledge: r.knowledge, navigation: router('/'), allows: noGovernment });
    expect(leaks(indexed.snapshot())).toEqual([]);
    disconnectIndexed();
    disconnect();
  });

  it('is named nowhere in the knowledge the turn carries: the map, the page’s entries and workflows', async () => {
    await build();
    for (const path of ['/', '/help', '/war-room']) expect(leaks(resolveKnowledge(r.knowledge, path, { allows: noGovernment }))).toEqual([]);
    expect(leaks(scopeKnowledge(r.knowledge, noGovernment))).toEqual([]);
    expect(leaks(scopeManifest(r.manifest, noGovernment))).toEqual([]);
  });

  it('is named nowhere the app-wide search or the page guide answers', async () => {
    await build();
    const lookup = createKnowledgeLookup({ knowledge: r.knowledge, manifest: r.manifest, location: () => '/', allows: noGovernment });
    // What the search answers, less the words it was asked, which it says back.
    const answered = (answer: { success: boolean; data?: unknown; error?: unknown }) =>
      answer.success ? { ...(answer.data as Record<string, unknown>), query: undefined } : { error: 'refused' };
    for (const query of ['brief', 'war room', 'feedback', 'overview', 'refresh', 'print', 'help', 'start', 'send']) {
      expect(leaks(answered(lookup.find({ query, limit: 10 })))).toEqual([]);
    }
    for (const page of ['Home', '/', 'Help']) {
      const guide = lookup.guide({ page });
      expect(guide.success).toBe(true);
      expect(leaks(guide)).toEqual([]);
    }
    // Asked for by its name or its address, it is no page, and the answer names only the pages there are.
    for (const page of ['War Room', '/war-room', '/war-room/brief']) {
      const guide = lookup.guide({ page }) as { success: false; error: { code: string; message: string } };
      expect(guide).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
      expect(guide.error.message.split('Pages: ')[1]).toBe('"Help", "Home".');
    }
  });

  it('is named as before for a session that may see it', async () => {
    await build();
    expect(leaks(resolveKnowledge(r.knowledge, '/', { allows: () => true }))).toEqual(leaks(resolveKnowledge(r.knowledge, '/')));
    expect(scopeManifest(r.manifest, () => true)).toEqual(r.manifest);
  });
});
