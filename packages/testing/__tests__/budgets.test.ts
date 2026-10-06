/**
 * The size budgets, for an integrator's own test (ADR-0245 §2.6): the check
 * `oui generate` runs on a build, against the contract's limits or the
 * integrator's own.
 */
import { describe, expect, it } from 'vitest';
import type { ManifestAction, ManifestSurface } from '@ouispec/bindings';

import { checkBudgets } from '../src/index.js';

const action = (id: string, input: ManifestAction['input'] = { type: 'object', properties: {} }): ManifestAction => ({
  name: id.replace(/[^a-z0-9]+/g, '_'),
  id,
  source: 'room-action',
  title: `Title of ${id}`,
  description: `Does ${id}. It is one undo step.`,
  input,
  reach: [],
});

const surface = (id: string, actions: ManifestAction[]): ManifestSurface => ({
  id,
  kind: 'room',
  title: id,
  description: 'A room',
  routes: ['/room'],
  actions,
  observations: [],
});

describe('checkBudgets', () => {
  it('passes a build within the budgets, and says how much it measured', () => {
    const report = checkBudgets({ name: 'desk', manifest: { surfaces: [surface('room:desk', [action('desk/action/a'), action('desk/action/b')])] } });
    expect(report.violations).toEqual([]);
    // Each action, and the surface's index.
    expect(report.checked).toEqual({ 'within-budgets': 3 });
  });

  it('names the action whose definition one answer cannot carry', () => {
    const catalogue = { type: 'object' as const, properties: { symbol: { enum: Array.from({ length: 40_000 }, (_, i) => `SYM-${i}`) } } };
    const report = checkBudgets({ name: 'desk', manifest: { surfaces: [surface('room:desk', [action('desk/action/a'), action('desk/action/pick', catalogue)])] } });
    expect(report.violations).toEqual([
      {
        rule: 'within-budgets',
        subject: 'room:desk desk/action/pick',
        message: expect.stringMatching(/^desk\/action\/pick: its definition is \d+\.\d KB, over the 256\.0 KB one answer carries\./),
      },
    ]);
  });

  it('holds a build to an integrator’s own limits when its transport carries less', () => {
    const actions = Array.from({ length: 40 }, (_, i) => action(`desk/action/a${i}`));
    const report = checkBudgets({ name: 'desk', manifest: { surfaces: [surface('room:desk', actions)] }, budgets: { surfaceIndexBytes: 4 * 1024 } });
    expect(report.violations).toEqual([
      {
        rule: 'within-budgets',
        subject: 'room:desk',
        message: expect.stringMatching(/^room:desk: the index of its 40 actions is \d+\.\d KB, over 4\.0 KB\. Split the surface/),
      },
    ]);
  });

  it('measures an action that takes an attached file, its index line saying so', () => {
    const file = {
      type: 'object' as const,
      properties: {
        picture: { type: 'string' as const, format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/png', 'image/jpeg'] } },
        svg: { type: 'string' as const, format: 'oui-attachment', 'x-oui-attachment': { as: 'text', mediaTypes: ['image/svg+xml'] } },
      },
      required: ['picture'],
    };
    const report = checkBudgets({ name: 'studio', manifest: { surfaces: [surface('room:studio', [action('studio/action/texture', file as ManifestAction['input'])])] } });
    expect(report.violations).toEqual([]);
    expect(report.checked).toEqual({ 'within-budgets': 2 });
  });
});
