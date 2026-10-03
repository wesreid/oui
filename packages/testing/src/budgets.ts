/**
 * A build's manifest against the size budgets (ADR-0245 §2.6): the same check
 * `oui generate` runs, for an integrator's own test, and against budgets of
 * its own when its transport carries less.
 */
import { BUDGETS, manifestBudgetProblems, type Budgets, type OuiManifest } from '@ouispec/bindings';

import { ReportBuilder, type ConformanceReport } from './report.js';

export interface BudgetSpec {
  /** The app, for the report. */
  name: string;
  /** The generated manifest (`oui-manifest.json`). */
  manifest: Pick<OuiManifest, 'surfaces'>;
  /** Limits in bytes, when they differ from the contract's. */
  budgets?: Partial<Budgets>;
}

export function checkBudgets(spec: BudgetSpec): ConformanceReport {
  const out = new ReportBuilder(spec.name);
  const problems = manifestBudgetProblems(spec.manifest, { ...BUDGETS, ...spec.budgets });
  // One check per action and per surface, so a passing report shows how much was measured.
  for (const surface of spec.manifest.surfaces) {
    for (const action of surface.actions) {
      const over = problems.filter((p) => p.surface === surface.id && p.action === action.id);
      out.check('within-budgets', `${surface.id} ${action.id}`, over.length ? over.map((p) => p.message).join('; ') : null);
    }
    const over = problems.find((p) => p.surface === surface.id && p.kind === 'surface-index');
    out.check('within-budgets', surface.id, over ? over.message : null);
  }
  return out.report();
}
