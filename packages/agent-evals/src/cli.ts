#!/usr/bin/env node
/**
 * agent-evals — runs a product's agent evals.
 *
 *   agent-evals [--config <file>] [--record | --live] [--channel <name>]… [--scenario <id>]…
 *               [--json <file>] [--junit <file>] [--verbose]
 *
 * A model matrix: every scenario × channel × model × run.
 *
 *   agent-evals --models <file | ids | all> [--runs <n>] [--max-cost <usd>] [--estimate]
 *               [--concurrency <n>] [--within <points>] [--html <file>] [--markdown <file>] …
 *
 * With no --config it looks for agent-evals.config.mjs, .js, then .ts in the
 * working directory; relative paths in it start at its directory. By default
 * it replays the recordings (CI: no credentials, no network); --record runs
 * the live model and writes them; --live runs it and writes nothing.
 *
 * --models names the candidates: a file of them (.json, .yaml, .mjs), `all`
 * of the configuration's `models`, or some of them by id, comma-separated.
 * --estimate prints what the matrix would cost and calls no model;
 * --max-cost refuses a run estimated over it, and stops one that spends it.
 *
 * Exits 0 when every case passed, 1 when any failed, 2 when it could not run,
 * and 3 when none failed but a rubric could not be judged (the judge gave no
 * verdict, however often it was asked). A matrix exits 0 when every case ran
 * (a model failing a scenario is a result, not an error), 1 when a case could
 * not run as written (a recording missing or stale, the wrong model built),
 * and 4 when the spend guard stopped it or its estimate is over the limit.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentEvalConfig, EvalMode } from './config.js';
import { estimateLines, leaderboardHtml, matrixMarkdown, matrixSummaryLines } from './leaderboard.js';
import { estimateRun, runMatrix, type MatrixResults } from './matrix.js';
import { selectModels } from './models.js';
import { caseLines, junitReport, summaryLine } from './report.js';
import { runEvals, type EvalCaseResult } from './run.js';

const USAGE = [
  'usage: agent-evals [--config <file>] [--record | --live] [--channel <name>]... [--scenario <id>]... [--json <file>] [--junit <file>] [--verbose]',
  '       agent-evals --models <file|ids|all> [--runs <n>] [--max-cost <usd>] [--estimate] [--concurrency <n>] [--within <points>]',
  '                   [--html <file>] [--markdown <file>] [--json <file>] [--junit <file>] [same options as above]',
].join('\n');

/** The exit code of a matrix the spend guard stopped, or whose estimate is over its limit. */
const EXIT_SPEND = 4;

interface Args {
  config?: string;
  mode: EvalMode;
  channels: string[];
  scenarios: string[];
  json?: string;
  junit?: string;
  verbose: boolean;
  models?: string;
  runs?: number;
  maxCost?: number;
  estimate: boolean;
  concurrency?: number;
  within?: number;
  html?: string;
  markdown?: string;
}

