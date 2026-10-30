/**
 * What a run says: a line per case, every failed assertion
 * with its turn, its channel and the reply; and JUnit XML for a CI's test
 * view. A case none of whose assertions failed, but one of whose rubrics the
 * judge gave no verdict on, is reported as not judged (`JUDGE`), apart from
 * the cases that failed: in JUnit, as an error rather than a failure.
 */
import { failureLine, type EvalCaseResult, type EvalReport } from './run.js';

/** A case's status as its line starts: `PASS`, `FAIL`, or `JUDGE` when only the judge failed. */
export const statusWord = (c: EvalCaseResult) => (c.status === 'passed' ? 'PASS' : c.status === 'unjudged' ? 'JUDGE' : 'FAIL');

/** A case's line, and under it every failure. */
export function caseLines(c: EvalCaseResult): string[] {
  return [`${statusWord(c).padEnd(4)}  ${c.suite} › ${c.scenario} [${c.channel}]  ${c.title}  (${c.durationMs} ms)`, ...c.failures.map((f) => `        ${failureLine(f)}`)];
}

/** The report's last line: how many passed, failed and could not be judged. */
export function summaryLine(report: EvalReport): string {
  const how = report.mode === 'replay' ? 'from the recordings' : report.mode === 'record' ? 'recorded from the live model' : 'against the live model';
  const unjudged = report.unjudged > 0 ? `, ${report.unjudged} not judged (the judge gave no verdict)` : '';
  return `${report.passed} passed, ${report.failed} failed${unjudged}, of ${report.cases.length} (${how})`;
}

/** The report as text: one line per case, and under each failed case every failure. */
export function formatReport(report: EvalReport): string {
  return [...report.cases.flatMap(caseLines), '', summaryLine(report)].join('\n');
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
    const failed = cases.filter((c) => c.status === 'failed').length;
    const errors = cases.filter((c) => c.status === 'unjudged').length;
    const time = cases.reduce((ms, c) => ms + c.durationMs, 0) / 1000;
    const body = cases
      .map((c) => {
        const head = `    <testcase classname="${xml(`${name}.${c.channel}`)}" name="${xml(`${c.scenario}: ${c.title}`)}" time="${(c.durationMs / 1000).toFixed(3)}"`;
        if (c.passed) return `${head}/>`;
        const message = c.failures.map(failureLine).join('\n');
        // A judge that gave no verdict is an error of the run, not a failure of the agent.
        const tag = c.status === 'unjudged' ? 'error' : 'failure';
        return `${head}>\n      <${tag} message="${xml(c.failures[0] ? failureLine(c.failures[0]) : 'failed')}">${xml(message)}</${tag}>\n    </testcase>`;
      })
      .join('\n');
    return `  <testsuite name="${xml(name)}" tests="${cases.length}" failures="${failed}" errors="${errors}" time="${time.toFixed(3)}">\n${body}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${report.cases.length}" failures="${report.failed}" errors="${report.unjudged}">\n${suites.join('\n')}\n</testsuites>\n`;
}
