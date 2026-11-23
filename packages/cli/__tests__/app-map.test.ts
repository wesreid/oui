/**
 * The app's map, page descriptions, and the guard on capabilities only a
 * person can reach.
 *
 * On 2026-11-23 the assistant, on a character's page, said a picture's object
 * could not be removed: it knew only the page it was on, the map had "The
 * Image Editor page (/image/:imageId)" for the editor that does it, and the
 * character's only way to add a picture was a `nonAgent` button. The map now
 * says what every page offers and how to reach it; a page is described by what
 * it offers when it declares nothing; and a `nonAgent` control that is the only
 * way into what it does fails the build unless listed on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ControlTable, ManifestAction, ManifestSurface } from '@ouispec/bindings';

import { isDescription, type PageMeta } from '../src/assemble.js';
import { DEFAULT_MAP_CHARS } from '../src/config.js';
import { generate, resolveConfig, writeOrCheck, type GenerateResult } from '../src/index.js';
import { appMap } from '../src/knowledge.js';
import { NON_AGENT_ALLOW_FILE } from '../src/non-agent.js';
import { wholeLiterals } from '../src/program.js';
import { pageLinks } from '@ouispec/bindings';
import { config, TABLE, tempApp } from './fixture-config.js';

describe('the app’s map, on the fixture app', () => {
  let result: GenerateResult;
  beforeAll(async () => {
    result = await generate(config());
  });

  it('lists every page under its sidebar group, a page opened from another under it, by address the rest, then the frame', () => {
    const lines = result.knowledge.overview.content.split('\n');
    expect(lines).toContain('Generation:');
    expect(lines).toContain('Create:');
    expect(lines.find(l => l.startsWith('- Voices /voices: '))).toBeDefined();
    // Opened from Voices with its Add Voice button: indented under it, naming the control.
    expect(lines.find(l => l.startsWith('  - Create Voice /voices/create (from Add Voice): '))).toBeDefined();
    expect(lines.indexOf('Opened by address only:')).toBeGreaterThan(lines.indexOf('Create:'));
    expect(lines.find(l => l.startsWith('- Unbound /unbound'))).toBeDefined();
    expect(lines.find(l => l.startsWith('On every page (the app’s frame): '))).toBeDefined();
    expect(lines.at(-1)).toContain('[app_navigate]');
  });

  it('says what each page offers, a room’s by its menu, and stays within the map’s budget', () => {
    const map = result.knowledge.overview.content;
    expect(map).toContain('Studio /studio: The Type tool: Add text');
    expect(map).toContain('Create Voice /voices/create (from Add Voice): Generate');
    expect(map.length).toBeLessThanOrEqual(DEFAULT_MAP_CHARS);
  });

  it('describes a page that declares nothing by what it offers, and none as "The X page"', () => {
    const create = result.knowledge.pages.find(p => p.surface === 'page:CreateVoicePage')!;
    expect(create.summary.content).toBe('Create Voice (/voices/create): Offers Generate, Direction, Mood, Language and Name, among 13 actions.');
    expect(result.manifest.surfaces.find(s => s.id === 'page:CreateVoicePage')!.description).toBe(
      'Offers Generate, Direction, Mood, Language and Name, among 13 actions.',
    );
    for (const page of result.knowledge.pages) expect(page.summary.content).not.toMatch(/: The .+ page \(/);
  });

  it('is the same, byte for byte, on every run', async () => {
    const again = await generate(config());
    expect(again.knowledge.overview).toEqual(result.knowledge.overview);
    expect(again.manifest.buildId).toBe(result.manifest.buildId);
  });

  it('takes its budget from mapChars, which the contract bounds', () => {
    expect(() => resolveConfig(join(__dirname, 'fixtures/app'), { ...baseSettings(), mapChars: 1000 })).toThrow(/mapChars/);
    expect(resolveConfig(join(__dirname, 'fixtures/app'), { ...baseSettings(), mapChars: 12000 }).mapChars).toBe(12000);
    expect(resolveConfig(join(__dirname, 'fixtures/app'), baseSettings()).mapChars).toBe(DEFAULT_MAP_CHARS);
  });
});

function baseSettings() {
  return { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: [], apiSpec: null, out: 'out' };
}

// ─── Fitting a large app ─────────────────────────────────────────────────────

function action(name: string, title: string, extra: Partial<ManifestAction> = {}): ManifestAction {
  return { name, id: name.replace(/_/g, '.'), source: 'control', control: 'button', title, description: `Press "${title}": ${title}.`, input: { type: 'object' }, reach: [], ...extra };
}

function roomAction(room: string, id: string, title: string, where: string, effect: ManifestAction['effect']): ManifestAction {
  return {
    name: `${room.replace(/-/g, '_')}_${id.replace(/-/g, '_')}`,
    id: `${room}/action/${id}`,
    source: 'room-action',
    title,
    description: `${title}: ${title}. (${where})`,
    input: { type: 'object' },
    effect,
    reach: [{ kind: 'room', room, where }],
  };
}

function meta(surface: string, title: string, routes: string[], nav: string | null = null): PageMeta {
  return { surface, component: surface.split(':')[1], routes, title, description: `${title} things.`, nav, rooms: [], shared: [], sharedReach: {}, shown: [] };
}

describe('the app’s map, fitted to its budget', () => {
  // A studio home, its editor with a room of generative edits, and thirty settings pages.
  const pages: PageMeta[] = [
    meta('page:ImageHome', 'Image Studio', ['/image'], 'Studios › Image Studio'),
    meta('page:ImageEditor', 'Image Editor', ['/image/:imageId']),
    ...Array.from({ length: 30 }, (_, i) => meta(`page:Settings${i}`, `Settings ${i}`, [`/settings/${i}`], `Admin › Settings ${i}`)),
  ];
  const edits = ['Remove', 'Generative Fill', 'Edit by Instruction', 'Relight', 'Expand', 'Harmonize', 'Upscale', 'Recolor'];
  const surfaces: ManifestSurface[] = [
    {
      id: 'page:ImageHome',
      kind: 'page',
      title: 'Image Studio',
      description: '',
      routes: ['/image'],
      observations: [],
      actions: [
        action('image_new', 'New image', { effect: { kind: 'navigate', to: '/image/:imageId' } }),
        action('image_open', 'Open', { effect: { kind: 'navigate', to: '/image/:imageId' }, itemized: true }),
      ],
    },
    { id: 'page:ImageEditor', kind: 'page', title: 'Image Editor', description: '', routes: ['/image/:imageId'], observations: [], actions: [action('editor_back', 'Back', { effect: { kind: 'navigate', to: '/image' } })] },
    {
      id: 'room:image-studio',
      kind: 'room',
      title: 'Image Studio',
      description: 'A layered picture editor',
      routes: ['/image/:imageId'],
      observations: [],
      actions: [
        ...edits.map(t => roomAction('image-studio', t.toLowerCase().replace(/ /g, '-'), t, `Edit › ${t}`, { kind: 'job', estimatedDuration: '10 seconds' })),
        roomAction('image-studio', 'select-object', 'Select an object', 'Select › Object', 'selection'),
        ...Array.from({ length: 40 }, (_, i) => roomAction('image-studio', `layer-${i}`, `Layer thing ${i}`, `Layer › Thing ${i}`, 'edit')),
      ],
    },
    ...Array.from({ length: 30 }, (_, i): ManifestSurface => ({
      id: `page:Settings${i}`,
      kind: 'page',
      title: `Settings ${i}`,
      description: '',
      routes: [`/settings/${i}`],
      observations: [],
      actions: [action(`settings_${i}_save`, 'Save', { effect: { kind: 'mutate', operation: 'x' } }), action(`settings_${i}_name`, 'Name', { control: 'text' })],
    })),
  ];
  const nav = [
    { group: 'Studios', label: 'Image Studio', route: '/image' },
    ...Array.from({ length: 30 }, (_, i) => ({ group: 'Admin', label: `Settings ${i}`, route: `/settings/${i}` })),
  ];
  const map = (budget: number) => appMap(pages, [], surfaces, pageLinks(pages, surfaces), nav, [], budget).content;

  it('keeps every page’s line within the budget, and gives what is left to the pages that make things', () => {
    const text = map(2_000);
    expect(text.length).toBeLessThanOrEqual(2_000);
    for (const page of pages) expect(text).toContain(`- ${page.title} ${page.routes[0]}`);
    const editor = text.split('\n').find(l => l.includes('Image Editor /image/:imageId'))!;
    // Opened from the studio's home, with the control that opens it, and its generative edits first, by their menu.
    expect(editor).toMatch(/^ {2}- Image Editor \/image\/:imageId \(from New image\): Edit: Remove, Generative Fill, Edit by Instruction, Relight, Expand/);
    // A settings page's upkeep never crowds out the editor's edits.
    const settings = text.split('\n').filter(l => l.startsWith('- Settings '));
    expect(settings.every(l => !l.includes('Save'))).toBe(true);
  });

  it('shows more of what a page offers as the budget grows, and marks what it leaves out', () => {
    const small = map(2_000);
    const large = map(6_000);
    const count = (text: string) => text.split('\n').find(l => l.includes('Image Editor'))!.split(/[,;]/).length;
    expect(count(large)).toBeGreaterThan(count(small));
    expect(small.split('\n').find(l => l.includes('Image Editor'))).toMatch(/…$/);
  });
});

// ─── Declared descriptions ───────────────────────────────────────────────────

describe('a declared description', () => {
  it('is a subtitle of three words or more that is not a loading state', () => {
    expect(isDescription('Your voice library.')).toBe(true);
    expect(isDescription('Pictures in layers, edited without changing the original')).toBe(true);
    expect(isDescription('s')).toBe(false);
    expect(isDescription('Loading model catalog…')).toBe(false);
    expect(isDescription('operation operations Loading…')).toBe(false);
    expect(isDescription('· refreshing')).toBe(false);
  });

  it('is only ever a whole literal: a fragment of a template or a sum is not a value on its own', () => {
    const expr = (code: string) => {
      const sf = ts.createSourceFile('x.tsx', `const x = ${code};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      return (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer!;
    };
    expect(wholeLiterals(expr("`${n} model${n === 1 ? '' : 's'} · Loading model catalog…`"))).toEqual([]);
    expect(wholeLiterals(expr("'Your ' + kind + ' library'"))).toEqual([]);
    expect(wholeLiterals(expr("loading ? 'Loading…' : 'Every song you generate'"))).toEqual(['Loading…', 'Every song you generate']);
    expect(wholeLiterals(expr("custom ?? 'Manage your organization settings'"))).toEqual(['Manage your organization settings']);
    expect(wholeLiterals(expr("`The plans your videos are made from`"))).toEqual(['The plans your videos are made from']);
  });
});

describe('a page that offers and shows nothing', () => {
  const routes = [
    "import { Route, Routes } from 'react-router';",
    "import { InvitePage, BlankPage } from './pages';",
    'export function AppRoutes() {',
    '  return (',
    '    <Routes>',
    '      <Route path="/accept-invite" element={<InvitePage />} />',
    '      <Route path="/blank" element={<BlankPage />} />',
    '    </Routes>',
    '  );',
    '}',
  ].join('\n');
  const pages = [
    '/**',
    ' * Accepts an invitation from its link, then opens the studio.',
    ' *',
    ' * Developer notes in a later paragraph are not part of it.',
    ' */',
    'export function InvitePage() {',
    '  return <p>Accepting invitation…</p>;',
    '}',
    '/** Blank. */',
    'export const BlankPage = () => <p>Nothing</p>;',
  ].join('\n');

  it('is described by its component’s doc comment, and fails without one that describes it', async () => {
    const root = tempApp([DS], routes);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/pages.tsx'), pages);
    const r = await generate(resolveConfig(root, { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@fixture/ds'], apiSpec: null, out: 'out' }));
    expect(r.manifest.surfaces.find(s => s.id === 'page:InvitePage')!.description).toBe('Accepts an invitation from its link, then opens the studio.');
    // "Blank." is not a description: fewer than three words.
    expect(r.errors.map(e => e.message)).toEqual([
      'BlankPage (/blank) has no description, and offers and shows nothing to derive one from: give its PageHeader a subtitle, or its component a doc comment, that says what it is for, or bind its controls',
    ]);
  });
});

// ─── A capability only a person can reach ────────────────────────────────────

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};

const ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { CharacterPage } from './CharacterPage';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/characters/:id" element={<CharacterPage />} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

function characterPage(extra: string[] = []): string {
  return [
    "import { Button } from '@fixture/ds';",
    'declare const fileInput: { click(): void };',
    'function rename() {}',
    'function removeImage() {}',
    'export function CharacterPage() {',
    '  return (',
    '    <>',
    "      <Button agent={{ id: 'characters.rename', description: 'Rename the character' }} onClick={() => rename()}>Rename</Button>",
    "      <Button agent={{ id: 'characters.images.remove', description: 'Remove an image' }} onClick={removeImage}>Remove</Button>",
    // The only way to add a picture: the person's file chooser, which a bound control never opens.
    "      <Button agent={{ nonAgent: 'opens the file chooser' }} onClick={() => fileInput.click()}>Add Images</Button>",
    // A shortcut to what a bound control does: not the only way in.
    "      <Button agent={{ nonAgent: 'a shortcut the person uses; the assistant renames by the form' }} onClick={() => rename()}>F2</Button>",
    // Names the action the assistant uses instead.
    "      <Button agent={{ nonAgent: 'the assistant uses characters_images_remove' }} onClick={() => fileInput.click()}>Drop here</Button>",
    ...extra,
    '    </>',
    '  );',
    '}',
  ].join('\n');
}

