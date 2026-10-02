/**
 * The assistant can't operate its own approval (ADR-0228 §2.2.3, §5.5).
 *
 * A package declares the components only the person may use, under
 * `oui.personOnly` in its package.json, each with the reason. The generator
 * refuses an `agent` binding on one, and a spread that could carry one, so
 * nothing in a build ever offers the assistant a way to approve. The SDK's
 * `ApprovalCard` is declared so.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import type { ControlTable } from '@ouispec/bindings';

import { generate, resolveConfig } from '../src/index.js';
import { TABLE, tempApp } from './fixture-config.js';

const DS = {
  name: '@fixture/ds',
  packageJson: { oui: { agentControls: './dist/agent-controls.json' } },
  files: { 'dist/agent-controls.json': JSON.stringify({ Button: TABLE.Button } satisfies ControlTable) },
};
const REASON = 'Only the person approves an irreversible action: the assistant never operates its own approval';
const AGENT_REACT = {
  name: '@fixture/agent-react',
  packageJson: { oui: { personOnly: { ApprovalCard: REASON } } },
};

const page = (card: string) =>
  [
    "import { Route, Routes } from 'react-router';",
    "import { Button } from '@fixture/ds';",
    "import { ApprovalCard, ApprovalCard as Card } from '@fixture/agent-react';",
    'const parts = { Button };',
    'const extra = { agent: { id: "approve", description: "Approve" } };',
    'function HomePage() {',
    '  return (',
    '    <>',
    "      <Button agent={{ id: 'home.start', description: 'Start' }} onClick={() => {}}>Start</Button>",
    `      ${card}`,
    '    </>',
    '  );',
    '}',
    'export function AppRoutes() {',
    '  return <Routes><Route path="/" element={<HomePage />} /></Routes>;',
    '}',
  ].join('\n');

async function generateWith(card: string) {
  const root = tempApp([DS, AGENT_REACT], page(card));
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

const messages = (r: Awaited<ReturnType<typeof generateWith>>) => r.errors.map(e => e.message);

describe('a person-only component', () => {
  it('builds clean when it is used as itself, callbacks and all: the assistant is never offered it', async () => {
    const r = await generateWith('<ApprovalCard components={parts} onDecided={() => {}} />');
    expect(messages(r)).toEqual([]);
    expect(r.manifest.surfaces.flatMap(s => s.actions).map(a => a.name).sort()).toEqual(['app_navigate', 'home_start']);
  });

  it('refuses an agent binding on it, through a rename too, naming the reason', async () => {
    for (const card of [
      "<ApprovalCard agent={{ id: 'approval.approve', description: 'Approve the order' }} components={parts} />",
      "<Card agent={{ id: 'approval.approve', description: 'Approve the order' }} />",
      '<ApprovalCard agent={{ nonAgent: "decorative" }} />',
    ]) {
      const r = await generateWith(card);
      expect(messages(r), card).toEqual([
        `<${card.startsWith('<Card') ? 'Card' : 'ApprovalCard'}> from @fixture/agent-react is the person's own and takes no agent binding: ${REASON}`,
      ]);
      expect(r.manifest.surfaces.flatMap(s => s.actions).map(a => a.name).sort()).toEqual(['app_navigate', 'home_start']);
    }
  });

  it('refuses a spread on it, which could carry a binding the build cannot read', async () => {
    const r = await generateWith('<ApprovalCard {...extra} />');
    expect(messages(r)).toEqual([
      `<ApprovalCard> from @fixture/agent-react is the person's own: write its props out, not as a spread, so the build can see none is an agent binding`,
    ]);
  });

  it('is how the SDK declares ApprovalCard', () => {
    const require = createRequire(import.meta.url);
    const json = JSON.parse(readFileSync(require.resolve('@ouispec/agent-react/package.json'), 'utf8')) as {
      oui?: { personOnly?: Record<string, string> };
    };
    expect(json.oui?.personOnly?.ApprovalCard).toMatch(/\w/);
  });
});
