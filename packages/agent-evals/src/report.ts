/**
 * What a run says (ADR-0260 §3.7): a line per case, every failed assertion
 * with its turn, its channel and the reply; and JUnit XML for a CI's test
 * view.
 */
import { failureLine, type EvalCaseResult, type EvalReport } from './run.js';

/** The report as text: one line per case, and under each failed case every failure. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    lines.push(`${c.passed ? 'PASS' : 'FAIL'}  ${c.suite} › ${c.scenario} [${c.channel}]  ${c.title}  (${c.durationMs} ms)`);
    for (const f of c.failures) lines.push(`        ${failureLine(f)}`);
  }
  lines.push('');
  const how = report.mode === 'replay' ? 'from the recordings' : report.mode === 'record' ? 'recorded from the live model' : 'against the live model';
  lines.push(`${report.passed} passed, ${report.failed} failed, of ${report.cases.length} (${how})`);
  return lines.join('\n');
}

/** A character XML 1.0 cannot hold at all: the control characters but tab, line feed and carriage return. */
const unwritable = (c: string) => {
  const code = c.charCodeAt(0);
  return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
};

const xml = (text: string) =>
  [...text]
    .filter((c) => !unwritable(c))
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The report as JUnit XML: a test suite per eval suite, a test case per scenario and channel. */
export function junitReport(report: EvalReport): string {
  const bySuite = new Map<string, EvalCaseResult[]>();
  for (const c of report.cases) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c]);
  const suites = [...bySuite.entries()].map(([name, cases]) => {
    const failed = cases.filter((c) => !c.passed).length;
    const time = cases.reduce((ms, c) => ms + c.durationMs, 0) / 1000;
    const body = cases
      .map((c) => {
        const head = `    <testcase classname="${xml(`${name}.${c.channel}`)}" name="${xml(`${c.scenario}: ${c.title}`)}" time="${(c.durationMs / 1000).toFixed(3)}"`;
        if (c.passed) return `${head}/>`;
        const message = c.failures.map(failureLine).join('\n');
        return `${head}>\n      <failure message="${xml(c.failures[0] ? failureLine(c.failures[0]) : 'failed')}">${xml(message)}</failure>\n    </testcase>`;
      })
      .join('\n');
    return `  <testsuite name="${xml(name)}" tests="${cases.length}" failures="${failed}" time="${time.toFixed(3)}">\n${body}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${report.cases.length}" failures="${report.failed}">\n${suites.join('\n')}\n</testsuites>\n`;
}
