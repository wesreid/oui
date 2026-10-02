/**
 * What the conformance kit checks (ADR-0226 §3.2), and what it reports.
 *
 * Each rule has an id an integrator's test can name, the ADR's wording, and
 * the checks that ran under it, so a passing report shows that every rule was
 * exercised and not merely that nothing was found.
 */

/** The kit's rules, in the order ADR-0226 §3.2 lists them, after the schemas they rest on. */
export const CONFORMANCE_RULES = {
  'matches-contract':
    'What the package ships and declares matches the published schemas: its control table, its `oui` (or, during the transition, `closure`) declaration in package.json, a manifest, a mapping.',
  'registers-declared-kind': 'Every table entry registers at runtime with the kind it declares.',
  'callbacks-accounted': 'Every export that takes a callback is in the table, or excluded with a reason.',
  'run-returns-result': 'Every binding’s `run` returns its callback’s result, and a job control reports `pending.jobId`.',
  'actions-mounted': 'Every generated manifest action has a mounted handler on the page that offers it.',
  'tier2-forwards-value': 'Every tier 2 wrapper forwards `valueFrom` correctly.',
  'tier2-reports-uncontrolled': 'Every use of a mapped control that does not pass its `controlled` prop is reported.',
} as const;

export type ConformanceRule = keyof typeof CONFORMANCE_RULES;

export interface Violation {
  rule: ConformanceRule;
  /** What broke it: an export, a slot of one, a manifest action, a use. */
  subject: string;
  message: string;
}

export interface ConformanceReport {
  /** Who was checked: a design system's package, an app, a mapping. */
  target: string;
  violations: Violation[];
  /** How many checks ran under each rule. */
  checked: Partial<Record<ConformanceRule, number>>;
}

/** A report being written. */
export class ReportBuilder {
  private readonly violations: Violation[] = [];
  private readonly checked: Partial<Record<ConformanceRule, number>> = {};

  constructor(private readonly target: string) {}

  /** One check ran under `rule`; when `problem` is given, it failed. */
  check(rule: ConformanceRule, subject: string, problem?: string | null): boolean {
    this.checked[rule] = (this.checked[rule] ?? 0) + 1;
    if (problem) this.violations.push({ rule, subject, message: problem });
    return !problem;
  }

  report(): ConformanceReport {
    return { target: this.target, violations: [...this.violations], checked: { ...this.checked } };
  }
}

/** A report as text: one line per violation, under its rule. */
export function formatReport(report: ConformanceReport): string {
  if (!report.violations.length) {
    const ran = Object.entries(report.checked)
      .map(([rule, n]) => `${rule} ${n}`)
      .join(', ');
    return `${report.target} conforms to the OUI contract (${ran || 'no checks ran'}).`;
  }
  const lines = [`${report.target} breaks the OUI contract in ${report.violations.length} place(s):`];
  for (const rule of Object.keys(CONFORMANCE_RULES) as ConformanceRule[]) {
    const mine = report.violations.filter(v => v.rule === rule);
    if (!mine.length) continue;
    lines.push(`  ${rule}: ${CONFORMANCE_RULES[rule]}`);
    for (const v of mine) lines.push(`    - ${v.subject}: ${v.message}`);
  }
  return lines.join('\n');
}

export class ConformanceError extends Error {
  constructor(readonly report: ConformanceReport) {
    super(formatReport(report));
    this.name = 'ConformanceError';
  }
}

/** Throw a `ConformanceError` listing every violation, so any test runner fails with the full report. */
export function assertConformant(report: ConformanceReport): void {
  if (report.violations.length) throw new ConformanceError(report);
}
