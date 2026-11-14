/**
 * The models a matrix runs: each candidate's id, label, provider options,
 * capabilities and prices, as the product's own model registry declares them;
 * and the judge of rubrics, which is fixed for a run and is never a candidate.
 *
 * Nothing here names a model. A product hands its candidates to the
 * configuration (`models`), or in a file (`agent-evals --models <file>`), and
 * its model factory builds whichever one it is handed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ProviderOptions } from '@ouispec/agent-worker';
import type { EvalModelCall } from './usage.js';

/** What a model costs, in US dollars per million tokens. */
export interface EvalModelPrices {
  /** Input not read from or written to the prompt cache. */
  input: number;
  output: number;
  /** Input read from the prompt cache. */
  cacheRead: number;
  /** Input written to the prompt cache. */
  cacheWrite: number;
}

/** What a model can be asked for: the matrix sends each turn only what the model takes. */
export interface EvalModelCapabilities {
  /** It reads a prompt cache: the run sends the configuration's cache breakpoint. Without it, none is sent. */
  promptCache: boolean;
  /** It takes a forced tool choice: without it, the agent's `forcedToolChoice` is off. */
  forcedToolChoice: boolean;
  /** It takes a temperature: without it, none is sent (`temperature: null`). */
  temperature: boolean;
  /** It reads images. Reported with its results; a scenario that sends one runs either way. */
  vision: boolean;
  /** Its context window, in tokens. Reported with its results, beside the largest call's input. */
  contextWindow?: number;
}

/** One model of a matrix: what the product's registry declares for it. */
export interface EvalCandidate {
  /** The provider's id for it, which the configuration's model factory builds. Unique in the matrix. */
  id: string;
  /** Its name in reports. */
  label: string;
  /** What every one of its turns sends the provider, in place of the agent's own `modelProviderOptions`. */
  providerOptions?: ProviderOptions;
  capabilities: EvalModelCapabilities;
  prices: EvalModelPrices;
}

/** The judge of rubrics: one model for the whole run, never one of its candidates. */
export interface EvalJudgeModel {
  /** The provider's id for it, which the judge's factory (or the model factory, with `purpose: 'judge'`) builds. */
  id: string;
  /** Its name in reports. Default: its id. */
  label?: string;
  /** What every verdict's request sends the provider. */
  providerOptions?: ProviderOptions;
  /** What its verdicts cost: counted toward the run's spend, never toward a candidate's. Required for a matrix whose suites have rubrics. */
  prices?: EvalModelPrices;
}

/** A list of models that cannot be run, with every reason. */
export class EvalModelsError extends Error {
  constructor(
    readonly source: string,
    readonly problems: readonly string[],
  ) {
    super(`${source} is not a list of models agent-evals can run:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EvalModelsError';
  }
}

/** A file-system-safe form of a name: what a suite's and a model's recordings are filed under. */
export const slug = (name: string, fallback = 'suite'): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const CAPABILITY_FLAGS = ['promptCache', 'forcedToolChoice', 'temperature', 'vision'] as const;

/** Every problem with a model's prices, each with where it is. */
export function pricesProblems(value: unknown, at: string): string[] {
  if (!isObject(value)) return [`${at}: give its prices per million tokens ({ ${PRICE_KEYS.join(', ')} })`];
  const problems: string[] = [];
  for (const key of PRICE_KEYS) {
    const price = value[key];
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) problems.push(`${at}.${key}: a price is a number of dollars per million tokens, 0 or more`);
  }
  for (const key of Object.keys(value)) if (!(PRICE_KEYS as readonly string[]).includes(key)) problems.push(`${at}.${key}: not a price (${PRICE_KEYS.join(', ')})`);
  return problems;
}

/**
 * The candidates, checked: each one's id, label, capabilities and prices; no
 * two with one id, or with ids filed under one name; and none that is the
 * judge.
 */
export function checkCandidates(value: unknown, source: string, judge?: EvalJudgeModel): EvalCandidate[] {
  if (!Array.isArray(value) || value.length === 0) throw new EvalModelsError(source, ['it must be a list of one model or more']);
  const problems: string[] = [];
  const ids = new Map<string, string>();
  value.forEach((entry, i) => {
    const at = `[${i}]`;
    if (!isObject(entry)) {
      problems.push(`${at}: a model is an object ({ id, label, capabilities, prices })`);
      return;
    }
    const id = entry.id;
    if (typeof id !== 'string' || !id.trim()) problems.push(`${at}.id: give the provider's id for the model`);
    else {
      const filed = slug(id, '');
      if (!filed) problems.push(`${at}.id: "${id}" has no letter or digit to file its recordings under`);
      const twin = ids.get(filed);
      if (twin !== undefined) problems.push(`${at}.id: "${id}" ${twin === id ? 'is listed twice' : `and "${twin}" are filed under one name (${filed})`}`);
      ids.set(filed, id);
      if (judge && id === judge.id) problems.push(`${at}.id: "${id}" is the judge, and the judge is never a candidate`);
    }
    if (typeof entry.label !== 'string' || !entry.label.trim()) problems.push(`${at}.label: give the model's name in reports`);
    if (entry.providerOptions !== undefined && !isObject(entry.providerOptions)) problems.push(`${at}.providerOptions: an object by provider, as the provider takes it`);
    const capabilities = entry.capabilities;
    if (!isObject(capabilities)) problems.push(`${at}.capabilities: give what it can be asked for ({ ${CAPABILITY_FLAGS.join(', ')}, contextWindow })`);
    else {
      for (const flag of CAPABILITY_FLAGS) if (typeof capabilities[flag] !== 'boolean') problems.push(`${at}.capabilities.${flag}: true or false`);
      const window = capabilities.contextWindow;
      if (window !== undefined && (typeof window !== 'number' || !Number.isInteger(window) || window <= 0)) problems.push(`${at}.capabilities.contextWindow: a number of tokens`);
    }
    problems.push(...pricesProblems(entry.prices, `${at}.prices`));
  });
  if (problems.length > 0) throw new EvalModelsError(source, problems);
  return value as EvalCandidate[];
}

