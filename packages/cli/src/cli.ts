#!/usr/bin/env node
/**
 * oui (also installed as closure-oui) — the assistant's surfaces and knowledge,
 * generated from the UI's code (ADR-0220, ADR-0226).
 *
 *   oui generate            write <out>/oui-manifest.json and oui-knowledge.json
 *   oui generate --check    fail if they are stale, or if any declaration is invalid (CI)
 *
 * Options: --config <path> (default ./oui.config.json)
 */

import { basename, resolve } from 'node:path';

/** The name it was run as: `oui`, or `closure-oui`. */
const cliName = basename(process.argv[1] ?? 'oui').replace(/\.js$/, '') === 'closure-oui' ? 'closure-oui' : 'oui';

import { loadConfig } from './config.js';
import { generate, writeOrCheck } from './generate.js';

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'generate') {
    console.error(`usage: ${cliName} generate [--check] [--config oui.config.json]`);
    return 2;
  }
  const check = rest.includes('--check');
  const configFlag = rest.indexOf('--config');
  const configPath = resolve(configFlag === -1 ? 'oui.config.json' : rest[configFlag + 1]);
  const config = loadConfig(configPath);
  const result = await generate(config);

  for (const e of result.errors) console.error(`${e.file}${e.line ? `:${e.line}` : ''}: ${e.message}`);
  for (const w of result.warnings) console.error(`${w.file}${w.line ? `:${w.line}` : ''}: warning: ${w.message}`);
  const stale = writeOrCheck(result, config, check);
  const { pages, actions, rooms, unboundPages, boundModules } = result.stats;
  const summary =
    `${pages} pages, ${rooms} rooms, ${actions} actions; ${unboundPages} pages not yet bound; ` +
    `${boundModules ? `${boundModules} bound modules; ` : ''}build ${result.manifest.buildId}`;

  if (result.errors.length) {
    console.error(`\n${result.errors.length} problem(s) in the UI's declarations. ${summary}`);
    return 1;
  }
  if (check && stale.length) {
    console.error(`Stale: ${stale.join(', ')}. Run: npx ${cliName} generate\n${summary}`);
    return 1;
  }
  console.log(`${check ? 'Up to date' : 'Generated'}: ${summary}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // A setting or input the generator cannot use: its message names it; a stack would bury it.
  console.error((err as Error).message);
  process.exitCode = 1;
}
