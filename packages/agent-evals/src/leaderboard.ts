/**
 * A model matrix's results as people read them: a self-contained HTML
 * leaderboard (a sortable table of the models, the picks, each category's
 * pass rates, and every scenario's results by model, opened one at a time), a
 * Markdown summary, and the lines the CLI prints.
 *
 * Each is a function of the results alone: the same results give the same
 * bytes. The page loads nothing: its styles and its one script are inline,
 * and every value in it is escaped.
 */
import { UNTAGGED, percentile, type MatrixCase, type ModelSummary, type Percentiles, type Spread } from './aggregate.js';
import type { MatrixResults } from './matrix.js';
import type { EvalEstimate } from './spend.js';

// ─── Figures ────────────────────────────────────────────────────────────────

const DASH = '—';

/** Digits grouped by thousands, with no locale's say. */
function grouped(n: number, decimals = 0): string {
  const [whole, fraction] = Math.abs(n).toFixed(decimals).split('.');
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${digits}${fraction ? `.${fraction}` : ''}`;
}

/** Dollars: four decimals under a dollar, two from there. */
export const usd = (n: number | null | undefined): string => (n === null || n === undefined ? DASH : `$${grouped(n, Math.abs(n) < 1 ? 4 : 2)}`);
/** A share, as a percentage with one decimal. */
export const pct = (n: number | null | undefined): string => (n === null || n === undefined ? DASH : `${(n * 100).toFixed(1)}%`);
/** A count. */
export const int = (n: number | null | undefined): string => (n === null || n === undefined ? DASH : grouped(Math.round(n)));
/** A mean count, with one decimal. */
const mean1 = (n: number | null | undefined): string => (n === null || n === undefined ? DASH : grouped(n, 1));
/** A time: milliseconds under a second, seconds with two decimals from there. */
export const ms = (n: number | null | undefined): string => (n === null || n === undefined ? DASH : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);

const spreadText = (s: Spread | null, format: (n: number) => string) => (s ? `${format(s.min)}–${format(s.max)}` : DASH);
const pair = (p: Percentiles) => `${ms(p.p50)} / ${ms(p.p90)}`;

const modelLabel = (results: MatrixResults, id: string) => results.models.find((m) => m.id === id)?.label ?? id;

/** The models best first: highest pass rate, then cheapest per completed task, then the order they were given. */
export function ranked(results: MatrixResults): ModelSummary[] {
  const order = new Map(results.models.map((m, i) => [m.id, i]));
  const rate = (s: ModelSummary) => s.passRate ?? -1;
  const cost = (s: ModelSummary) => s.cost.perCompletedTaskUsd ?? Number.POSITIVE_INFINITY;
  return [...results.summaries].sort((a, b) => rate(b) - rate(a) || cost(a) - cost(b) || order.get(a.model)! - order.get(b.model)!);
}

/** What the run was, in one line. */
function runLine(results: MatrixResults): string {
  const how = results.mode === 'replay' ? 'from the recordings' : results.mode === 'record' ? 'recorded from the live models' : 'against the live models';
  const pairs = new Set(results.scenarios.flatMap((s) => s.channels.map((c) => `${s.suite}\u0000${s.id}\u0000${c}`))).size;
  const judge = results.judge ? `, judged by ${results.judge.label}` : '';
  return `${results.scenarios.length} scenarios (${pairs} with their channels) × ${results.models.length} models × ${results.runs} run${results.runs === 1 ? '' : 's'}, ${how}${judge}; started ${results.startedAt}`;
}

/** What the run spent, against its estimate and its limit. */
function spendLine(results: MatrixResults): string {
  const { spend } = results;
  const parts = [`spent ${usd(spend.spentUsd)} (models ${usd(spend.agentUsd)}, judge ${usd(spend.judgeUsd)})`];
  if (spend.estimate) parts.push(`estimated ${usd(spend.estimate.totalUsd)}`);
  if (spend.maxCostUsd !== null) parts.push(`limit ${usd(spend.maxCostUsd)}`);
  return parts.join('; ');
}

/** Why the run stopped early, when it did. */
export function stopLine(results: MatrixResults): string | null {
  const stopped = results.spend.stopped;
  if (!stopped) return null;
  return stopped.reason === 'estimate'
    ? `Not run: the estimate, ${usd(results.spend.estimate?.totalUsd)}, is over the limit of ${usd(results.spend.maxCostUsd)}. ${int(stopped.casesNotRun)} cases were not run.`
    : `Stopped: the run spent its limit of ${usd(results.spend.maxCostUsd)}. ${int(stopped.casesNotRun)} cases were not run to their end, and are left out of every figure.`;
}

/** Each pick, in words. */
function pickLines(results: MatrixResults): string[] {
  return results.leaders.map((leader) => {
    const scope = leader.scope === 'all' ? 'All scenarios' : leader.scope;
    if (!leader.best) return `${scope}: nothing was judged.`;
    const best = `best ${pct(leader.best.passRate)} (${modelLabel(results, leader.best.model)})`;
    if (!leader.pick) return `${scope}: no pick; ${best}, and no model passed a case.`;
    const picked = leader.contenders[0];
    return `${scope}: ${modelLabel(results, leader.pick)}, ${pct(picked.passRate)} at ${usd(picked.costPerCompletedTaskUsd)} per completed task; ${best}, within ${leader.withinPoints} points: ${leader.contenders.length}.`;
  });
}

// ─── The CLI's lines ────────────────────────────────────────────────────────

/** The lines the CLI prints after a matrix: a line per model, best first, then the picks and what was spent. */
export function matrixSummaryLines(results: MatrixResults): string[] {
  const lines = ranked(results).map(
    (s, i) =>
      `${String(i + 1).padStart(2)}. ${s.label}: ${pct(s.passRate)} passed (${spreadText(s.passRateByRun, pct)} by run), ${usd(s.cost.perCompletedTaskUsd)} per completed task, ` +
      `first token ${pair(s.latencyMs.firstToken)}, ${mean1(s.modelCalls.perTurn)} calls a turn, ${int(s.invalidToolCalls.total)} invalid tool calls, ${int(s.refusals.total)} refusals`,
  );
  const stop = stopLine(results);
  return [...lines, '', ...pickLines(results), '', spendLine(results), ...(stop ? [stop] : [])];
}

/** An estimate, as the CLI prints it: a line per model, the judge's, and the total against the limit. */
export function estimateLines(estimate: EvalEstimate, maxCostUsd: number | undefined): string[] {
  const lines = estimate.models.map(
    (m) => `${m.label}: ${int(m.cases)} cases, ${int(m.turns)} turns, ${int(m.inputTokens)} input and ${int(m.outputTokens)} output tokens at most: ${usd(m.usd)}`,
  );
  if (estimate.judge.calls > 0) lines.push(`judge (${estimate.judge.model ?? 'the model'}): ${int(estimate.judge.calls)} verdicts: ${usd(estimate.judge.usd)}`);
  lines.push(
    `estimated ${usd(estimate.totalUsd)} for ${estimate.runs} run${estimate.runs === 1 ? '' : 's'}${
      maxCostUsd === undefined ? '' : estimate.totalUsd > maxCostUsd ? `: over the limit of ${usd(maxCostUsd)}` : `: within the limit of ${usd(maxCostUsd)}`
    }`,
  );
  return lines;
}

// ─── Markdown ───────────────────────────────────────────────────────────────

/** A table cell: no pipe or line break can end it. */
const md = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const LEADERBOARD_COLUMNS = [
  'Model',
  'Pass rate',
  'By run (min–max)',
  'Cost / completed task',
  'Cost / run',
  'Input / turn',
  'Cache read',
  'Output / turn',
  'Calls / turn',
  'First token p50 / p90',
  'Model time p50 / p90',
  'Invalid tool calls',
  'Refusals',
] as const;

const leaderboardRow = (s: ModelSummary): string[] => [
  s.label,
  pct(s.passRate),
  spreadText(s.passRateByRun, pct),
  usd(s.cost.perCompletedTaskUsd),
  usd(s.cost.perRunUsd?.mean),
  int(s.tokens.perTurn.input),
  pct(s.tokens.cachedShare),
  int(s.tokens.perTurn.output),
  mean1(s.modelCalls.perTurn),
  pair(s.latencyMs.firstToken),
  pair(s.latencyMs.total),
  int(s.invalidToolCalls.total),
  int(s.refusals.total),
];

const categoriesOf = (results: MatrixResults) => [...new Set(results.summaries.flatMap((s) => Object.keys(s.categories)))].sort();

/** The cases of one scenario. */
const casesOf = (results: MatrixResults, suite: string, id: string) => results.cases.filter((c) => c.suite === suite && c.scenario === id);

/** The Markdown summary: the leaderboard, the picks, the categories, and every scenario some model failed. */
export function matrixMarkdown(results: MatrixResults): string {
  const out: string[] = ['# Model leaderboard', '', runLine(results) + '.', '', spendLine(results) + '.'];
  const stop = stopLine(results);
  if (stop) out.push('', `> ${stop}`);
  out.push('', `| ${LEADERBOARD_COLUMNS.join(' | ')} |`, `|${LEADERBOARD_COLUMNS.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`);
  for (const s of ranked(results)) out.push(`| ${leaderboardRow(s).map(md).join(' | ')} |`);

  out.push('', '## Picks', '', `The cheapest model per completed task among those within ${results.withinPoints} points of the best pass rate.`, '');
  for (const line of pickLines(results)) out.push(`- ${md(line)}`);

  const categories = categoriesOf(results);
  const models = ranked(results);
  out.push('', '## By category', '', `| Category | ${models.map((s) => md(s.label)).join(' | ')} |`, `|---|${models.map(() => '---:').join('|')}|`);
  for (const tag of categories) {
    out.push(`| ${md(tag)} | ${models.map((s) => (s.categories[tag] ? `${pct(s.categories[tag].passRate)} (${s.categories[tag].passed}/${s.categories[tag].judged})` : DASH)).join(' | ')} |`);
  }

  const failing = results.scenarios.filter((sc) => casesOf(results, sc.suite, sc.id).some((c) => c.status === 'failed' || c.status === 'unjudged'));
  out.push('', '## Scenarios some model failed', '');
  if (failing.length === 0) out.push('None.');
  for (const sc of failing) {
    const cases = casesOf(results, sc.suite, sc.id);
    const byModel = models.map((s) => {
      const mine = cases.filter((c) => c.model === s.model && c.status !== 'stopped');
      return `${s.label} ${mine.filter((c) => c.status === 'passed').length}/${mine.length}`;
    });
    out.push(`- **${md(sc.suite)} › ${md(sc.id)}** (${md(sc.title)}): ${md(byModel.join(', '))}`);
  }
  return `${out.join('\n')}\n`;
}

// ─── HTML ───────────────────────────────────────────────────────────────────

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A cell that sorts by `value` (a number, or text), showing `text`. */
const td = (text: string, value: number | string | null | undefined, className = '') =>
  `<td${className ? ` class="${className}"` : ''} data-v="${value === null || value === undefined ? '' : html(String(value))}">${html(text)}</td>`;

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1d2330;--muted:#5d6676;--line:#dde1e8;--head:#f3f5f8;--good:#1b7f45;--bad:#b42318;--warn:#9a6700;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e6e9ef;--muted:#9aa3b2;--line:#2b313c;--head:#1a1f27;--good:#4ec27f;--bad:#f0776b;--warn:#e3b341;--accent:#86a8ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
p{margin:4px 0}.muted{color:var(--muted)}
.banner{border:1px solid var(--warn);color:var(--warn);padding:8px 12px;border-radius:6px;margin:12px 0}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;vertical-align:top}
th:first-child,td:first-child{text-align:left}
thead th{background:var(--head);position:sticky;top:0}
th[data-sort]{cursor:pointer;user-select:none}
th[aria-sort=ascending]::after{content:" ▲"}th[aria-sort=descending]::after{content:" ▼"}
tbody tr:last-child td{border-bottom:none}
.pass{color:var(--good)}.fail{color:var(--bad)}
ul{margin:4px 0;padding-left:20px}
details{border:1px solid var(--line);border-radius:6px;margin:8px 0}
summary{cursor:pointer;padding:8px 12px;font-weight:600}
summary .muted{font-weight:400}
details .scroll{border:none;border-top:1px solid var(--line);border-radius:0}
td.failures{white-space:normal;text-align:left;min-width:320px;max-width:640px;font-size:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
`;

/** Sorts a table by the column whose head is clicked: numbers as numbers, empty last, again to reverse. */
const SCRIPT = `
document.querySelectorAll('table[data-sortable]').forEach(function (table) {
  var heads = table.querySelectorAll('thead th');
  heads.forEach(function (th, column) {
    th.setAttribute('data-sort', '');
    th.addEventListener('click', function () {
      var descending = th.getAttribute('aria-sort') !== 'descending';
      heads.forEach(function (other) { other.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      var numeric = th.getAttribute('data-type') === 'number';
      var body = table.tBodies[0];
      var rows = Array.prototype.slice.call(body.rows);
      rows.sort(function (a, b) {
        var x = a.cells[column].getAttribute('data-v'), y = b.cells[column].getAttribute('data-v');
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
        var order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        return descending ? -order : order;
      });
      rows.forEach(function (row) { body.appendChild(row); });
    });
  });
});
`;

const NUMBER_COLUMNS = new Set<string>(LEADERBOARD_COLUMNS.slice(1));

function leaderboardTable(results: MatrixResults): string {
  const head = `<tr><th data-type="number">#</th>${LEADERBOARD_COLUMNS.map((c) => `<th${NUMBER_COLUMNS.has(c) ? ' data-type="number"' : ''}>${html(c)}</th>`).join('')}</tr>`;
  const rows = ranked(results).map((s, i) => {
    const text = leaderboardRow(s);
    const values: Array<number | string | null | undefined> = [
      s.label,
      s.passRate,
      s.passRateByRun ? s.passRateByRun.max - s.passRateByRun.min : null,
      s.cost.perCompletedTaskUsd,
      s.cost.perRunUsd?.mean,
      s.tokens.perTurn.input,
      s.tokens.cachedShare,
      s.tokens.perTurn.output,
      s.modelCalls.perTurn,
      s.latencyMs.firstToken.p50,
      s.latencyMs.total.p50,
      s.invalidToolCalls.total,
      s.refusals.total,
    ];
    return `<tr>${td(String(i + 1), i + 1)}${text.map((t, c) => td(t, values[c])).join('')}</tr>`;
  });
  return `<div class="scroll"><table data-sortable id="leaderboard"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function modelsTable(results: MatrixResults): string {
  const head = '<tr><th>Model</th><th>Id</th><th data-type="number">Cases run</th><th data-type="number">Stopped</th><th data-type="number">Not judged</th><th data-type="number">Total cost</th><th data-type="number">Cost / turn</th><th data-type="number">Input tokens</th><th data-type="number">Cache read</th><th data-type="number">Cache write</th><th data-type="number">Output tokens</th><th data-type="number">Largest call input</th><th data-type="number">Context window</th><th>Prompt cache</th><th>Vision</th></tr>';
  const rows = results.summaries.map((s) => {
    const window = s.capabilities.contextWindow;
    return `<tr>${td(s.label, s.label)}${td(s.model, s.model)}${td(int(s.cases.ran), s.cases.ran)}${td(int(s.cases.stopped), s.cases.stopped)}${td(int(s.cases.unjudged), s.cases.unjudged)}${td(usd(s.cost.totalUsd), s.cost.totalUsd)}${td(usd(s.cost.perTurnUsd), s.cost.perTurnUsd)}${td(int(s.tokens.input), s.tokens.input)}${td(int(s.tokens.cacheRead), s.tokens.cacheRead)}${td(int(s.tokens.cacheWrite), s.tokens.cacheWrite)}${td(int(s.tokens.output), s.tokens.output)}${td(int(s.tokens.peakCallInput), s.tokens.peakCallInput, window !== undefined && s.tokens.peakCallInput > window ? 'fail' : '')}${td(window === undefined ? DASH : int(window), window ?? null)}${td(s.capabilities.promptCache ? 'yes' : 'no', s.capabilities.promptCache ? 1 : 0)}${td(s.capabilities.vision ? 'yes' : 'no', s.capabilities.vision ? 1 : 0)}</tr>`;
  });
  return `<div class="scroll"><table data-sortable id="models"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function categoriesTable(results: MatrixResults): string {
  const models = ranked(results);
  const head = `<tr><th>Category</th>${models.map((s) => `<th data-type="number">${html(s.label)}</th>`).join('')}</tr>`;
  const rows = categoriesOf(results).map((tag) => {
    const cells = models.map((s) => {
      const c = s.categories[tag];
      return c ? td(`${pct(c.passRate)} (${c.passed}/${c.judged}) · ${usd(c.costPerCompletedTaskUsd)}`, c.passRate) : td(DASH, null);
    });
    return `<tr>${td(tag === UNTAGGED ? `${tag} (no tag)` : tag, tag)}${cells.join('')}</tr>`;
  });
  return `<div class="scroll"><table data-sortable id="categories"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div><p class="muted">Pass rate (passed / judged) · cost per completed task.</p>`;
}

/** A case's failures, each told once with how many of the cases it is in. */
function failuresList(cases: readonly MatrixCase[]): string {
  const counts = new Map<string, number>();
  for (const c of cases) {
    for (const message of new Set(c.failures.map((f) => `${c.channel}${f.turn >= 0 ? `, turn ${f.turn + 1}` : ''}: ${f.assertion}: ${f.message}`))) {
      counts.set(message, (counts.get(message) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';
  const listed = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = listed.slice(0, 6).map(([message, n]) => `<li>${n > 1 ? `×${n} ` : ''}<code>${html(message.length > 400 ? `${message.slice(0, 400)}…` : message)}</code></li>`);
  const more = listed.length > 6 ? `<li class="muted">and ${listed.length - 6} more</li>` : '';
  return `<ul>${shown.join('')}${more}</ul>`;
}

function scenarioSection(results: MatrixResults): string {
  const models = ranked(results);
  return results.scenarios
    .map((sc) => {
      const cases = casesOf(results, sc.suite, sc.id).filter((c) => c.status !== 'stopped');
      const passed = cases.filter((c) => c.status === 'passed').length;
      const head = '<tr><th>Model</th><th data-type="number">Passed</th><th>By channel</th><th data-type="number">Cost / case</th><th data-type="number">Input / case</th><th data-type="number">Output / case</th><th data-type="number">First token p50</th><th>Failures</th></tr>';
      const rows = models.map((s) => {
        const mine = cases.filter((c) => c.model === s.model);
        const ok = mine.filter((c) => c.status === 'passed').length;
        const byChannel = sc.channels
          .map((channel) => {
            const on = mine.filter((c) => c.channel === channel);
            return `${channel} ${on.filter((c) => c.status === 'passed').length}/${on.length}`;
          })
          .join(' · ');
        const per = (pick: (c: MatrixCase) => number) => (mine.length ? mine.reduce((sum, c) => sum + pick(c), 0) / mine.length : null);
        const p50 = percentile(
          mine.flatMap((c) => c.turns.map((t) => t.usage.firstTokenMs).filter((v): v is number => v !== null)),
          0.5,
        );
        const cost = per((c) => c.costUsd);
        const input = per((c) => c.turns.reduce((n, t) => n + t.usage.inputTokens, 0));
        const output = per((c) => c.turns.reduce((n, t) => n + t.usage.outputTokens, 0));
        return `<tr>${td(s.label, s.label)}${td(`${ok}/${mine.length}`, mine.length ? ok / mine.length : null, mine.length && ok === mine.length ? 'pass' : ok < mine.length ? 'fail' : '')}${td(byChannel, byChannel)}${td(usd(cost), cost)}${td(int(input), input)}${td(int(output), output)}${td(ms(p50), p50)}<td class="failures">${failuresList(mine.filter((c) => c.status !== 'passed'))}</td></tr>`;
      });
      const tags = sc.tags.length ? ` · ${sc.tags.map(html).join(', ')}` : '';
      return `<details id="${html(`scenario-${sc.suite}-${sc.id}`)}"><summary>${html(sc.title)} <span class="muted">${html(sc.suite)} › ${html(sc.id)}${tags} · ${passed}/${cases.length} passed</span></summary><div class="scroll"><table data-sortable><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div></details>`;
    })
    .join('\n');
}

/** The leaderboard as one HTML page that loads nothing. */
export function leaderboardHtml(results: MatrixResults, title = 'Model leaderboard'): string {
  const stop = stopLine(results);
  const picks = pickLines(results)
    .map((line) => `<li>${html(line)}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${html(title)}</h1>
<p>${html(runLine(results))}.</p>
<p class="muted">${html(spendLine(results))}. Pass rates are over the cases judged; costs are at each model's prices, the judge's apart; times are per turn, from the ${results.mode === 'replay' ? 'recorded' : 'live'} calls.</p>
${stop ? `<p class="banner">${html(stop)}</p>` : ''}
<h2>Leaderboard</h2>
${leaderboardTable(results)}
<h2>Picks</h2>
<p class="muted">The cheapest model per completed task among those within ${html(String(results.withinPoints))} points of the best pass rate.</p>
<ul>${picks}</ul>
<h2>By category</h2>
${categoriesTable(results)}
<h2>Models</h2>
${modelsTable(results)}
<h2>Scenarios</h2>
${scenarioSection(results)}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
