/**
 * The generator's configuration: where an app keeps its routes, navigation
 * and output, which design systems its controls come from, where its API is
 * described, and which of its pages are not yet bound (ADR-0220 §2.8,
 * ADR-0226 §2.4).
 *
 * Read from `oui.config.json` at the app's root; paths are relative to it.
 * The file is required and explicit: nothing an app depends on has a default,
 * so a misconfigured app fails here, naming the setting, instead of
 * generating an assistant that can do nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ControlTableFile, RoomCatalogData } from '@ouispec/bindings';
import { CONTRACT_SCHEMAS, type AppCatalogEntry, type OuiConfigFile, type ShellEntry } from '@ouispec/contract';
import { contractProblems } from '@ouispec/contract/validate';

// `oui.config.json` as written is the contract's (`oui-config.json`), generated from its schema.
export type { AppCatalogEntry, OuiConfigFile, ShellEntry };

/** Tables and catalogs given directly rather than read from packages: tests, and tools that already hold them. */
export interface ConfigInjection {
  controlTables?: Readonly<Record<string, ControlTableFile>>;
  catalogs?: readonly { package: string; hosts: readonly string[]; catalog: RoomCatalogData }[];
}

/** The resolved configuration: every path absolute, every list present. */
export interface GeneratorConfig extends ConfigInjection {
  /** The app's root: where `oui.config.json` is. */
  root: string;
  tsconfig: string;
  routes: string;
  routeWrappers: readonly string[];
  nav: readonly string[];
  out: string;
  designSystem: readonly string[];
  /** As written: a module path or a path relative to the root; resolved when the spec is read. */
  apiSpec: string | null;
  unbound: readonly string[];
  appCatalogs: readonly AppCatalogEntry[];
  shell: readonly ShellEntry[];
}

export const CONFIG_FILE = 'oui.config.json';

/** The schema the file is checked against: what is required, what is a setting, and what each is. */
const SCHEMA = CONTRACT_SCHEMAS['oui-config.json'] as unknown as {
  required: readonly string[];
  properties: Readonly<Record<string, { description?: string }>>;
};

/** What a setting is, for the message that says it is missing: its description's first sentence. */
const what = (key: string) => {
  const sentence = (SCHEMA.properties[key]?.description ?? '').split(/(?<=[.:])\s/)[0].replace(/[.:]$/, '');
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
};

/** Settings an older generator read, and what replaced each. */
const REPLACED: Readonly<Record<string, string>> = {
  apiClient:
    '"apiClient" is replaced by "apiSpec": the module path of the API’s OpenAPI document ' +
    '(e.g. "@closurestudio/api-client/openapi.json"), or null for none',
};

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(`${file} is not valid:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(file: string): GeneratorConfig {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(`No ${CONFIG_FILE} at ${path}: the generator reads every setting from it (ADR-0226 §2.4)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not JSON: ${(err as Error).message}`, { cause: err });
  }
  return resolveConfig(dirname(path), raw);
}

/**
 * Validate the file's settings and resolve their paths against `root`.
 * Throws a `ConfigError` listing every problem.
 */
export function resolveConfig(root: string, raw: unknown, inject: ConfigInjection = {}): GeneratorConfig {
  if (!isRecord(raw)) throw new ConfigError(CONFIG_FILE, ['it must be a JSON object of settings']);
  const problems: string[] = [];

  for (const key of SCHEMA.required) {
    if (!(key in raw)) problems.push(`"${key}" is required: ${what(key)}`);
  }
  for (const key of Object.keys(raw)) {
    if (key in SCHEMA.properties) continue;
    problems.push(REPLACED[key] ?? `"${key}" is not a setting`);
  }

  const path = (key: string) => {
    if (key in raw && (typeof raw[key] !== 'string' || !(raw[key] as string).trim()))
      problems.push(`"${key}" must be a path`);
  };
  const strings = (key: string, what: string) => {
    if (key in raw && !(Array.isArray(raw[key]) && raw[key].every(v => typeof v === 'string' && v.trim())))
      problems.push(`"${key}" must be a list of ${what}`);
  };
  path('tsconfig');
  path('routes');
  path('out');
  strings('designSystem', 'package names');
  strings('routeWrappers', 'component names');
  strings('nav', 'paths');
  strings('unbound', 'component names');
  if ('apiSpec' in raw && raw.apiSpec !== null && (typeof raw.apiSpec !== 'string' || !raw.apiSpec.trim()))
    problems.push('"apiSpec" must be the module path of an OpenAPI document, or null');
  entries(raw, 'shell', ['module', 'export'], problems);
  entries(raw, 'appCatalogs', ['module', 'export'], problems);

  // The schema is the authority: whatever the checks above put in words, a
  // file it refuses is refused.
  if (!problems.length) problems.push(...contractProblems('oui-config.json', raw).map(p => `the contract's oui-config.json: ${p}`));
  if (problems.length) throw new ConfigError(CONFIG_FILE, problems);
  const file = raw as unknown as OuiConfigFile;
  return {
    ...inject,
    root,
    tsconfig: resolve(root, file.tsconfig),
    routes: resolve(root, file.routes),
    routeWrappers: [...(file.routeWrappers ?? [])],
    nav: (file.nav ?? []).map(n => resolve(root, n)),
    out: resolve(root, file.out),
    designSystem: [...file.designSystem],
    apiSpec: file.apiSpec,
    unbound: [...(file.unbound ?? [])].sort(),
    appCatalogs: [...(file.appCatalogs ?? [])],
    shell: (file.shell ?? []).map(s => ({ ...s, module: resolve(root, s.module) })),
  };
}

/** A list of objects each with string settings `required`. */
function entries(raw: Record<string, unknown>, key: string, required: readonly string[], problems: string[]): void {
  if (!(key in raw)) return;
  const value = raw[key];
  const ok =
    Array.isArray(value) &&
    value.every(v => isRecord(v) && required.every(k => typeof v[k] === 'string' && (v[k] as string).trim()));
  if (!ok) problems.push(`"${key}" must be a list of { ${required.map(k => `"${k}"`).join(', ')}, … } entries`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
