/**
 * What fails the build (ADR-0226 §2.4, §2.5): a misconfigured or unusual app
 * is an error naming what is wrong, never a manifest with nothing in it.
 *
 * One fixture per row of §2.5 that W1 owns (row 6, tier 2 mappings, is W4),
 * and one per required setting of `oui.config.json`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ControlTable, ManifestSurface } from '@ouispec/bindings';

import { generate, loadConfig, resolveConfig } from '../src/index.js';
import { config, FIXTURE, FIXTURES, TABLE, tempApp, tempDir } from './fixture-config.js';

const surface = (surfaces: readonly ManifestSurface[], id: string) => {
  const s = surfaces.find(x => x.id === id);
  if (!s) throw new Error(`no surface ${id}: ${surfaces.map(x => x.id).join(', ')}`);
  return s;
};

const pages = (surfaces: readonly ManifestSurface[]) =>
  surfaces.filter(s => s.kind === 'page').map(s => [s.id, s.routes]);

/** The settings every test app starts from, as its `oui.config.json` would hold them. */
const SETTINGS = {
  tsconfig: 'tsconfig.json',
  routes: 'src/routes.tsx',
  designSystem: ['@closurestudio/ui'],
  apiSpec: null,
  out: 'src/agent/generated',
};

// ─── oui.config.json ─────────────────────────────────────────────────────────

describe('oui.config.json is required and explicit', () => {
  it('fails without the file, naming where it looked', () => {
    const root = tempDir('oui-noconfig-');
    expect(() => loadConfig(join(root, 'oui.config.json'))).toThrow(
      `No oui.config.json at ${join(root, 'oui.config.json')}: the generator reads every setting from it`,
    );
  });

  it.each(['tsconfig', 'routes', 'designSystem', 'apiSpec', 'out'] as const)(
    'fails without "%s", naming it',
    field => {
      const { [field]: _, ...rest } = SETTINGS;
      expect(() => resolveConfig(FIXTURE, rest)).toThrow(`"${field}" is required`);
    },
  );

  it('has no Closure defaults: an empty design system and no API are said, not assumed', () => {
    const cfg = resolveConfig(FIXTURE, { ...SETTINGS, designSystem: [], apiSpec: null });
    expect(cfg.designSystem).toEqual([]);
    expect(cfg.apiSpec).toBeNull();
    expect(cfg.routeWrappers).toEqual([]);
  });

  it('names apiSpec as the replacement for apiClient', () => {
    expect(() =>
      resolveConfig(FIXTURE, { ...SETTINGS, apiClient: '@closurestudio/api-client' }),
    ).toThrow('"apiClient" is replaced by "apiSpec"');
  });

  it('refuses a setting it does not know, and a setting of the wrong type', () => {
    expect(() => resolveConfig(FIXTURE, { ...SETTINGS, designsystem: [] })).toThrow(
      '"designsystem" is not a setting',
    );
    expect(() => resolveConfig(FIXTURE, { ...SETTINGS, designSystem: '@closurestudio/ui' })).toThrow(
      '"designSystem" must be a list of package names',
    );
    expect(() => resolveConfig(FIXTURE, { ...SETTINGS, apiSpec: 3 })).toThrow(
      '"apiSpec" must be the module path of an OpenAPI document, or null',
    );
  });

  it('reports every problem at once', () => {
    expect(() => resolveConfig(FIXTURE, { apiClient: null })).toThrow(
      /"tsconfig" is required[\s\S]*"routes" is required[\s\S]*"designSystem" is required[\s\S]*"apiSpec" is required[\s\S]*"out" is required[\s\S]*"apiClient" is replaced by "apiSpec"/,
    );
  });
});

// ─── Row 1: design-system packages ───────────────────────────────────────────

const DS_TABLE: ControlTable = { Button: TABLE.Button };
const table = { 'dist/agent-controls.json': JSON.stringify(DS_TABLE) };

async function generateIn(root: string, settings: Record<string, unknown> = {}) {
  return generate(resolveConfig(root, { ...SETTINGS, designSystem: ['@fixture/ds'], ...settings }));
}