/** The flags only a matrix takes. */
const MATRIX_ONLY = ['--runs', '--max-cost', '--estimate', '--concurrency', '--within', '--html', '--markdown'] as const;

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { mode: 'replay', channels: [], scenarios: [], verbose: false, estimate: false };
  const given = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    given.add(flag);
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    const number = (test: (n: number) => boolean, what: string) => {
      const text = value();
      const n = Number(text);
      if (!Number.isFinite(n) || !test(n)) throw new Error(`${flag} takes ${what}, not ${text}`);
      return n;
    };
    try {
      switch (flag) {
        case '--config':
          args.config = value();
          break;
        case '--record':
        case '--live': {
          const mode = flag === '--record' ? 'record' : 'live';
          if (args.mode !== 'replay' && args.mode !== mode) return '--record and --live cannot be given together';
          args.mode = mode;
          break;
        }
        case '--channel':
          args.channels.push(value());
          break;
        case '--scenario':
          args.scenarios.push(value());
          break;
        case '--json':
          args.json = value();
          break;
        case '--junit':
          args.junit = value();
          break;
        case '--verbose':
          args.verbose = true;
          break;
        case '--models':
          args.models = value();
          break;
        case '--runs':
          args.runs = number((n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more');
          break;
        case '--max-cost':
          args.maxCost = number((n) => n > 0, 'a number of US dollars, more than 0');
          break;
        case '--estimate':
          args.estimate = true;
          break;
        case '--concurrency':
          args.concurrency = number((n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more');
          break;
        case '--within':
          args.within = number((n) => n >= 0, 'a number of percentage points, 0 or more');
          break;
        case '--html':
          args.html = value();
          break;
        case '--markdown':
          args.markdown = value();
          break;
        case '--help':
        case '-h':
          return '';
        default:
          return `unknown argument ${flag}`;
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (!args.models) {
    const matrixOnly = MATRIX_ONLY.filter((flag) => given.has(flag));
    if (matrixOnly.length > 0) return `${matrixOnly.join(', ')} ${matrixOnly.length === 1 ? 'is' : 'are'} for a model matrix: give the models with --models`;
  }
  return args;
}

function findConfig(given: string | undefined): string {
  if (given) {
    const path = resolve(given);
    if (!existsSync(path)) throw new Error(`there is no ${path}`);
    return path;
  }
  for (const name of ['agent-evals.config.mjs', 'agent-evals.config.js', 'agent-evals.config.ts']) {
    const path = resolve(name);
    if (existsSync(path)) return path;
  }
  throw new Error('no agent-evals.config.mjs, .js or .ts in this directory: give one with --config');
}

async function loadConfig(path: string): Promise<AgentEvalConfig> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (err) {
    const hint = path.endsWith('.ts')
      ? ' (a .ts configuration needs a Node that strips types, 22.18 or later, or a loader such as tsx: `npx tsx node_modules/.bin/agent-evals`)'
      : '';
    throw new Error(`${path} could not be loaded${hint}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const config = (loaded.default ?? loaded.config) as AgentEvalConfig | undefined;
  if (!config || typeof config !== 'object' || typeof config.agent !== 'function' || typeof config.model !== 'function') {
    throw new Error(`${path} must export (as default) a configuration from defineEvals({ suites, cassettes, channels, model, agent })`);
  }
  return config;
}

/** The worker logs each turn on the console; a run shows them only with --verbose. */
function quietConsole(): () => void {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const nothing = () => {};
  Object.assign(console, { log: nothing, info: nothing, warn: nothing, error: nothing, debug: nothing });
  return () => Object.assign(console, saved);
}

/** Whether a matrix case could not run as written: what a matrix exits 1 for. */
const couldNotRun = (results: MatrixResults) =>
  results.cases.some((c) => c.status !== 'stopped' && c.failures.some((f) => f.kind === 'case' && (f.assertion === 'recording' || f.assertion === 'model')));

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    if (parsed) process.stderr.write(`agent-evals: ${parsed}\n`);
    process.stderr.write(`${USAGE}\n`);
    return parsed ? 2 : 0;
  }
  const write = (text: string) => process.stdout.write(`${text}\n`);
  try {
    const file = findConfig(parsed.config);
    const config = await loadConfig(file);
    const root = dirname(file);
    const narrowed = {
      root,
      ...(parsed.channels.length ? { channels: parsed.channels } : {}),
      ...(parsed.scenarios.length ? { scenarios: parsed.scenarios } : {}),
    };

    if (parsed.models) {
      const models = await selectModels(parsed.models, config.models, config.judgeModel);
      const matrix = { ...narrowed, models, ...(parsed.runs !== undefined ? { runs: parsed.runs } : {}) };
      if (parsed.estimate) {
        const estimate = estimateRun(config, matrix);
        for (const line of estimateLines(estimate, parsed.maxCost)) write(line);
        return parsed.maxCost !== undefined && estimate.totalUsd > parsed.maxCost ? EXIT_SPEND : 0;
      }
      const restore = parsed.verbose ? () => {} : quietConsole();
      const cases: EvalCaseResult[] = [];
      let results: MatrixResults;
      try {
        results = await runMatrix(config, {
          ...matrix,
          mode: parsed.mode,
          ...(parsed.maxCost !== undefined ? { maxCostUsd: parsed.maxCost } : {}),
          ...(parsed.concurrency !== undefined ? { concurrency: parsed.concurrency } : {}),
          ...(parsed.within !== undefined ? { withinPoints: parsed.within } : {}),
          onCase: (result) => {
            cases.push(result);
            restore();
            for (const line of caseLines(result)) write(line);
            if (!parsed.verbose) quietConsole();
          },
        });
      } finally {
        restore();
      }
      if (results.spend.stopped?.reason === 'estimate' && results.spend.estimate) {
        for (const line of estimateLines(results.spend.estimate, parsed.maxCost)) write(line);
      }
      write('');
      for (const line of matrixSummaryLines(results)) write(line);
      if (parsed.json) writeFileSync(resolve(parsed.json), `${JSON.stringify(results, null, 2)}\n`);
      if (parsed.html) writeFileSync(resolve(parsed.html), leaderboardHtml(results));
      if (parsed.markdown) writeFileSync(resolve(parsed.markdown), matrixMarkdown(results));
      if (parsed.junit) {
        const count = (status: EvalCaseResult['status']) => cases.filter((c) => c.status === status).length;
        writeFileSync(resolve(parsed.junit), junitReport({ mode: parsed.mode, cases, passed: count('passed'), failed: count('failed'), unjudged: count('unjudged') }));
      }
      return results.spend.stopped ? EXIT_SPEND : couldNotRun(results) ? 1 : 0;
    }

    const restore = parsed.verbose ? () => {} : quietConsole();
    let report;
    try {
      report = await runEvals(config, {
        mode: parsed.mode,
        ...narrowed,
        onCase: (result) => {
          restore();
          for (const line of caseLines(result)) write(line);
          if (!parsed.verbose) quietConsole();
        },
      });
    } finally {
      restore();
    }
    write('');
    write(summaryLine(report));
    if (parsed.json) writeFileSync(resolve(parsed.json), `${JSON.stringify(report, null, 2)}\n`);
    if (parsed.junit) writeFileSync(resolve(parsed.junit), junitReport(report));
    return report.failed > 0 ? 1 : report.unjudged > 0 ? 3 : 0;
  } catch (err) {
    process.stderr.write(`agent-evals: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

process.exitCode = await main();
