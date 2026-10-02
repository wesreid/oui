/**
 * The fixture apps, run the way an integrator's CI runs them: `oui generate
 * --check` through the installed CLI, and `generate` for what it found.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generate, loadConfig, resolveConfig, type GenerateResult } from '@ouispec/cli';

export const MANTINE_APP = join(__dirname, '..', '..', 'mantine-app');
export const RADIX_APP = join(__dirname, '..', '..', 'radix-app');

/** The CLI as this package installs it (`oui`, the generator's bin). */
const CLI = join(__dirname, '..', '..', 'node_modules', '@ouispec', 'cli', 'dist', 'cli.js');

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `oui generate --check --config <app>/oui.config.json`, as CI runs it. */
export function generateCheck(app: string): CliRun {
  const run = spawnSync(process.execPath, [CLI, 'generate', '--check', '--config', join(app, 'oui.config.json')], {
    cwd: app,
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** What the generator finds in the app, from its own `oui.config.json`. */
export function generated(app: string): Promise<GenerateResult> {
  return generate(loadConfig(join(app, 'oui.config.json')));
}

/** The app's `oui.config.json` with some settings changed: another routes file, pages not yet bound. */
export function generatedWith(app: string, settings: Record<string, unknown>): Promise<GenerateResult> {
  const file = JSON.parse(readFileSync(join(app, 'oui.config.json'), 'utf8')) as Record<string, unknown>;
  return generate(resolveConfig(app, { ...file, ...settings }));
}

/** The mapping file an app's config names. */
export function mappingOf(app: string): unknown {
  const file = JSON.parse(readFileSync(join(app, 'oui.config.json'), 'utf8')) as { mappings: string[] };
  return JSON.parse(readFileSync(join(app, file.mappings[0]), 'utf8'));
}