describe('§2.5 row 1: a design-system package is resolved and has a control table, or the build fails', () => {
  it('reads the neutral "oui.agentControls" key', async () => {
    const root = tempApp([
      { name: '@fixture/ds', packageJson: { oui: { agentControls: './dist/agent-controls.json' } }, files: table },
    ]);
    const r = await generateIn(root);
    expect(r.errors).toEqual([]);
    expect(surface(r.manifest.surfaces, 'page:HomePage').actions.map(a => a.name)).toEqual(['home_start']);
  });

  it('still reads "closure.agentControls" during the transition', async () => {
    const root = tempApp([
      { name: '@fixture/ds', packageJson: { closure: { agentControls: './dist/agent-controls.json' } }, files: table },
    ]);
    const r = await generateIn(root);
    expect(r.errors).toEqual([]);
    expect(surface(r.manifest.surfaces, 'page:HomePage').actions.map(a => a.name)).toEqual(['home_start']);
  });

  it('fails a package it cannot resolve, naming it', async () => {
    const r = await generateIn(tempApp([]));
    expect(r.errors.map(e => [e.file, e.message])).toEqual([
      [
        'oui.config.json',
        'designSystem lists "@fixture/ds", which cannot be resolved from the app: install it, or remove it from "designSystem"',
      ],
    ]);
  });

  it('fails a package with no control table, naming the key it looked for', async () => {
    const r = await generateIn(tempApp([{ name: '@fixture/ds', packageJson: { version: '1.0.0' } }]));
    expect(r.errors.map(e => e.message)).toEqual([
      'designSystem lists "@fixture/ds", which declares no control table: its package.json needs "oui": { "agentControls": "<path to its control table>" }',
    ]);
  });

  it('fails a package whose table file is missing', async () => {
    const r = await generateIn(
      tempApp([{ name: '@fixture/ds', packageJson: { oui: { agentControls: './dist/agent-controls.json' } } }]),
    );
    expect(r.errors.map(e => e.message)).toEqual([
      '"@fixture/ds" names ./dist/agent-controls.json as its oui.agentControls, but it does not exist',
    ]);
  });

  it('fails a package that declares both keys', async () => {
    const both = { agentControls: './dist/agent-controls.json' };
    const r = await generateIn(
      tempApp([{ name: '@fixture/ds', packageJson: { oui: both, closure: both }, files: table }]),
    );
    expect(r.errors.map(e => e.message)).toEqual([
      '"@fixture/ds" declares both "oui.agentControls" and "closure.agentControls": keep "oui"',
    ]);
  });

  it('fails a room package that declares both catalog keys', async () => {
    const entry = { agentCatalog: { path: './dist/agent-catalog.json', hosts: ['Room'] } };
    const root = tempApp([
      { name: '@fixture/ds', packageJson: { oui: { agentControls: './dist/agent-controls.json' } }, files: table },
      { name: '@fixture/room', packageJson: { oui: entry, closure: entry } },
    ]);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'temp-app', private: true, dependencies: { '@fixture/room': '1.0.0' } }),
    );
    const r = await generateIn(root);
    expect(r.errors.map(e => e.message)).toEqual([
      '"@fixture/room" declares both "oui.agentCatalog" and "closure.agentCatalog": keep "oui"',
    ]);
  });
});

// ─── Rows 2 and 3: interactive elements outside the design system ────────────

describe('§2.5 rows 2 and 3: what someone can use is interactive wherever it comes from', () => {
  it('fails a third-party component that takes a callback, and a key or pointer handler, on an enforced page', async () => {
    const r = await generate(config({ unbound: [] }));
    const messages = r.errors.map(e => `${e.line}: ${e.message}`);
    expect(messages).toContain(
      '39: <Slider> from third-party-ui takes onValueChange, but is neither a design-system control nor a room host: ' +
        'use a bound control that does the same, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
    );
    expect(messages.filter(m => /^2[89]: A raw <(div|canvas)>/.test(m))).toHaveLength(2);
    expect(messages).toContain(
      "41: <Carousel> from @closurestudio/ui takes onSlide, but is not in @closurestudio/ui's control table: " +
        'bind it there, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
    );
  });

  it('accepts data-non-agent with its reason, and a component that takes no callback', async () => {
    const r = await generate(config({ unbound: [] }));
    const text = r.errors.map(e => e.message).join('\n');
    expect(text).not.toContain('<Sortable>');
    expect(text).not.toContain('<Portal>');
    expect(text).not.toContain('<span>');
  });
});

