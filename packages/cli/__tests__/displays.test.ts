/**
 * What a page shows, as the manifest records it (`displays`).
 *
 * A page reports what it shows with `useAgentFacts`: in a design-system
 * display (a stat, a card bound to open, a list that names its facts apart
 * from its controls), or in the app's own code (a component that reports a
 * detail pane's lines, a hook). The generator records each under the binding
 * it is reported under, on every page that shows it, so a page's state and
 * an eval can name it. A binding the build cannot read is an error: the page
 * would report facts the manifest does not record.
 *
 * And a frame or a component on every page under one path says so, instead of
 * listing every route it is on.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ControlTable, ManifestSurface } from '@ouispec/bindings';

import { generate, resolveConfig } from '../src/index.js';
import { everyPage } from '../src/assemble.js';
import { TABLE, tempApp } from './fixture-config.js';

const CONTROLS: ControlTable = {
  Button: TABLE.Button,
  // Shows a number: not a control. It always reports how it moved.
  Stat: { callbacks: [], display: { labels: ['Change'] }, titleProps: ['label'] },
  // A card a tap opens, which reports what it shows under the same binding.
  Card: { kind: 'button', callbacks: ['onSelect'], display: {}, titleProps: ['title'] },
  // A list whose rows open; what it shows is named apart (`facts`), else reported under `open`.
  LeadList: {
    callbacks: [],
    slots: { open: { kind: 'button', callback: 'onOpen', rows: true } },
    display: { slot: 'facts', parts: ['open'] },
    titleProps: ['aria-label'],
  },
};

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify(CONTROLS) },
};
/** The bindings' React hook, as its published types declare it. */
const BINDINGS = {
  name: '@ouispec/bindings',
  packageJson: { types: './index.d.ts' },
  files: {
    'index.d.ts': 'export type AgentProp = { id: string; description: string } | { nonAgent: string };',
    'react.d.ts': [
      "import type { AgentProp } from './index';",
      'export declare function useAgentFacts(agent: AgentProp | undefined, title: string, facts: Record<string, unknown>): void;',
    ].join('\n'),
  },
};

const ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { HomePage } from './HomePage';",
  "import { DashLayout, DashPage, SettingsPage } from './Dash';",
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/" element={<HomePage />} />',
  '      <Route path="/dash" element={<DashLayout />}>',
  '        <Route index element={<DashPage />} />',
  '        <Route path="leads" element={<DashPage />} />',
  '        <Route path="leads/:leadId" element={<DashPage />} />',
  '        <Route path="settings" element={<SettingsPage />} />',
  '      </Route>',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const FILES: Record<string, string> = {
  // The app's own way of reporting what a part of a page shows: draws nothing.
  'src/facts.tsx': [
    "import { useAgentFacts } from '@ouispec/bindings/react';",
    "import type { AgentProp } from '@ouispec/bindings';",
    'export function ReportFacts({ agent, title, facts }: { agent: AgentProp | undefined; title: string; facts: Record<string, unknown> }) {',
    '  useAgentFacts(agent, title, facts);',
    '  return null;',
    '}',
  ].join('\n'),
  // An app hook that reports what the page shows.
  'src/use-greeting.ts': [
    "import { useAgentFacts } from '@ouispec/bindings/react';",
    'export function useGreeting(text: string) {',
    "  useAgentFacts({ id: 'home.greeting', description: 'The greeting' }, 'Home', { Greeting: text });",
    '}',
  ].join('\n'),
  'src/HomePage.tsx': [
    "import { Button, Card, LeadList, Stat } from '@fixture/ds';",
    "import { ReportFacts } from './facts';",
    "import { useGreeting } from './use-greeting';",
    "const TOPIC = { id: 'home.topic', description: 'A starter topic: what it holds' } as const;",
    'function topicFacts(count: number, about: string) {',
    '  return { "To work": count, About: about, Opens: "/dash/leads" };',
    '}',
    "const PRODUCTS = { sales: { title: 'Sales' }, service: { title: 'Service' } } as const;",
    '/** A section whose id and words are the props it is given. */',
    "function Section({ factsId, title, product }: { factsId: string; title: string; product: 'sales' | 'service' }) {",
    '  const meta = PRODUCTS[product];',
    '  return <ReportFacts agent={{ id: factsId, description: `${title} of the ${meta.title} figures` }} title={title} facts={{}} />;',
    '}',
    'function Detail({ facts }: { facts?: { id: string; description: string } }) {',
    '  return <ReportFacts agent={facts} title="Detail" facts={{ Name: "Ava" }} />;',
    '}',
    'export function HomePage({ topics, active }: { topics: string[]; active: boolean }) {',
    "  useGreeting('Hi');",
    '  return (',
    '    <div>',
    "      <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>",
    '      {topics.map(t => (',
    '        <ReportFacts key={t} agent={{ ...TOPIC, item: { key: t, title: t } }} title={t} facts={topicFacts(1, t)} />',
    '      ))}',
    "      <ReportFacts agent={active ? { id: 'home.conversation', description: 'The conversation under way' } : undefined} title=\"Now\" facts={{ Turns: 2 }} />",
    "      <Detail facts={{ id: 'home.detail', description: 'The open detail' }} />",
    '      <Detail />',
    '      <Section factsId="home.section" title="By signal" product="service" />',
    "      <ReportFacts agent={{ nonAgent: 'the person’s own notes' }} title=\"Notes\" facts={{}} />",
    "      <Stat label=\"Sold\" value={4} agent={{ id: 'home.sold', description: 'Units sold this month' }} />",
    '      <Stat label="Unbound" value={1} />',
    "      <Card title=\"Leads\" onSelect={() => {}} agent={{ id: 'home.card', description: 'Asks about this card', item: { key: 'leads', title: 'Leads' } }} />",
    "      <LeadList aria-label=\"Leads\" onOpen={() => {}} agent={{ open: { id: 'home.lead.open', description: 'Opens a lead' }, facts: { id: 'home.leads', description: 'The leads on the Home' } }} />",
    "      <LeadList aria-label=\"Hot\" onOpen={() => {}} agent={{ open: { id: 'home.hot.open', description: 'Opens a hot lead' } }} />",
    '    </div>',
    '  );',
    '}',
  ].join('\n'),
  'src/Dash.tsx': [
    "import { Button } from '@fixture/ds';",
    "import { Outlet } from 'react-router';",
    'export function ThemePicker() {',
    "  return <Button agent={{ id: 'theme.toggle', description: 'Light or dark' }} onClick={() => {}}>Theme</Button>;",
    '}',
    'export function DashLayout() {',
    "  return <div><Button agent={{ id: 'dash.menu', description: 'The menu' }} onClick={() => {}}>Menu</Button><ThemePicker /><Outlet /></div>;",
    '}',
    'export function DashPage() {',
    "  return <Button agent={{ id: 'dash.refresh', description: 'Refresh' }} onClick={() => {}}>Refresh</Button>;",
    '}',
    'export function SettingsPage() {',
    '  return <ThemePicker />;',
    '}',
  ].join('\n'),
};

