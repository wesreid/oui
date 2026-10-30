/**
 * Pages the assistant is never on, a design system's person-only components,
 * and a route's page followed through the components it renders.
 *
 * `outside` names pages before sign-in and public pages a link opens: they
 * have no surface, nothing on them is enforced, and the knowledge says the
 * assistant is not there. It can never hide a page of the app: a page is
 * outside only when no frame is on its routes, nothing its routes render
 * around it holds something someone can use or the person's own UI, it does
 * not render the frame itself, and nothing in it is bound for itself alone.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ControlTable } from '@ouispec/bindings';

import { ConfigError, generate, resolveConfig, type OuiConfigFile } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const SIGN_IN_REASON = 'the person signs in with their own credentials';
const ASSISTANT_REASON = "the person's own conversation with the assistant";
/** A design system that declares its sign-in screen and the assistant's panel person-only, as `@nova/core` does. */
const DS = {
  name: '@fixture/ds',
  packageJson: {
    oui: {
      agentControls: './dist/agent-controls.json',
      personOnly: { SignInScreen: SIGN_IN_REASON, AssistantPanel: ASSISTANT_REASON },
    },
  },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};

/**
 * The app: a sign-in page under a public wrapper, a public watch link whose
 * route element is a component of the routes file that renders the page,
 * and the app's pages under a layout that holds the assistant.
 */
const ROUTES = [
  "import { lazy } from 'react';",
  "import { Navigate, Outlet, Route, Routes, useParams } from 'react-router';",
  "import { Button, AssistantPanel } from '@fixture/ds';",
  "import { LoginPage } from './LoginPage';",
  "const VideoWatchPage = lazy(() => import('./VideoWatchPage').then((m) => ({ default: m.VideoWatchPage })));",
  "const ClipViewerPage = lazy(() => import('./VideoWatchPage').then((m) => ({ default: m.ClipViewerPage })));",
  'function PublicRouteWrapper() {',
  '  const signedIn = false;',
  '  if (signedIn) return <Navigate to="/home" replace />;',
  '  return <Outlet />;',
  '}',
  'function AssistantWrapper() {',
  '  return <><AssistantPanel /><Outlet /></>;',
  '}',
  'function AppLayout() {',
  "  return <div><Button agent={{ id: 'app.help', description: 'Opens help' }} onClick={() => {}}>Help</Button><Outlet /></div>;",
  '}',
  'function HomePage() {',
  "  return <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>;",
  '}',
  'function SettingsPage() {',
  '  return <button onClick={() => {}}>Save</button>;',
  '}',
  'function AssistedPage() {',
  '  return <button onClick={() => {}}>Go</button>;',
  '}',
  'function WatchPage() {',
  "  const { clipId = '' } = useParams();",
  '  return clipId.length === 36 ? <ClipViewerPage /> : <VideoWatchPage token={clipId} />;',
  '}',
  'export function AppRoutes() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/watch/:clipId" element={<WatchPage />} />',
  '      <Route element={<PublicRouteWrapper />}>',
  '        <Route path="/login" element={<LoginPage />} />',
  '      </Route>',
  '      <Route element={<AssistantWrapper />}>',
  '        <Route path="/assisted" element={<AssistedPage />} />',
  '      </Route>',
  '      <Route element={<AppLayout />}>',
  '        <Route path="/home" element={<HomePage />} />',
  '        <Route path="/settings" element={<SettingsPage />} />',
  '      </Route>',
  '    </Routes>',
  '  );',
  '}',
].join('\n');

