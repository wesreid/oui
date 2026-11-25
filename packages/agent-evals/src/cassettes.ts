/**
 * A scenario's recording on one channel: the model's
 * responses in order, as they arrived, and what they were recorded against.
 *
 * The fingerprint is a hash of everything that shapes what the model is
 * asked: the system prompt, the tools' names, descriptions and schemas, the
 * channel's settings, the scenario's inputs, its page, the agent's provider
 * and UI settings, and the rubrics its judge reads; in a model matrix, the
 * candidate too (its id, its provider options and what it can be asked for)
 * and the judge's id.
 *
 * A matrix files each candidate's recordings apart, and each run of a
 * scenario apart from its first. A recording also keeps how long each of the
 * agent's model calls took, so a replay reports the live run's times.
 * A recording replayed against a changed configuration or scenario fails,
 * rather than passing on answers to a question no longer asked.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@ouispec/agent-core';
import type { AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import type { RecordedExchange } from '@ouispec/agent-worker/testing';
import type { RegisteredTool } from '@ouispec/agent-worker';
import type { EvalChannel } from './config.js';
import { slug, type EvalCandidate } from './models.js';
import { rubricsOf } from './suite.js';
import type { EvalCallTiming } from './usage.js';

export const CASSETTE_VERSION = 1;

export interface Cassette {
  version: typeof CASSETTE_VERSION;
  suite: string;
  scenario: string;
  channel: string;
  /** The model the responses came from, as the provider names it. */
  model: string;
  recordedAt: string;
  fingerprint: string;
  exchanges: RecordedExchange[];
  /** How long each of the agent's model calls took, in order (never the judge's): a replay reports these. */
  timings?: EvalCallTiming[];
}

/** Which of a matrix's recordings: the candidate's, and the run (1 for the first). */
export interface CassetteSlot {
  model?: string;
  run?: number;
}

/**
 * Where a scenario's recording on a channel lives: `<suite>/<scenario>.<channel>.json`;
 * in a matrix `<suite>/<model>/<scenario>.<channel>.json`, and from its second
 * run on `….run-<n>.json`.
 */
export function cassettePath(directory: string, suite: AgentEvalSuite, scenario: AgentEvalScenario, channel: string, slot: CassetteSlot = {}): string {
  const run = slot.run !== undefined && slot.run > 1 ? `.run-${slot.run}` : '';
  return join(directory, slug(suite.name), ...(slot.model !== undefined ? [slug(slot.model, 'model')] : []), `${scenario.id}.${channel}${run}.json`);
}

export function readCassette(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  const cassette = JSON.parse(readFileSync(path, 'utf8')) as Cassette;
  if (cassette.version !== CASSETTE_VERSION || !Array.isArray(cassette.exchanges)) {
    throw new Error(`${path} is not a recording this version of agent-evals reads (version ${String(cassette.version)})`);
  }
  return cassette;
}

export function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`);
}

/** What the fingerprint is taken over: what shapes the requests the model is sent. */
export interface FingerprintInputs {
  systemPrompt: string;
  tools: readonly RegisteredTool[];
  channel: { name: string; settings: EvalChannel };
  suite: AgentEvalSuite;
  scenario: AgentEvalScenario;
  /** The scenario's page, and the product's files it is built from: what the page's index and state the model reads come from. */
  page?: unknown;
  /** The agent's provider options, its forced-choice setting and its UI settings, when it has them. */
  modelProviderOptions?: unknown;
  forcedToolChoice?: boolean;
  /** Whether a choice waits for a reply: it can add a step to a turn. */
  requireReplyBeforeChoice?: boolean;
  uiActions?: unknown;
  /** In a model matrix: the candidate, as it shapes what is sent, and the judge's id. */
  candidate?: Pick<EvalCandidate, 'id' | 'providerOptions' | 'capabilities'>;
  judge?: string;
}

/**
 * The agent's UI settings as a fingerprint can hold them. A host's
 * `stateDigest` function shapes every stored answer, but a function has no
 * JSON form: it is held by the name the host gives what it writes
 * (`stateDigestId`), so changing that name makes recordings stale. A function
 * given no name is refused, rather than left out: a recording would otherwise
 * replay against a digest that changed. Settings with no function are held as
 * they are, so their fingerprints are what they were.
 */
export function fingerprintedUiActions(uiActions: unknown): unknown {
  if (!uiActions || typeof uiActions !== 'object') return uiActions;
  const { stateDigest, stateDigestId, ...rest } = uiActions as Record<string, unknown>;
  if (typeof stateDigest !== 'function') return uiActions;
  if (typeof stateDigestId !== 'string' || stateDigestId.trim() === '') {
    throw new Error(
      '[agent-evals] uiActions.stateDigest is a function, which a recording cannot be fingerprinted by: ' +
        'give uiActions.stateDigestId, a name for what it writes (change it whenever what it writes changes)',
    );
  }
  return { ...rest, stateDigest: { id: stateDigestId } };
}

export function fingerprint(inputs: FingerprintInputs): string {
  const { systemPrompt, tools, channel, suite, scenario, page, modelProviderOptions, forcedToolChoice, requireReplyBeforeChoice, uiActions, candidate, judge } = inputs;
  const shaped = {
    systemPrompt,
    tools: [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        effect: t.effect ?? null,
        destructive: t.destructive ?? false,
        title: t.title ?? null,
        consequence: t.consequence ?? null,
        // A trailer tool is taught in the prompt rather than declared: only when set, so other recordings stay current.
        ...(t.trailer ? { trailer: true } : {}),
      })),
    channel,
    context: [suite.context ?? null, scenario.context ?? null],
    // A turn's inputs; its expectations change nothing the model is asked, except a rubric's text.
    turns: scenario.turns.map((turn) => ('user' in turn ? { user: turn.user } : 'approval' in turn ? { approval: turn.approval } : { staff: turn.staff })),
    rubrics: rubricsOf(scenario),
    // Only when given, so a recording made before they could be is still current.
    ...(page !== undefined ? { page } : {}),
    ...(modelProviderOptions !== undefined ? { modelProviderOptions } : {}),
    ...(forcedToolChoice !== undefined ? { forcedToolChoice } : {}),
    ...(requireReplyBeforeChoice ? { requireReplyBeforeChoice } : {}),
    ...(uiActions !== undefined ? { uiActions: fingerprintedUiActions(uiActions) } : {}),
    ...(candidate ? { candidate: { id: candidate.id, providerOptions: candidate.providerOptions ?? null, capabilities: candidate.capabilities } } : {}),
    ...(judge !== undefined ? { judge } : {}),
  };
  return createHash('sha256').update(canonicalJson(shaped)).digest('hex');
}
