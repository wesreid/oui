/**
 * A scenario's recording on one channel (ADR-0260 §3.5): the model's
 * responses in order, as they arrived, and what they were recorded against.
 *
 * The fingerprint is a hash of everything that shapes what the model is
 * asked: the system prompt, the tools' names, descriptions and schemas, the
 * channel's settings, the scenario's inputs and the rubrics its judge reads.
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
import { rubricsOf } from './suite.js';

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
}

/** A file-system-safe form of a suite's name. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'suite';

/** Where a scenario's recording on a channel lives. */
export function cassettePath(directory: string, suite: AgentEvalSuite, scenario: AgentEvalScenario, channel: string): string {
  return join(directory, slug(suite.name), `${scenario.id}.${channel}.json`);
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
}

export function fingerprint(inputs: FingerprintInputs): string {
  const { systemPrompt, tools, channel, suite, scenario } = inputs;
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
      })),
    channel,
    context: [suite.context ?? null, scenario.context ?? null],
    // A turn's inputs; its expectations change nothing the model is asked, except a rubric's text.
    turns: scenario.turns.map((turn) => ('user' in turn ? { user: turn.user } : 'approval' in turn ? { approval: turn.approval } : { staff: turn.staff })),
    rubrics: rubricsOf(scenario),
  };
  return createHash('sha256').update(canonicalJson(shaped)).digest('hex');
}
