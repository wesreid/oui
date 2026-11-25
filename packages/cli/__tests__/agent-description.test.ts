/**
 * A page's description for the assistant only (`@agentDescription`).
 *
 * A page is described by its header's subtitle: copy the person reads, written
 * for them, which may leave out what the assistant needs (Generate music's
 * subtitle never says it takes lyrics). Visible copy is not changed for the
 * assistant's sake, so the page's component may say what the page is for in
 * its doc comment's `@agentDescription` tag. Declared, it is the page's
 * description everywhere the build describes the page: its surface, its
 * knowledge and its line on the app's map. Not declared, the build writes
 * exactly what it wrote before the tag existed (the fixture apps' golden files,
 * ungated-output.test.ts). Under route gates it goes only where its page goes:
 * a session that may not see the page is never told it.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSurfaceRuntime } from 'oui-spec/core';
import { createBindingRegistry, createKnowledgeLookup, resolveKnowledge, scopeKnowledge, scopeManifest, type ControlTable, type GateFilter } from '@ouispec/bindings';
import { connectBindings } from '@ouispec/bindings/oui';

import { generate, resolveConfig, type GenerateResult } from '../src/index.js';
import { config, FIXTURE, FIXTURES, TABLE, tempApp } from './fixture-config.js';

// A copy sits beside the fixture, so the app resolves the generator's own packages (vite) as the fixture does.
const copies: string[] = [];
afterAll(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The fixture app, copied, with each file's text changed as given. */
function fixtureWith(changes: Record<string, (text: string) => string>): string {
  const root = mkdtempSync(join(FIXTURES, '.agent-description-'));
  copies.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  for (const [file, change] of Object.entries(changes)) {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const after = change(before);
    if (after === before) throw new Error(`the change to ${file} changed nothing`);
    writeFileSync(path, after);
  }
  return root;
}

/** A doc comment put on a page's component. */
const documented = (component: string, comment: string) => (text: string) =>
  text.replace(`export function ${component}()`, `${comment}\nexport function ${component}()`);

const CREATE_VOICE = 'Design a new voice from a style, a mood and a language. It is saved to the library once generated.';
const VOICES = 'Every voice the person and their account have, to play, rename, upload and delete.';

describe('a page that declares no description for the assistant', () => {
  // Byte for byte as before: the fixture apps' whole manifest and knowledge, against the golden files (ungated-output.test.ts).
  it('keeps its doc comment’s first paragraph as before, whatever tags follow it', async () => {
    const root = fixtureWith({
      'src/pages/UnboundPage.tsx': documented('UnboundPage', '/**\n * A page left unbound on purpose.\n *\n * @see RawControls\n */'),
    });
    const tagged = await generate(config({}, root));
    expect(tagged.errors).toEqual((await generate(config())).errors);
  });
});

