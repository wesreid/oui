/**
 * The surface of a control shared between pages: the outermost component that renders it on every
 * page it is on, and on no other. A document whose sections are each a component, rendered by two
 * pages, is one shared surface named by the document; a field one of its sections uses and a third
 * page uses as well is a surface of its own. Every action keeps its id: only the grouping moves.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ManifestSurface } from '@ouispec/bindings';

import { generate, resolveConfig } from '../src/index.js';
import { sharedOwner } from '../src/assemble.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: {
    'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button, Input: TABLE.Input, Select: TABLE.Select }),
  },
};

const ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { EditorPage } from './EditorPage';",
  "import { RoomPage } from './RoomPage';",
  "import { PeoplePage } from './PeoplePage';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/editor" element={<EditorPage />} />',
  '      <Route path="/room" element={<RoomPage />} />',
  '      <Route path="/people" element={<PeoplePage />} />',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const FILES: Record<string, string> = {
  // A field a section uses, and a third page as well.
  'src/PersonField.tsx': [
    "import { Select } from '@fixture/ds';",
    'export function PersonField() {',
    "  return <Select label=\"Person\" options={[]} value=\"\" onChange={() => {}} agent={{ id: 'person.pick', description: 'Who it is' }} />;",
    '}',
  ].join('\n'),
  'src/Sections.tsx': [
    "import { Button, Input } from '@fixture/ds';",
    "import { PersonField } from './PersonField';",
    'export function BriefSection() {',
    '  return (',
    '    <div>',
    "      <Input label=\"Brief\" value=\"\" onChange={() => {}} agent={{ id: 'doc.brief', description: 'What it is about' }} />",
    "      <Button onClick={() => {}} agent={{ id: 'doc.brief.clear', description: 'Clear the brief' }}>Clear</Button>",
    '    </div>',
    '  );',
    '}',
    'export function CastSection() {',
    '  return (',
    '    <div>',
    "      <Input label=\"Role\" value=\"\" onChange={() => {}} agent={{ id: 'doc.cast.role', description: 'The part played' }} />",
    '      <PersonField />',
    '    </div>',
    '  );',
    '}',
  ].join('\n'),
  // The document: its sections, each a component, and a control of its own.
  'src/Document.tsx': [
    "import { Button } from '@fixture/ds';",
    "import { BriefSection, CastSection } from './Sections';",
    'export function Document() {',
    '  return (',
    '    <div>',
    "      <Button onClick={() => {}} agent={{ id: 'doc.approve', description: 'Approve it' }}>Approve</Button>",
    '      <BriefSection />',
    '      <CastSection />',
    '    </div>',
    '  );',
    '}',
  ].join('\n'),
  // The editor renders the document inside a panel of its own; the room renders it directly.
  'src/EditorPage.tsx': [
    "import { Button } from '@fixture/ds';",
    "import { Document } from './Document';",
    'function Panel() {',
    '  return <Document />;',
    '}',
    'export function EditorPage() {',
    '  return (',
    '    <div>',
    "      <Button onClick={() => {}} agent={{ id: 'editor.play', description: 'Play' }}>Play</Button>",
    '      <Panel />',
    '    </div>',
    '  );',
    '}',
  ].join('\n'),
  'src/RoomPage.tsx': [
    "import { Document } from './Document';",
    'export function RoomPage() {',
    '  return <Document />;',
    '}',
  ].join('\n'),
  'src/PeoplePage.tsx': [
    "import { PersonField } from './PersonField';",
    'export function PeoplePage() {',
    '  return <PersonField />;',
    '}',
  ].join('\n'),
};

function app(): string {
  const root = tempApp([DS], ROUTES);
  // tempApp writes the routes and the design system; the pages are this test's.
  for (const [path, content] of Object.entries(FILES)) writeFileSync(join(root, path), content);
  return root;
}

async function run() {
  return generate(
    resolveConfig(app(), {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      designSystem: ['@fixture/ds'],
      apiSpec: null,
      out: 'src/agent/generated',
    }),
  );
}

const byId = (surfaces: readonly ManifestSurface[]) =>
  Object.fromEntries(surfaces.map(s => [s.id, s.actions.map(a => a.name).sort()]));

describe('a control shared between pages', () => {
  it('is a surface of the outermost component that renders it on exactly those pages', async () => {
    const r = await run();
    expect(r.errors).toEqual([]);
    const surfaces = byId(r.manifest.surfaces);
    // The document and its sections: one surface, named by the document, on the editor and the room.
    expect(surfaces['shared:Document']).toEqual(['doc_approve', 'doc_brief', 'doc_brief_clear', 'doc_cast_role']);
    const doc = r.manifest.surfaces.find(s => s.id === 'shared:Document')!;
    expect(doc.routes).toEqual(['/editor', '/room']);
    expect(doc.title).toBe('Document');
    // No surface per section.
    expect(Object.keys(surfaces)).not.toContain('shared:BriefSection');
    expect(Object.keys(surfaces)).not.toContain('shared:CastSection');
    // A field the third page uses too is shared by all three: a surface of its own.
    expect(surfaces['shared:PersonField']).toEqual(['person_pick']);
    expect(r.manifest.surfaces.find(s => s.id === 'shared:PersonField')!.routes).toEqual([
      '/editor',
      '/people',
      '/room',
    ]);
    // A page's own control stays on its page.
    expect(surfaces['page:EditorPage']).toEqual(['editor_play']);
  });

  it('is generated the same way every time', async () => {
    const [a, b] = [await run(), await run()];
    expect(byId(a.manifest.surfaces)).toEqual(byId(b.manifest.surfaces));
  });
});

describe('sharedOwner', () => {
  const pages = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

  it('takes the outermost component of the chains’ common end whose pages are the control’s own', () => {
    const chains = new Map([
      ['EditorPage', ['EditorPage', 'Panel', 'Document', 'CastSection']],
      ['RoomPage', ['RoomPage', 'Document', 'CastSection']],
    ]);
    const where = pages({
      EditorPage: ['EditorPage'],
      Panel: ['EditorPage'],
      RoomPage: ['RoomPage'],
      Document: ['EditorPage', 'RoomPage'],
      CastSection: ['EditorPage', 'RoomPage'],
    });
    expect(sharedOwner({ component: 'CastSection' }, new Set(['EditorPage', 'RoomPage']), chains, where)).toBe(
      'Document',
    );
  });

  it('skips a component that renders on more pages than the control does', () => {
    const chains = new Map([
      ['A', ['A', 'Shell', 'Form']],
      ['B', ['B', 'Shell', 'Form']],
    ]);
    // Shell renders on a third page too (with other controls under it): Form is the owner.
    const where = pages({ Shell: ['A', 'B', 'C'], Form: ['A', 'B'] });
    expect(sharedOwner({ component: 'Form' }, new Set(['A', 'B']), chains, where)).toBe('Form');
  });

  it('falls back to the declaring component when nothing is known of its chains', () => {
    expect(sharedOwner({ component: 'Field' }, new Set(['A', 'B']), undefined, new Map())).toBe('Field');
  });
});