/** The judge, checked: an id, and prices when given. */
export function checkJudge(judge: EvalJudgeModel, source: string): EvalJudgeModel {
  const problems: string[] = [];
  if (typeof judge.id !== 'string' || !judge.id.trim()) problems.push('judgeModel.id: give the provider\'s id for the judge');
  if (judge.prices !== undefined) problems.push(...pricesProblems(judge.prices, 'judgeModel.prices'));
  if (problems.length > 0) throw new EvalModelsError(source, problems);
  return judge;
}

/** Read a file of candidates: `.json`, `.yaml`/`.yml`, or a module (`.mjs`, `.js`) whose default export is the list. */
export async function readModelsFile(path: string): Promise<unknown> {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(readFileSync(path, 'utf8'));
  if (ext === '.yaml' || ext === '.yml') return parseYaml(readFileSync(path, 'utf8'));
  if (ext === '.mjs' || ext === '.js') {
    const loaded = (await import(pathToFileURL(path).href)) as { default?: unknown; models?: unknown };
    return loaded.default ?? loaded.models;
  }
  throw new EvalModelsError(path, [`a list of models is a .json, .yaml, .yml, .mjs or .js file, not ${ext || 'a file with no extension'}`]);
}

/**
 * The candidates `--models` names: a file of them; `all`, the configuration's
 * every one; or ids, comma-separated, of the configuration's.
 */
export async function selectModels(spec: string, configured: readonly EvalCandidate[] | undefined, judge?: EvalJudgeModel): Promise<EvalCandidate[]> {
  const path = resolve(spec);
  if (existsSync(path)) return checkCandidates(await readModelsFile(path), path, judge);
  if (!configured || configured.length === 0) {
    throw new EvalModelsError('--models', [`there is no file ${path}, and the configuration lists no models (\`models\`) to choose "${spec}" from`]);
  }
  const all = checkCandidates(configured, 'the configuration\'s models', judge);
  if (spec === 'all') return all;
  const ids = spec
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !all.some((m) => m.id === id));
  if (ids.length === 0 || unknown.length > 0) {
    throw new EvalModelsError('--models', [
      `${unknown.length ? `no model ${unknown.map((id) => `"${id}"`).join(', ')}` : 'no model named'} in the configuration (${all.map((m) => m.id).join(', ')})`,
    ]);
  }
  if (new Set(ids).size !== ids.length) throw new EvalModelsError('--models', ['a model is named twice']);
  return ids.map((id) => all.find((m) => m.id === id)!);
}

/** One million. */
const PER = 1_000_000;

/** What one model call cost at `prices`, in US dollars: its uncached input, cache reads, cache writes and output, each at its price. */
export function callCost(call: Pick<EvalModelCall, 'noCacheTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'>, prices: EvalModelPrices): number {
  return (
    (call.noCacheTokens * prices.input + call.cacheReadTokens * prices.cacheRead + call.cacheWriteTokens * prices.cacheWrite + call.outputTokens * prices.output) / PER
  );
}

/** What calls cost together; 0 with no prices. */
export function callsCost(calls: readonly EvalModelCall[], prices: EvalModelPrices | undefined): number {
  if (!prices) return 0;
  return calls.reduce((sum, call) => sum + callCost(call, prices), 0);
}
