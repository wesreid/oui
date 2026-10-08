#!/usr/bin/env node
/**
 * agent-evals — runs a product's agent evals (ADR-0260 §3.7).
 *
 *   agent-evals [--config <file>] [--record | --live] [--channel <name>]… [--scenario <id>]…
 *               [--json <file>] [--junit <file>] [--verbose]
 *
 * With no --config it looks for agent-evals.config.mjs, .js, then .ts in the
 * working directory; relative paths in it start at its directory. By default
 * it replays the recordings (CI: no credentials, no network); --record runs
 * the live model and writes them; --live runs it and writes nothing.
 *
 * Exits 0 when every case passed, 1 when any failed, 2 when it could not run.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentEvalConfig, EvalMode } from './config.js';
import { formatReport, junitReport } from './report.js';
import { failureLine, runEvals } from './run.js';

const USAGE =
  'usage: agent-evals [--config <file>] [--record | --live] [--channel <name>]... [--scenario <id>]... [--json <file>] [--junit <file>] [--verbose]';

interface Args {
  config?: string;
  mode: EvalMode;
  channels: string[];
  scenarios: string[];
  json?: string;
  junit?: string;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { mode: 'replay', channels: [], scenarios: [], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
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
    const restore = parsed.verbose ? () => {} : quietConsole();
    let report;
    try {
      report = await runEvals(config, {
        mode: parsed.mode,
        root: dirname(file),
        ...(parsed.channels.length ? { channels: parsed.channels } : {}),
        ...(parsed.scenarios.length ? { scenarios: parsed.scenarios } : {}),
        onCase: (result) => {
          restore();
          write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.suite} › ${result.scenario} [${result.channel}]  ${result.title}  (${result.durationMs} ms)`);
          for (const f of result.failures) write(`        ${failureLine(f)}`);
          if (!parsed.verbose) quietConsole();
        },
      });
    } finally {
      restore();
    }
    write('');
    write(formatReport(report).split('\n').at(-1)!);
    if (parsed.json) writeFileSync(resolve(parsed.json), `${JSON.stringify(report, null, 2)}\n`);
    if (parsed.junit) writeFileSync(resolve(parsed.junit), junitReport(report));
    return report.failed > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`agent-evals: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

process.exitCode = await main();
