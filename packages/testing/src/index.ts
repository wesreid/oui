/**
 * @ouispec/testing — the OUI conformance kit (ADR-0226 §3.2).
 *
 * It runs in the integrator's own test runner, in any DOM environment, and
 * reports against the published contract (`@ouispec/contract`):
 *
 * - `checkDesignSystem`: a tier 1 design system — its table and declaration
 *   match the schemas, every entry registers with the kind it declares, every
 *   export that takes a callback is accounted for, and every binding's `run`
 *   returns its callback's result (a job's `pending.jobId` too);
 * - `checkApp`: every action of a generated manifest has a handler mounted on
 *   the page that offers it;
 * - `checkTier2`: every tier 2 wrapper forwards `valueFrom` correctly, and
 *   every uncontrolled use of a mapped control is reported.
 * - `checkRoom`: a tier 3 room — its catalog matches the schema, every list it
 *   reports is declared, and its `query` and `inspect` return what it holds.
 *
 * Each returns a `ConformanceReport`; `assertConformant` throws with every
 * violation listed, so any runner fails with the whole report.
 *
 * ```ts
 * it('passes the OUI conformance kit', async () => {
 *   assertConformant(await checkDesignSystem({ name: '@acme/ui', packageJson, table, exports: ui, examples, excluded, source }));
 * });
 * ```
 */
export { checkDesignSystem, type DesignSystemSpec } from './design-system.js';
export { checkApp, type AppSpec } from './app.js';
export { checkTier2, type Tier2Spec, type Tier2Use } from './tier2.js';
export { checkRoom, type RoomSpec } from './room.js';
export { checkBudgets, type BudgetSpec } from './budgets.js';
export { readShippedPackage, type ShippedPackage } from './package.js';
export { exportedComponents, type ExportedComponent, type SourceEntry } from './exports.js';
export { kitBindingId, type ControlExample, type ExampleContext, type ExampleElements, type Wrapper } from './harness.js';
export { sampleValue } from './sample.js';
export {
  assertConformant,
  CONFORMANCE_RULES,
  ConformanceError,
  formatReport,
  type ConformanceReport,
  type ConformanceRule,
  type Violation,
} from './report.js';
