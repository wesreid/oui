/**
 * One approval per irreversible act (ADR-0228 §2.1). A destructive step runs
 * only on the person's approval of that call, so a control that only opens the
 * dialog where the destructive step is confirmed must not be destructive too:
 * deleting would then ask twice, once for opening a dialog. The generator
 * knows which control opens which dialog, so it fails the build, naming both.
 */
import { describe, expect, it } from 'vitest';

import type { ControlTable } from '@ouispec/bindings';

import { generate, resolveConfig } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: {
    'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button, ConfirmDialog: TABLE.ConfirmDialog } satisfies ControlTable),
  },
};

const page = (opener: string, confirm: string) =>
  [
    "import { useState } from 'react';",
    "import { Route, Routes } from 'react-router';",
    "import { Button, ConfirmDialog } from '@fixture/ds';",
    'function HomePage() {',
    '  const [open, setOpen] = useState(false);',
    '  return (',
    '    <>',
    `      <Button agent={{ id: 'projects.delete', description: 'Delete the project, after confirming'${opener} }} onClick={() => setOpen(true)}>Delete</Button>`,
    '      <ConfirmDialog',
    '        open={open}',
    '        title="Delete Project"',
    '        onConfirm={() => {}}',
    '        onCancel={() => setOpen(false)}',
    `        agent={{ confirm: { id: 'projects.delete.confirm', description: 'Delete it'${confirm} }, cancel: { id: 'projects.delete.cancel', description: 'Keep it' } }}`,
    '      />',
    '    </>',
    '  );',
    '}',
    'export function AppRoutes() {',
    '  return <Routes><Route path="/" element={<HomePage />} /></Routes>;',
    '}',
  ].join('\n');

async function generateWith(opener: string, confirm: string) {
  const root = tempApp([DS], page(opener, confirm));
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

describe('a destructive step is approved once', () => {
  it('fails a destructive control that only opens the dialog where a destructive step is confirmed', async () => {
    const r = await generateWith(', destructive: true', ', destructive: true');
    expect(r.errors.map(e => e.message)).toEqual([
      '"projects.delete" opens the "Delete Project" dialog, where "projects.delete.confirm" is the destructive step: ' +
        'the person approves that one, so "projects.delete" is not destructive itself. Remove its `destructive`',
    ]);
  });

  it('builds clean when only the confirming step is destructive', async () => {
    const r = await generateWith('', ', destructive: true');
    expect(r.errors).toEqual([]);
    const actions = r.manifest.surfaces.flatMap(s => s.actions);
    expect(actions.find(a => a.id === 'projects.delete')?.destructive).toBeUndefined();
    expect(actions.find(a => a.id === 'projects.delete.confirm')?.destructive).toBe(true);
  });

  it('leaves a destructive control alone when it does something itself before its dialog shows', async () => {
    const r = await generateWith(", destructive: true, effect: { kind: 'mutate', operation: 'rotateKey' }", ', destructive: true');
    expect(r.errors.map(e => e.message).filter(m => m.includes('destructive step'))).toEqual([]);
  });

  it('leaves a destructive opener alone when nothing in its dialog is destructive', async () => {
    const r = await generateWith(', destructive: true', '');
    expect(r.errors).toEqual([]);
  });
});
