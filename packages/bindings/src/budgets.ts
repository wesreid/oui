/**
 * How large what a build offers the assistant may be (ADR-0245 §2.6).
 *
 * A page sends an index of its actions, and a definition when one is asked
 * for. Each has a frame it must fit: an index entry is a line the model reads
 * for every action on the page, a definition is one answer on the wire, and a
 * surface's index travels with every snapshot. A catalogue that outgrows them
 * fails the build that adds it, with the action named, instead of failing the
 * assistant on the page that mounts it.
 */
import { indexEntry, jsonBytes, type OUIAction } from 'oui-spec/spec';

import { effectKind } from './effect.js';
import type { ManifestAction, ManifestSurface } from './manifest.js';

/** The limits, in bytes of JSON. */
export const BUDGETS = {
  /** One action's entry in the page's index. */
  indexEntryBytes: 512,
  /** One action's whole definition: what `oui.describe` returns for it in one answer. */
  definitionBytes: 256 * 1024,
  /** One surface's index: every action's entry. */
  surfaceIndexBytes: 128 * 1024,
} as const;

export type Budgets = { readonly [K in keyof typeof BUDGETS]: number };

export interface BudgetProblem {
  kind: 'index-entry' | 'definition' | 'surface-index';
  surface: string;
  /** The action's id, for a problem with one action. */
  action?: string;
  /** Where the action is declared, when the manifest says. */
  declaredIn?: string;
  bytes: number;
  limit: number;
  message: string;
}

/** A manifest action as the page offers it to the assistant: what its index entry and its definition are made from. */
export function offeredAction(action: ManifestAction): OUIAction {
  return {
    id: action.name,
    title: action.title,
    description: action.description,
    input: action.input as OUIAction['input'],
    ...(action.effect ? { effect: effectKind(action.effect) } : {}),
    ...(action.destructive || action.confirm ? { confirm: true } : {}),
  };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** Every budget the manifest's surfaces exceed, each naming what is over and by how much. */
export function manifestBudgetProblems(
  manifest: { surfaces: readonly ManifestSurface[] },
  budgets: Budgets = BUDGETS,
): BudgetProblem[] {
  const problems: BudgetProblem[] = [];
  for (const surface of manifest.surfaces) {
    let surfaceBytes = 0;
    for (const action of surface.actions) {
      const offered = offeredAction(action);
      const where = action.declaredIn ? { declaredIn: action.declaredIn } : {};
      const definition = jsonBytes(offered);
      if (definition > budgets.definitionBytes) {
        problems.push({
          kind: 'definition',
          surface: surface.id,
          action: action.id,
          ...where,
          bytes: definition,
          limit: budgets.definitionBytes,
          message:
            `${action.id}: its definition is ${kb(definition)}, over the ${kb(budgets.definitionBytes)} one answer carries. ` +
            'Split the action, or move what it lists into a reader the assistant queries.',
        });
      }
      const entry = jsonBytes(indexEntry(offered));
      surfaceBytes += entry;
      if (entry > budgets.indexEntryBytes) {
        problems.push({
          kind: 'index-entry',
          surface: surface.id,
          action: action.id,
          ...where,
          bytes: entry,
          limit: budgets.indexEntryBytes,
          message: `${action.id}: its index entry is ${entry} bytes, over ${budgets.indexEntryBytes}. Shorten its id or its title.`,
        });
      }
    }
    if (surfaceBytes > budgets.surfaceIndexBytes) {
      problems.push({
        kind: 'surface-index',
        surface: surface.id,
        bytes: surfaceBytes,
        limit: budgets.surfaceIndexBytes,
        message:
          `${surface.id}: the index of its ${surface.actions.length} actions is ${kb(surfaceBytes)}, over ${kb(budgets.surfaceIndexBytes)}. ` +
          'Split the surface: a page into its sections, a room into rooms.',
      });
    }
  }
  return problems;
}