function app(files: Record<string, string> = FILES): string {
  const root = tempApp([DS, BINDINGS], ROUTES);
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

const surface = (surfaces: readonly ManifestSurface[], id: string) => {
  const s = surfaces.find(x => x.id === id);
  if (!s) throw new Error(`no surface ${id}: ${surfaces.map(x => x.id).join(', ')}`);
  return s;
};

describe('what a page shows', () => {
  it('is recorded from every useAgentFacts the page reaches: the app’s own components and hooks, and the design system’s displays', async () => {
    const r = await run();
    expect(r.errors.map(e => e.message)).toEqual([]);
    const home = surface(r.manifest.surfaces, 'page:HomePage');
    expect(home.displays).toEqual([
      // A card that opens reports what it shows under its own binding.
      { id: 'home.card', title: 'Leads', description: 'Asks about this card', labels: [] },
      // Reported only while a condition holds: recorded all the same.
      { id: 'home.conversation', title: 'Now', description: 'The conversation under way', labels: ['Turns'] },
      // A binding passed down through the app's components; one use that passes none reports nothing.
      { id: 'home.detail', title: 'Detail', description: 'The open detail', labels: ['Name'] },
      // From an app hook the page calls.
      { id: 'home.greeting', title: 'Home', description: 'The greeting', labels: ['Greeting'] },
      // A composite with no `facts` binding reports under the first part the page bound.
      { id: 'home.hot.open', title: 'Hot', description: 'Opens a hot lead', labels: [] },
      // A composite's `facts` binding.
      { id: 'home.leads', title: 'Leads', description: 'The leads on the Home', labels: [] },
      // A binding built from the props a component is given, and a constant record read by one.
      { id: 'home.section', title: 'By signal', description: 'By signal of the Service figures', labels: [] },
      // A design-system display, with the labels it always reports.
      { id: 'home.sold', title: 'Sold', description: 'Units sold this month', labels: ['Change'] },
      // One per row of a list, titled by its row, so by its id; its labels read through the app's function that builds them.
      { id: 'home.topic', title: 'Topic', description: 'A starter topic: what it holds', labels: ['To work', 'About', 'Opens'] },
    ]);
    // A display is not a tool; a control that reports what it shows is still one.
    expect(home.actions.map(a => a.id).sort()).toEqual(['home.card', 'home.hot.open', 'home.lead.open', 'home.start']);
    // Reasons a display gives for staying out are read as a control's are.
    expect(JSON.stringify(home)).not.toContain('home.notes');
  });

  it('fails a binding the build cannot read, where it is written', async () => {
    const r = await run(
      app({
        ...FILES,
        'src/HomePage.tsx': [
          "import { useAgentFacts } from '@ouispec/bindings/react';",
          "import { ReportFacts } from './facts';",
          "declare function bindingFor(name: string): { id: string; description: string };",
          'export function HomePage() {',
          "  useAgentFacts(bindingFor('a'), 'A', {});",
          "  return <ReportFacts agent={bindingFor('b')} title=\"B\" facts={{}} />;",
          '}',
        ].join('\n'),
      }),
    );
    const messages = r.errors.map(e => `${e.file}:${e.line} ${e.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^src\/HomePage\.tsx:5 useAgentFacts\(…\)'s binding must be readable at build time \(`bindingFor\('a'\)`\)/),
        expect.stringMatching(/^src\/HomePage\.tsx:6 useAgentFacts\(…\)'s binding must be readable at build time \(`bindingFor\('b'\)`\)/),
      ]),
    );
  });

  it('may share an id with the control it describes, or with itself elsewhere, but only in the same words', async () => {
    const r = await run(
      app({
        ...FILES,
        'src/HomePage.tsx': [
          "import { Button } from '@fixture/ds';",
          "import { ReportFacts } from './facts';",
          "const OPEN = { id: 'home.open', description: 'Opens a topic' } as const;",
          'export function HomePage() {',
          '  return (',
          '    <div>',
          '      <Button agent={OPEN} onClick={() => {}}>Open</Button>',
          '      <ReportFacts agent={OPEN} title="Topic" facts={{ Count: 1 }} />',
          "      <ReportFacts agent={{ id: 'home.open', description: 'Something else' }} title=\"Topic\" facts={{}} />",
          '    </div>',
          '  );',
          '}',
        ].join('\n'),
      }),
    );
    expect(r.errors.map(e => e.message)).toEqual([
      expect.stringMatching(/^Binding id "home\.open" is described differently at /),
    ]);
  });
});

describe('a frame or a component on every page under one path', () => {
  it('says so, instead of listing every route', async () => {
    const r = await run();
    const frame = surface(r.manifest.surfaces, 'shell:DashLayout');
    expect(frame.description).toBe(
      "Dash Layout: the app's frame, around every page under /dash. Its controls are there whatever page is open.",
    );
    const shared = surface(r.manifest.surfaces, 'shared:ThemePicker');
    expect(shared.description).toBe('Theme Picker, on every page under /dash.');
    // Where it can be mounted is still every route.
    expect(shared.routes).toEqual(['/dash', '/dash/leads', '/dash/leads/:leadId', '/dash/settings']);
  });

  it('lists a few routes, and says "every page" for all of them', () => {
    const all = ['/', '/dash', '/dash/a', '/dash/b', '/dash/c', '/other'];
    expect(everyPage(['/dash/a', '/dash/b'], all)).toBeNull();
    expect(everyPage(['/dash', '/dash/a', '/dash/b', '/dash/c'], all)).toBe('every page under /dash');
    // Not every page under the path: listed.
    expect(everyPage(['/dash', '/dash/a', '/dash/b', '/other'], all)).toBeNull();
    expect(everyPage(all, all)).toBe('every page');
    expect(everyPage(['*'], all)).toBe('every page');
  });
});