// ─── Row 4: routes ───────────────────────────────────────────────────────────

describe('§2.5 row 4: nested, index, data-router and React.lazy routes', () => {
  it('joins nested JSX paths to their parent, keeps index routes, and resolves React.lazy', async () => {
    const r = await generate(
      resolveConfig(join(FIXTURES, 'routes-jsx'), { ...SETTINGS, out: tempDir('oui-gen-') }, {
        controlTables: { '@closurestudio/ui': TABLE },
        catalogs: [],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(pages(r.manifest.surfaces)).toEqual([
      ['page:AboutPage', ['/about']],
      ['page:BillingPage', ['/settings/billing']],
      ['page:GeneralSettingsPage', ['/settings']],
      ['page:ProjectEditPage', ['/projects/:projectId/edit']],
      ['page:ProjectPage', ['/projects/:projectId']],
      ['page:ProjectsPage', ['/projects']],
      ['page:TeamPage', ['/settings/team/:teamId']],
    ]);
    // A lazily loaded default export is read like any page.
    expect(surface(r.manifest.surfaces, 'page:BillingPage').actions.map(a => a.name)).toEqual([
      'settings_billing_upgrade',
    ]);
    // The redirect and the splat are no page.
    expect(surface(r.manifest.surfaces, 'app:navigation').routes).not.toContain('/settings/old');
  });

  it('makes a layout route’s element the frame of the pages under it', async () => {
    const r = await generate(
      resolveConfig(join(FIXTURES, 'routes-jsx'), { ...SETTINGS, out: tempDir('oui-gen-') }, {
        controlTables: { '@closurestudio/ui': TABLE },
        catalogs: [],
      }),
    );
    const layout = surface(r.manifest.surfaces, 'shell:SettingsLayout');
    expect(layout.routes).toEqual(['/settings', '/settings/billing', '/settings/team/:teamId']);
    expect(layout.actions.map(a => a.name)).toEqual(['settings_help']);
  });

  it('reads a data router: children, index, Component, lazy route modules and constant children', async () => {
    const r = await generate(
      resolveConfig(
        join(FIXTURES, 'routes-data'),
        { ...SETTINGS, routes: 'src/router.tsx', out: tempDir('oui-gen-') },
        { controlTables: { '@closurestudio/ui': TABLE }, catalogs: [] },
      ),
    );
    expect(r.errors).toEqual([]);
    expect(pages(r.manifest.surfaces)).toEqual([
      ['page:AccountPage', ['/account']],
      ['page:AuditPage', ['/account/audit']],
      ['page:HomePage', ['/']],
      ['page:ProfilePage', ['/profile']],
      ['page:ReportPage', ['/reports/:reportId']],
      ['page:ReportsPage', ['/reports']],
    ]);
    expect(surface(r.manifest.surfaces, 'page:ProfilePage').actions.map(a => a.name)).toEqual(['profile_edit']);
    // A layout that only renders its outlet frames nothing anyone can use.
    expect(r.manifest.surfaces.some(s => s.id === 'shell:Root')).toBe(false);
    expect(surface(r.manifest.surfaces, 'app:navigation').routes).not.toContain('/legacy');
  });
});

// ─── Row 5: the API's OpenAPI document ───────────────────────────────────────

describe('§2.5 row 5: apiSpec is read, and every mutate names one of its operations', () => {
  it('describes a mutate from the operation its operationId names', async () => {
    const r = await generate(config());
    expect(r.errors).toEqual([]);
    const confirm = surface(r.manifest.surfaces, 'page:VoicesPage').actions.find(
      a => a.name === 'voices_bulk_delete_confirm',
    )!;
    expect(confirm.description).toContain(
      'It saves through deleteVoice (DELETE /api/v1/voices/{voiceId}: Delete a voice).',
    );
  });

  it('fails a mutate naming an operationId the document does not have', async () => {
    const r = await generate(config({ apiSpec: 'openapi-without-delete.json' }));
    expect(r.errors.map(e => e.message)).toEqual([
      '"voices.bulk-delete.confirm" names API operation deleteVoice, which openapi-without-delete.json does not have',
    ]);
  });

  it('fails a mutate in an app that declares no API', async () => {
    const r = await generate(config({ apiSpec: null }));
    expect(r.errors.map(e => e.message)).toEqual([
      '"voices.bulk-delete.confirm" saves through API operation deleteVoice, but oui.config.json declares no API ("apiSpec": null)',
    ]);
  });

  it('fails a spec it cannot read, or one that is not OpenAPI 3', async () => {
    const missing = await generate(config({ apiSpec: 'missing-openapi.json' }));
    expect(missing.errors.map(e => e.message)).toContainEqual(
      expect.stringMatching(/^apiSpec "missing-openapi.json" cannot be read: /),
    );
    const swagger = await generate(config({ apiSpec: 'swagger2.json' }));
    expect(swagger.errors.map(e => e.message)).toContainEqual(
      'apiSpec "swagger2.json" is not an OpenAPI 3 document: it needs "openapi": "3.x" and "paths"',
    );
  });

  it('fails a spec named by a path outside the app', async () => {
    const r = await generate(config({ apiSpec: '../routes-jsx/tsconfig.json' }));
    expect(r.errors.map(e => e.message)).toContainEqual(
      'apiSpec "../routes-jsx/tsconfig.json" is outside the app: name the document by its module path, as the installed API client ships it',
    );
  });

  it('reads the document by module path, from the API client the app installs', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/api/start': { post: { operationId: 'startThing', summary: 'Start a thing' } } },
    };
    const root = tempApp([
      { name: '@fixture/ds', packageJson: { oui: { agentControls: './dist/agent-controls.json' } }, files: table },
      {
        name: '@fixture/api-client',
        packageJson: { exports: { './openapi.json': './openapi/openapi.json' } },
        files: { 'openapi/openapi.json': JSON.stringify(spec) },
      },
    ]);
    writeFileSync(
      join(root, 'src/routes.tsx'),
      [
        "import { Route, Routes } from 'react-router';",
        "import { Button } from '@fixture/ds';",
        'function HomePage() {',
        "  return <Button agent={{ id: 'home.start', description: 'Start', effect: { kind: 'mutate', operation: 'startThing' } }} onClick={() => {}}>Start</Button>;",
        '}',
        'export function AppRoutes() {',
        '  return <Routes><Route path="/" element={<HomePage />} /></Routes>;',
        '}',
      ].join('\n'),
    );
    const r = await generateIn(root, { apiSpec: '@fixture/api-client/openapi.json' });
    expect(r.errors).toEqual([]);
    expect(surface(r.manifest.surfaces, 'page:HomePage').actions[0].description).toContain(
      'It saves through startThing (POST /api/start: Start a thing).',
    );
  });
});

// ─── Row 7: app room catalogs need Vite ──────────────────────────────────────

describe('§2.5 row 7: an app room catalog is loaded through the app’s Vite', () => {
  it('fails with the requirement when the app has no Vite', async () => {
    const root = tempApp([
      { name: '@fixture/ds', packageJson: { oui: { agentControls: './dist/agent-controls.json' } }, files: table },
    ]);
    writeFileSync(join(root, 'src/catalog.ts'), 'export const CATALOG = { room: "r", actions: [] };\n');
    await expect(
      generateIn(root, { appCatalogs: [{ module: 'src/catalog.ts', export: 'CATALOG', hosts: [] }] }),
    ).rejects.toThrow(
      'appCatalogs are loaded through the app’s own Vite config, and vite cannot be resolved from the app: ' +
        'add vite to its devDependencies, or ship the catalog in a package under "oui.agentCatalog"',
    );
  });
});