const FILES: Record<string, string> = {
  'src/LoginPage.tsx': [
    "import { SignInScreen } from '@fixture/ds';",
    'export function LoginPage() {',
    '  return <form onSubmit={() => {}}><SignInScreen onSubmit={() => {}} onForgot={() => {}} /></form>;',
    '}',
  ].join('\n'),
  'src/VideoWatchPage.tsx': [
    "import type { ReactNode } from 'react';",
    "import { Button } from '@fixture/ds';",
    'function Page({ children }: { children: ReactNode }) {',
    '  return <div className="page">{children}</div>;',
    '}',
    'function WatchContent({ muted }: { muted: boolean }) {',
    '  return (',
    '    <Page>',
    '      {muted && <Button onClick={() => {}}>Tap for sound</Button>}',
    '      <a href="/next" onClick={() => {}}>Book a test drive</a>',
    '    </Page>',
    '  );',
    '}',
    'export function VideoWatchPage({ token }: { token: string }) {',
    '  if (!token) return <Page>Not found</Page>;',
    '  return <WatchContent muted />;',
    '}',
    'export function ClipViewerPage() {',
    '  return <Page><Button onClick={() => {}}>Replay</Button></Page>;',
    '}',
  ].join('\n'),
};

function app(routes = ROUTES, files = FILES): string {
  const root = tempApp([DS], routes);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const OUTSIDE: OuiConfigFile['outside'] = [
  { component: 'LoginPage', reason: 'before sign-in' },
  { route: '/watch/:clipId', reason: 'a public share link, opened signed out' },
];

async function run(settings: Partial<OuiConfigFile> = {}, root = app()) {
  return generate(
    resolveConfig(root, {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      routeWrappers: ['PublicRouteWrapper', 'AssistantWrapper'],
      designSystem: ['@fixture/ds'],
      apiSpec: null,
      out: 'src/agent/generated',
      unbound: ['AssistedPage', 'SettingsPage'],
      ...settings,
    }),
  );
}

const messages = (r: Awaited<ReturnType<typeof run>>) => r.errors.map(e => e.message);
const surfaceIds = (r: Awaited<ReturnType<typeof run>>) => r.manifest.surfaces.map(s => s.id);

describe('a page the assistant is never on', () => {
  it('has no surface, nothing on it is enforced, it is not a page to go to, and the knowledge says the assistant is not there', async () => {
    const r = await run({ outside: OUTSIDE });
    expect(messages(r)).toEqual([]);
    expect(surfaceIds(r)).not.toContain('page:LoginPage');
    expect(surfaceIds(r)).not.toContain('page:WatchPage');
    expect(surfaceIds(r)).toEqual(
      expect.arrayContaining(['page:HomePage', 'page:SettingsPage', 'page:AssistedPage', 'shell:AppLayout', 'app:navigation']),
    );
    const navigation = r.manifest.surfaces.find(s => s.id === 'app:navigation')!;
    expect(navigation.routes).toEqual(['/assisted', '/home', '/settings']);
    expect(navigation.actions[0].input.properties!.path.description).not.toContain('/login');
    expect(r.knowledge.pages.map(p => p.surface)).not.toContain('page:LoginPage');
    expect(r.knowledge.overview.content).toContain(
      'You are not on these pages, so you cannot act on them or take the person to them: ' +
        '/login (before sign-in), /watch/:clipId (a public share link, opened signed out).',
    );
    expect(r.stats.outsidePages).toBe(2);
  });

  it('changes nothing for an app that names none', async () => {
    const before = await run({ unbound: ['AssistedPage', 'LoginPage', 'SettingsPage', 'WatchPage'] });
    const none = await run({ unbound: ['AssistedPage', 'LoginPage', 'SettingsPage', 'WatchPage'], outside: [] });
    expect(messages(before)).toEqual([]);
    expect(none.manifest).toEqual(before.manifest);
    expect(none.knowledge).toEqual(before.knowledge);
    expect(before.knowledge.overview.content).not.toContain('You are not on these pages');
    expect(surfaceIds(before)).toEqual(expect.arrayContaining(['page:LoginPage', 'page:WatchPage']));
    expect(before.stats.outsidePages).toBe(0);
  });

  it('is not outside under a layout that holds something someone can use: the app’s frame', async () => {
    const r = await run({ outside: [{ component: 'SettingsPage', reason: 'hidden' }], unbound: ['AssistedPage'] });
    expect(messages(r)).toContain(
      '"outside" lists SettingsPage, but on /settings it is rendered in AppLayout, a layout route that holds something someone can use (src/routes.tsx:16)',
    );
    // Not outside, it is a page, and enforced.
    expect(surfaceIds(r)).toContain('page:SettingsPage');
    expect(messages(r)).toContain(
      'A raw <button> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on SettingsPage, whose bindings are enforced)',
    );
  });

  it('is not outside in a wrapper that renders the person’s own UI, such as the assistant’s panel', async () => {
    const r = await run({ outside: [{ route: '/assisted', reason: 'hidden' }], unbound: ['SettingsPage'] });
    expect(messages(r)).toContain(
      '"outside" lists AssistedPage, but on /assisted it is rendered in AssistantWrapper, a route wrapper that renders the person-only <AssistantPanel> from @fixture/ds (src/routes.tsx:13)',
    );
    expect(surfaceIds(r)).toContain('page:AssistedPage');
  });

  it('is not outside where a frame in "shell" is', async () => {
    const root = app();
    writeFileSync(
      join(root, 'src/Frame.tsx'),
      "import { Button } from '@fixture/ds';\nexport function Frame() { return <Button agent={{ id: 'frame.menu', description: 'Opens the menu' }} onClick={() => {}}>Menu</Button>; }\n",
    );
    const everywhere = await run({ outside: OUTSIDE, shell: [{ module: 'src/Frame.tsx', export: 'Frame' }] }, root);
    expect(messages(everywhere)).toEqual(
      expect.arrayContaining([
        '"outside" lists LoginPage, but the frame Frame (in "shell") is on /login',
        '"outside" lists WatchPage, but the frame Frame (in "shell") is on /watch/:clipId',
      ]),
    );
    const elsewhere = await run(
      { outside: OUTSIDE, shell: [{ module: 'src/Frame.tsx', export: 'Frame', routes: ['/home', '/settings'] }] },
      root,
    );
    expect(messages(elsewhere)).toEqual([]);
  });

  it('is not outside when it binds anything for itself alone', async () => {
    const files = {
      ...FILES,
      'src/LoginPage.tsx': [
        "import { Button, SignInScreen } from '@fixture/ds';",
        'export function LoginPage() {',
        "  return <><SignInScreen onSubmit={() => {}} /><Button agent={{ id: 'login.help', description: 'Help' }} onClick={() => {}}>Help</Button></>;",
        '}',
      ].join('\n'),
    };
    const r = await run({ outside: OUTSIDE }, app(ROUTES, files));
    expect(messages(r)).toEqual([
      '"outside" lists LoginPage, but it has the binding "login.help" (src/LoginPage.tsx:3), on no page the assistant is on: ' +
        'what is bound only where the assistant is never is either on a page it is on, or bound by mistake',
    ]);
    expect(surfaceIds(r)).toContain('page:LoginPage');
  });

  it('may share a bound component with pages the assistant is on: it is offered there', async () => {
    const shared = "import { Button } from '@fixture/ds';\nexport function Help() { return <Button agent={{ id: 'help.open', description: 'Opens help' }} onClick={() => {}}>Help</Button>; }\n";
    const routes = ROUTES.replace("import { LoginPage } from './LoginPage';", "import { LoginPage } from './LoginPage';\nimport { Help } from './Help';").replace(
      "  return <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>;",
      "  return <><Help /><Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button></>;",
    );
    const files = {
      ...FILES,
      'src/Help.tsx': shared,
      'src/LoginPage.tsx': [
        "import { SignInScreen } from '@fixture/ds';",
        "import { Help } from './Help';",
        'export function LoginPage() {',
        '  return <><SignInScreen onSubmit={() => {}} /><Help /></>;',
        '}',
      ].join('\n'),
    };
    const r = await run({ outside: OUTSIDE }, app(routes, files));
    expect(messages(r)).toEqual([]);
    const home = r.manifest.surfaces.find(s => s.id === 'page:HomePage')!;
    expect(home.actions.map(a => a.name)).toEqual(['help_open', 'home_start']);
    expect(surfaceIds(r)).not.toContain('shared:Help');
  });

  it('is not outside when it renders the app’s frame itself', async () => {
    const routes = ROUTES.replace(
      "import { LoginPage } from './LoginPage';",
      "import { LoginPage } from './LoginPage';\nimport { Frame } from './Frame';",
    );
    const files = {
      ...FILES,
      'src/Frame.tsx':
        "import { Button } from '@fixture/ds';\nexport function Frame() { return <Button agent={{ id: 'frame.menu', description: 'Opens the menu' }} onClick={() => {}}>Menu</Button>; }\n",
      'src/LoginPage.tsx': [
        "import { SignInScreen } from '@fixture/ds';",
        "import { Frame } from './Frame';",
        'export function LoginPage() {',
        '  return <><Frame /><SignInScreen onSubmit={() => {}} /></>;',
        '}',
      ].join('\n'),
    };
    const r = await run(
      { outside: OUTSIDE, shell: [{ module: 'src/Frame.tsx', export: 'Frame', routes: ['/home'] }] },
      app(routes, files),
    );
    expect(messages(r)).toContain('"outside" lists LoginPage, but it renders the app\'s frame Frame itself');
  });

  it('names a page once, by component or by each of its routes, never also as unbound', async () => {
    const r = await run({
      outside: [
        { component: 'NoSuchPage', reason: 'x' },
        { route: '/nowhere', reason: 'x' },
        { component: 'LoginPage', reason: 'before sign-in' },
      ],
      unbound: ['AssistedPage', 'LoginPage', 'SettingsPage', 'WatchPage'],
    });
    expect(messages(r)).toEqual([
      '"outside" lists LoginPage, but "unbound" lists it too: a page the assistant is on but has not bound yet is in "unbound", one it is never on in "outside"',
      '"outside" lists NoSuchPage, which no route renders',
      '"outside" lists the route /nowhere, which is no page\'s route',
    ]);

    const twice = [
      "import { Route, Routes } from 'react-router';",
      'function SharePage() { return <a href="/x" onClick={() => {}}>Open</a>; }',
      'export function AppRoutes() {',
      '  return <Routes><Route path="/s/:id" element={<SharePage />} /><Route path="/share/:id" element={<SharePage />} /></Routes>;',
      '}',
    ].join('\n');
    const partly = await run({ outside: [{ route: '/s/:id', reason: 'a share link' }], unbound: [], routeWrappers: [] }, app(twice, {}));
    expect(messages(partly)).toContain(
      '"outside" lists SharePage, but it is also on /share/:id: name it by component, or name each of its routes',
    );
    const each = await run(
      {
        outside: [
          { route: '/s/:id', reason: 'a share link' },
          { route: '/share/:id', reason: 'a share link' },
        ],
        unbound: [],
        routeWrappers: [],
      },
      app(twice, {}),
    );
    expect(messages(each)).toEqual([]);
    expect(each.knowledge.overview.content).toContain('/s/:id (a share link), /share/:id (a share link)');
  });

  it('is a list of entries that each name the page one way and say why', () => {
    for (const outside of [
      [{ component: 'LoginPage' }],
      [{ component: 'LoginPage', route: '/login', reason: 'x' }],
      [{ reason: 'x' }],
      [{ component: 'LoginPage', reason: ' ' }],
      [{ component: 'LoginPage', reason: 'x', why: 'y' }],
      'LoginPage',
    ]) {
      expect(() =>
        resolveConfig('/app', {
          tsconfig: 'tsconfig.json',
          routes: 'src/routes.tsx',
          designSystem: [],
          apiSpec: null,
          out: 'out',
          outside,
        }),
      ).toThrow(ConfigError);
    }
  });
});

describe("a design system's person-only components", () => {
  it('are the person’s own: what they take needs no binding, and no control table entry', async () => {
    const r = await run({ outside: [], unbound: ['AssistedPage', 'SettingsPage', 'WatchPage'] });
    // LoginPage is enforced: its SignInScreen takes callbacks, and its own <form> is reported, nothing else.
    expect(messages(r)).toEqual([
      'A raw <form> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on LoginPage, whose bindings are enforced)',
    ]);
  });

  it('refuse an agent binding and a spread, as any package’s do', async () => {
    const files = {
      ...FILES,
      'src/LoginPage.tsx': [
        "import { SignInScreen as Screen } from '@fixture/ds';",
        'const extra = {};',
        'export function LoginPage() {',
        "  return <><Screen agent={{ id: 'login.submit', description: 'Signs in' }} /><Screen {...extra} /></>;",
        '}',
      ].join('\n'),
    };
    const r = await run({ unbound: ['AssistedPage', 'SettingsPage', 'WatchPage'] }, app(ROUTES, files));
    expect(messages(r)).toEqual([
      `<Screen> from @fixture/ds is the person's own and takes no agent binding: ${SIGN_IN_REASON}`,
      "<Screen> from @fixture/ds is the person's own: write its props out, not as a spread, so the build can see none is an agent binding",
    ]);
  });

  it('cannot also be in its control table', async () => {
    const both = {
      ...DS,
      packageJson: { oui: { ...DS.packageJson.oui, personOnly: { ...DS.packageJson.oui.personOnly, Button: 'never' } } },
    };
    const root = tempApp([both]);
    const r = await generate(
      resolveConfig(root, { tsconfig: 'tsconfig.json', routes: 'src/routes.tsx', designSystem: ['@fixture/ds'], apiSpec: null, out: 'out' }),
    );
    expect(messages(r)).toEqual([
      "<Button> from @fixture/ds is the person's own and takes no agent binding: never",
      "<Button> is in @fixture/ds's control table and also person-only (oui.personOnly: never): @fixture/ds must say one or the other",
    ]);
  });
});

describe('a route’s page, followed through the components it renders', () => {
  it('reads what the route element renders, through a lazy page and the components that page renders', async () => {
    const r = await run({ unbound: ['AssistedPage', 'LoginPage', 'SettingsPage'] });
    expect(r.errors.map(e => `${e.file}:${e.line} ${e.message}`)).toEqual([
      'src/VideoWatchPage.tsx:9 <Button> has no agent binding (on WatchPage, whose bindings are enforced)',
      'src/VideoWatchPage.tsx:10 A raw <a> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on WatchPage, whose bindings are enforced)',
      'src/VideoWatchPage.tsx:19 <Button> has no agent binding (on WatchPage, whose bindings are enforced)',
    ]);
  });

  it('offers what is bound there on the route’s page', async () => {
    const files = {
      ...FILES,
      'src/VideoWatchPage.tsx': FILES['src/VideoWatchPage.tsx']
        .replace(
          '<Button onClick={() => {}}>Tap for sound</Button>',
          "<Button agent={{ id: 'watch.unmute', description: 'Plays the video with sound' }} onClick={() => {}}>Tap for sound</Button>",
        )
        .replace('<a href="/next" onClick={() => {}}>', '<a href="/next" data-non-agent="the customer’s own next step" onClick={() => {}}>')
        .replace(
          '<Button onClick={() => {}}>Replay</Button>',
          "<Button agent={{ id: 'watch.replay', description: 'Plays the clip again' }} onClick={() => {}}>Replay</Button>",
        ),
    };
    const r = await run({ unbound: ['AssistedPage', 'LoginPage', 'SettingsPage'] }, app(ROUTES, files));
    expect(messages(r)).toEqual([]);
    const watch = r.manifest.surfaces.find(s => s.id === 'page:WatchPage')!;
    expect(watch.routes).toEqual(['/watch/:clipId']);
    expect(watch.actions.map(a => a.name)).toEqual(['watch_replay', 'watch_unmute']);
  });
});