function app(page = characterPage()): string {
  const root = tempApp([DS], ROUTES);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('src/CharacterPage.tsx', page);
  return root;
}

const run = (root: string, allowNonAgent = false) =>
  generate(resolveConfig(root, { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@fixture/ds'], apiSpec: null, out: 'out' }), { allowNonAgent });

describe('a nonAgent control that is the only way into what it does', () => {
  it('fails the build, naming it, and only it', async () => {
    const r = await run(app());
    const guard = r.errors.filter(e => e.message.includes('is the only way into what it does'));
    expect(guard.map(e => [e.file, e.line])).toEqual([['src/CharacterPage.tsx', 10]]);
    expect(guard[0].message).toContain('("opens the file chooser")');
    expect(guard[0].message).toContain('oui generate --allow-non-agent');
    expect(r.nonAgentOnly).toEqual([{ file: 'src/CharacterPage.tsx', line: 10, reason: 'opens the file chooser' }]);
  });

  it('is listed on purpose with --allow-non-agent, after which the build passes', async () => {
    const root = app();
    const listed = await run(root, true);
    expect(listed.errors).toEqual([]);
    const cfg = resolveConfig(root, { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@fixture/ds'], apiSpec: null, out: 'out' });
    writeOrCheck(listed, cfg, false);
    const list = JSON.parse(readFileSync(join(root, 'out', NON_AGENT_ALLOW_FILE), 'utf8'));
    expect(list.files).toEqual({ 'src/CharacterPage.tsx': { 'opens the file chooser': 1 } });
    expect((await run(root)).errors).toEqual([]);
    // `--check` reads the list as committed: up to date.
    expect(writeOrCheck(await run(root), cfg, true)).toEqual([]);
  });

  it('fails a second such control the list does not allow, and a listing nothing matches any more', async () => {
    const root = app();
    const cfg = resolveConfig(root, { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@fixture/ds'], apiSpec: null, out: 'out' });
    writeOrCheck(await run(root, true), cfg, false);

    writeFileSync(
      join(root, 'src/CharacterPage.tsx'),
      characterPage(["      <Button agent={{ nonAgent: 'opens the file chooser' }} onClick={() => fileInput.click()}>Upload</Button>"]),
    );
    const more = await run(root);
    expect(more.errors.map(e => [e.file, e.line])).toEqual([['src/CharacterPage.tsx', 13]]);

    // The control bound: its listing is stale, and the list only shrinks.
    writeFileSync(join(root, 'src/CharacterPage.tsx'), characterPage().replace("agent={{ nonAgent: 'opens the file chooser' }}", "agent={{ id: 'characters.images.add', description: 'Add images' }}"));
    const fewer = await run(root);
    expect(fewer.errors.map(e => e.message)).toEqual([
      'src/CharacterPage.tsx: "opens the file chooser" is listed 1 time(s) but 0 such control(s) remain: the list only shrinks, so run oui generate --allow-non-agent to take it off',
    ]);
    expect(existsSync(join(root, 'out', NON_AGENT_ALLOW_FILE))).toBe(true);
  });
});
