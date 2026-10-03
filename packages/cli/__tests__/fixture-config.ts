/**
 * The fixture app's configuration, shared by the generator's tests: the
 * control table and room catalog the fixture's pages use, and an explicit
 * `oui.config.json` for it. Every output directory a test makes is removed
 * after the file's tests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

import type { ControlTable, RoomCatalogData } from '@ouispec/bindings';

import { resolveConfig, type ConfigInjection, type GeneratorConfig, type OuiConfigFile } from '../src/index.js';

export const FIXTURES = join(__dirname, 'fixtures');
export const FIXTURE = join(FIXTURES, 'app');

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory for one test's output or app, removed after the file's tests. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export const TABLE: ControlTable = {
  Button: { kind: 'button', callbacks: ['onClick', 'type'], titleProps: ['aria-label', 'title', 'children'] },
  Input: {
    kind: 'text',
    callbacks: ['onChange'],
    schemaProps: { maxLength: 'maxLength' },
    titleProps: ['label'],
  },
  Select: {
    kind: 'choice',
    callbacks: ['onChange'],
    options: { prop: 'options', value: 'value', title: 'label' },
    titleProps: ['label'],
  },
  NumericScrubField: {
    kind: 'number',
    callbacks: ['onChange'],
    schemaProps: { min: 'min', max: 'max', step: 'step', unit: 'unit' },
    titleProps: ['label'],
  },
  SimpleTabs: {
    kind: 'tabs',
    callbacks: ['onChange'],
    options: { prop: 'tabs', value: 'id', title: 'label' },
    container: { kind: 'tabs', stateProp: 'value' },
    titleProps: ['aria-label'],
  },
  DropdownMenu: {
    callbacks: [],
    entries: { prop: 'items', kind: 'button', callback: 'onClick', titleKey: 'label' },
    titleProps: ['label'],
  },
  Modal: {
    kind: 'dialog',
    callbacks: ['onClose'],
    container: { kind: 'dialog', stateProp: 'open' },
    titleProps: ['title'],
  },
  ConfirmDialog: {
    callbacks: [],
    slots: {
      confirm: { kind: 'button', callback: 'onConfirm' },
      cancel: { kind: 'button', callback: 'onCancel' },
    },
    container: { kind: 'dialog', stateProp: 'open' },
    titleProps: ['title'],
  },
  SelectionToolbar: {
    callbacks: [],
    slots: { deselectAll: { kind: 'button', callback: 'onDeselectAll' } },
    entries: { prop: 'actions', kind: 'button', callback: 'onClick', titleKey: 'label' },
    titleProps: [],
  },
  VoiceCard: {
    callbacks: [],
    slots: { open: { kind: 'button', callback: 'onClick' } },
    titleProps: ['name'],
  },
  SyncedMediaPlayer: {
    callbacks: [],
    slots: { play: { kind: 'toggle' } },
    titleProps: [],
  },
  FactList: { callbacks: [], display: { itemsProp: 'facts', labelKey: 'label' }, titleProps: ['title'] },
  Table: {
    callbacks: [],
    slots: {
      open: { kind: 'button', callback: 'onRowClick', rows: true },
      sort: { kind: 'choice', callback: 'sortable', defaults: { clearable: true } },
    },
    titleProps: [],
  },
};

export const CATALOG: RoomCatalogData = {
  room: 'demo-room',
  title: 'Demo Room',
  description: 'Draws shapes and text.',
  actions: [
    {
      kind: 'action',
      id: 'add-text',
      title: 'Add text',
      description: 'Sets a new text layer.',
      control: 'The Type tool (T)',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      effect: 'edit',
    },
    {
      kind: 'action',
      id: 'select',
      title: 'Select',
      description: 'Selects layers.',
      control: 'Clicking a layer',
      input: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
      effect: 'selection',
    },
    {
      kind: 'action',
      id: 'set-properties',
      title: 'Set properties',
      description: 'Sets fields on the selection.',
      control: 'The Design panel',
      input: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
      effect: 'edit',
    },
    {
      kind: 'action',
      id: 'run-command',
      title: 'Run a command',
      description: 'Runs a keymap command.',
      control: 'The keyboard',
      input: {
        type: 'object',
        properties: { command: { type: 'string', enum: ['object.group'] } },
        required: ['command'],
      },
      effect: 'edit',
    },
    {
      kind: 'action',
      id: 'toggle-keyframe',
      title: 'Toggle keyframe',
      description: 'Turns a property’s keyframe on at the playhead.',
      control: 'The diamond beside a field',
      input: { type: 'object', properties: { field: { type: 'string' } } },
      effect: 'edit',
    },
  ],
  fields: [
    {
      kind: 'field',
      id: 'tracking',
      title: 'Tracking',
      description: 'Space between letters.',
      control: 'Tracking field',
      section: { id: 'type', title: 'Type' },
      appliesTo: ['text'],
      value: { type: 'number', minimum: -100, maximum: 500, 'x-unit': '‰' },
      keyframeable: false,
    },
    {
      kind: 'field',
      id: 'angle',
      title: 'Angle',
      description: 'Rotation.',
      control: 'Angle field',
      section: { id: 'transform', title: 'Transform' },
      appliesTo: ['text', 'shape'],
      value: { type: 'number', minimum: -180, maximum: 180, 'x-unit': '°' },
      keyframeable: true,
    },
    {
      kind: 'field',
      id: 'playhead-time',
      title: 'Time',
      description: 'The playhead.',
      control: 'Timeline',
      section: { id: 'time', title: 'Time' },
      appliesTo: ['document'],
      value: { type: 'number', minimum: 0, 'x-unit': 's' },
      keyframeable: false,
    },
  ],
  commands: [
    {
      kind: 'command',
      id: 'object.group',
      title: 'Group',
      description: 'Groups the selection.',
      control: '⌘G',
      group: 'objects',
      keys: ['⌘G'],
      status: 'available',
    },
    {
      kind: 'command',
      id: 'tool.knife',
      title: 'Knife',
      description: 'Cuts paths.',
      control: 'Knife',
      group: 'tools',
      keys: [],
      status: 'reserved',
    },
  ],
  observations: [{ id: 'document', description: 'Every layer.', schema: { type: 'object' } }],
  // The room declares its animation recipe; the generator infers none from ids.
  recipes: [
    {
      name: 'Animate a property in the {room}',
      trigger: 'Making something move or change over time in the {room}',
      steps: [
        'Select what should animate.',
        "Turn on the property's keyframe with {action:toggle-keyframe}.",
        'Move the playhead with {field:playhead-time}.',
        'Change the value with {action:set-properties}: at the new time it is a new keyframe. Keyframeable: {keyframeable}.',
      ],
    },
  ],
};

/** The fixture app's explicit settings, and the tables and catalogs given in place of packages. */
export function config(
  overrides: Partial<OuiConfigFile> & ConfigInjection = {},
  root: string = FIXTURE,
): GeneratorConfig {
  const { controlTables, catalogs, ...file } = overrides;
  return resolveConfig(
    root,
    {
      tsconfig: 'tsconfig.json',
      routes: 'src/routes.tsx',
      routeWrappers: ['LazyRoute', 'Suspense'],
      nav: ['src/nav.ts'],
      out: tempDir('oui-gen-'),
      designSystem: ['@closurestudio/ui'],
      apiSpec: 'openapi.json',
      unbound: ['UnboundPage'],
      appCatalogs: [{ module: 'src/board-actions.ts', export: 'BOARD_CATALOG', hosts: [] }],
      shell: [{ module: 'src/Shell.tsx', export: 'Shell' }],
      ...file,
    },
    {
      controlTables: controlTables ?? { '@closurestudio/ui': TABLE },
      catalogs: catalogs ?? [{ package: '@closurestudio/demo-room', hosts: ['DemoRoom'], catalog: CATALOG }],
    },
  );
}

/** The default page of a temp app: one `@fixture/ds` button, bound. */
const DEFAULT_ROUTES = [
  "import { Route, Routes } from 'react-router';",
  "import { Button } from '@fixture/ds';",
  'function HomePage() {',
  "  return <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>;",
  '}',
  'export function AppRoutes() {',
  '  return <Routes><Route path="/" element={<HomePage />} /></Routes>;',
  '}',
].join('\n');

export interface TempPackage {
  name: string;
  packageJson: Record<string, unknown>;
  files?: Record<string, string>;
}

/**
 * An app outside this repository, with its own `node_modules`: one page whose
 * one button is `@fixture/ds`'s, and the packages given.
 */
export function tempApp(packages: readonly TempPackage[], routes: string = DEFAULT_ROUTES): string {
  const root = tempDir('oui-app-');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', JSON.stringify({ name: 'temp-app', private: true, dependencies: {} }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', noEmit: true }, include: ['src'] }));
  write('src/routes.tsx', routes);
  for (const p of packages) {
    write(`node_modules/${p.name}/package.json`, JSON.stringify({ name: p.name, ...p.packageJson }));
    for (const [file, content] of Object.entries(p.files ?? {})) write(`node_modules/${p.name}/${file}`, content);
  }
  return root;
}