describe('a page that declares its description for the assistant', () => {
  let plain: GenerateResult;
  let declared: GenerateResult;
  beforeAll(async () => {
    plain = await generate(config());
    declared = await generate(
      config(
        {},
        fixtureWith({
          // A page described by what it offers, and one by its subtitle.
          'src/pages/CreateVoicePage.tsx': documented('CreateVoicePage', `/** @agentDescription ${CREATE_VOICE} */`),
          'src/pages/VoicesPage.tsx': documented(
            'VoicesPage',
            `/**\n * The voice library.\n *\n * @agentDescription Every voice the person and their account have,\n * to play, rename, upload and delete.\n */`,
          ),
        }),
      ),
    );
  });

  it('is the description of its surface, in place of its subtitle or what it offers', () => {
    expect(declared.errors).toEqual(plain.errors);
    const surface = (r: GenerateResult, id: string) => r.manifest.surfaces.find(s => s.id === id)!;
    expect(surface(declared, 'page:CreateVoicePage').description).toBe(CREATE_VOICE);
    expect(surface(declared, 'page:VoicesPage').description).toBe(VOICES);
    expect(surface(plain, 'page:VoicesPage').description).toBe('Your voice library. Voices shared with your account.');
  });

  it('is what its knowledge says the page is: its summary’s first sentence and its detail’s first line', () => {
    const page = (id: string) => declared.knowledge.pages.find(p => p.surface === id)!;
    expect(page('page:CreateVoicePage').summary.content).toBe(
      'Create Voice (/voices/create): Design a new voice from a style, a mood and a language.',
    );
    expect(page('page:CreateVoicePage').detail.content.split('\n')[0]).toBe(CREATE_VOICE);
    expect(page('page:VoicesPage').summary.content).toBe(`Voices (/voices), in the sidebar under Generation › Voices: ${VOICES}`);
    expect(page('page:VoicesPage').detail.content.split('\n')[0]).toBe(VOICES);
  });

  it('is said first on the page’s line of the app’s map, before what it offers', () => {
    const line = (r: GenerateResult, start: string) => r.knowledge.overview.content.split('\n').find(l => l.startsWith(start))!;
    expect(line(declared, '  - Create Voice ')).toBe(
      `${'  - Create Voice /voices/create (from Add Voice)'}: Design a new voice from a style, a mood and a language. ${line(plain, '  - Create Voice ').split(': ').slice(1).join(': ')}`,
    );
    expect(line(declared, '- Voices ')).toBe(`- Voices /voices: ${VOICES} ${line(plain, '- Voices ').split(': ').slice(1).join(': ')}`);
  });

  it('changes nothing else the build writes', () => {
    const others = (r: GenerateResult) => ({
      surfaces: r.manifest.surfaces.filter(s => s.id !== 'page:CreateVoicePage' && s.id !== 'page:VoicesPage'),
      actions: r.manifest.surfaces.flatMap(s => s.actions),
      pages: r.knowledge.pages
        .filter(p => p.surface !== 'page:CreateVoicePage' && p.surface !== 'page:VoicesPage')
        .map(p => ({ ...p })),
      frames: r.knowledge.frames,
      mapLines: r.knowledge.overview.content.split('\n').filter(l => !l.startsWith('  - Create Voice ') && !l.startsWith('- Voices ')),
    });
    expect(others(declared)).toEqual(others(plain));
    // The pages' own knowledge differs only in what the page is.
    for (const id of ['page:CreateVoicePage', 'page:VoicesPage']) {
      const [before, after] = [plain, declared].map(r => r.knowledge.pages.find(p => p.surface === id)!);
      expect(after.detail.content.split('\n').slice(1)).toEqual(before.detail.content.split('\n').slice(1));
      expect({ ...after, summary: null, detail: null }).toEqual({ ...before, summary: null, detail: null });
    }
  });

  it('is the same, byte for byte, on every run', async () => {
    const root = fixtureWith({ 'src/pages/CreateVoicePage.tsx': documented('CreateVoicePage', `/** @agentDescription ${CREATE_VOICE} */`) });
    const [a, b] = [await generate(config({}, root)), await generate(config({}, root))];
    expect(b.knowledge).toEqual(a.knowledge);
    expect(b.manifest.buildId).toBe(a.manifest.buildId);
  });
});

describe('an @agentDescription that does not describe the page', () => {
  it.each([
    ['empty', '/** @agentDescription */', "CreateVoicePage's @agentDescription says nothing: write what the page is for after it, or remove it"],
    [
      'two words',
      '/** @agentDescription Voice designer */',
      'CreateVoicePage\'s @agentDescription "Voice designer" does not say what the page is for: write three words or more, not a loading state',
    ],
  ])('fails the build, naming where it is written (%s)', async (_case, comment, message) => {
    const r = await generate(config({}, fixtureWith({ 'src/pages/CreateVoicePage.tsx': documented('CreateVoicePage', comment) })));
    expect(r.errors).toContainEqual({ file: 'src/pages/CreateVoicePage.tsx', line: 5, message });
    // The page is described as it would be without it.
    expect(r.manifest.surfaces.find(s => s.id === 'page:CreateVoicePage')!.description).toBe(
      'Offers Generate, Direction, Mood, Language and Name, among 13 actions.',
    );
  });
});

// ─── Under route gates ───────────────────────────────────────────────────────

const GATED_ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { FeatureRoute } from './FeatureRoute';",
  "import { HomePage, DeskPage } from './pages';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/" element={<HomePage />} />',
  '      <Route path="/desk" element={<FeatureRoute feature="government"><DeskPage /></FeatureRoute>} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

/** What only the gated page's own description says. */
const SECRET = 'hour by hour';
const GATED_PAGES = [
  "import { useNavigate } from 'react-router';",
  "import { Button } from '@fixture/ds';",
  // The open page says what it is for, in a first sentence that also names the gated page's route.
  '/** @agentDescription Start the day from the overview, then open the campaign brief on /desk. Every team starts here. */',
  'export function HomePage() {',
  '  const navigate = useNavigate();',
  '  return (',
  '    <>',
  "      <Button agent={{ id: 'home.start', description: 'Start the day' }} onClick={() => {}}>Start</Button>",
  "      <Button agent={{ id: 'home.desk', description: 'Open the campaign brief' }} onClick={() => navigate('/desk')}>Brief</Button>",
  '    </>',
  '  );',
  '}',
  `/** @agentDescription Where a campaign team follows the vote ${SECRET}, with the polls beside it. */`,
  'export function DeskPage() {',
  "  return <Button agent={{ id: 'desk.refresh', description: 'Refresh the figures' }} onClick={() => {}}>Refresh</Button>;",
  '}',
].join('\n');

function gatedApp(): string {
  const ds = {
    name: '@fixture/ds',
    packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
    files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
  };
  const root = tempApp([ds], GATED_ROUTES);
  writeFileSync(join(root, 'src/pages.tsx'), GATED_PAGES);
  writeFileSync(join(root, 'src/nav.ts'), "export const NAV = [{ label: 'Home', route: '/', group: 'Main' }];");
  writeFileSync(
    join(root, 'src/FeatureRoute.tsx'),
    'export function FeatureRoute({ children }: { feature: string; children?: unknown }) { return <>{children}</>; }',
  );
  return root;
}

const GATED_SETTINGS = {
  tsconfig: 'tsconfig.json',
  routes: 'src/routes.tsx',
  nav: ['src/nav.ts'],
  designSystem: ['@fixture/ds'],
  apiSpec: null,
  out: 'out',
  routeWrappers: ['FeatureRoute'],
  routeGates: { FeatureRoute: 'feature' },
};

const noGovernment: GateFilter = gate => gate !== 'government';
/** Every text in a value that holds what the gated page says, or names it by its route. */
const told = (value: unknown, path = '$'): string[] => {
  if (typeof value === 'string') return value.includes(SECRET) || /\/desk\b/.test(value) ? [`${path}: ${value.slice(0, 160)}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => told(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => told(v, `${path}.${k}`));
  return [];
};

describe('a page’s description for the assistant, under route gates', () => {
  let r: GenerateResult;
  beforeAll(async () => {
    r = await generate(resolveConfig(gatedApp(), GATED_SETTINGS));
  });

  it('is on the page’s own line of the map, its surface and its knowledge, for a session that may see it', () => {
    expect(r.errors).toEqual([]);
    const desk = r.knowledge.map?.find(l => l.kind === 'page' && l.surface === 'page:DeskPage');
    expect(desk).toMatchObject({ says: `Where a campaign team follows the vote ${SECRET}, with the polls beside it.` });
    expect(r.knowledge.overview.content).toContain(`(from Brief): Where a campaign team follows the vote ${SECRET}`);
    expect(told(resolveKnowledge(r.knowledge, '/', { allows: () => true }))).not.toEqual([]);
  });

  it('never reaches a session that may not see its page: not the map, the knowledge, the manifest, the snapshot, the search or the guide', async () => {
    for (const path of ['/', '/desk']) expect(told(resolveKnowledge(r.knowledge, path, { allows: noGovernment }))).toEqual([]);
    const knowledge = scopeKnowledge(r.knowledge, noGovernment);
    expect(told(knowledge)).toEqual([]);
    expect(told(scopeManifest(r.manifest, noGovernment))).toEqual([]);

    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
    const navigation = { navigate: () => {}, location: () => '/', subscribe: () => () => {} };
    const disconnect = connectBindings({ registry, runtime, manifest: r.manifest, knowledge: r.knowledge, navigation, allows: noGovernment });
    for (const [id, title] of [['home.start', 'Start'], ['home.desk', 'Brief']]) {
      registry.registerControl({ id, kind: 'button', title, valueSchema: null, run: () => ({ ok: true }) });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(told(runtime.snapshot())).toEqual([]);
    disconnect();

    const lookup = createKnowledgeLookup({ knowledge: r.knowledge, manifest: r.manifest, location: () => '/', allows: noGovernment });
    for (const query of ['vote', 'polls', 'campaign', 'hour']) {
      const answer = lookup.find({ query, limit: 10 });
      expect(told(answer.success ? { ...(answer.data as Record<string, unknown>), query: undefined } : answer)).toEqual([]);
    }
    expect(told(lookup.guide({ page: 'Home' }))).toEqual([]);
  });

  it('of an open page, loses on the map the sentence that names a page the session may not see', () => {
    const home = (k: typeof r.knowledge) => k.overview.content.split('\n').find(l => l.startsWith('- Home /'))!;
    expect(home(r.knowledge)).toContain(': Start the day from the overview, then open the campaign brief on /desk.');
    expect(home(scopeKnowledge(r.knowledge, noGovernment))).not.toContain('campaign brief');
    expect(home(scopeKnowledge(r.knowledge, noGovernment))).toMatch(/^- Home \/: /);
  });
});
