import type { AgentRuntimeConfig } from './types.js';

/**
 * Every value the runtime cannot run without, and what it is for. A missing
 * one fails start-up — when the adapter is created, before any turn — with
 * this text. Nothing falls back to an environment variable or an empty
 * string: a fallback is how a worker once ran with no realtime URL and
 * streamed every turn to nobody (ADR-0227 §2.2).
 */
const REQUIRED: ReadonlyArray<[string, (c: Partial<AgentRuntimeConfig<unknown>>) => boolean, string]> = [
  ['model', (c) => !!c.model, 'an `ai` library model'],
  ['realtime.url', (c) => typeof c.realtime?.url === 'string' && /^https?:\/\//.test(c.realtime.url), 'the realtime server URL (http or https)'],
  ['realtime.apiKey', (c) => typeof c.realtime?.apiKey === 'string' && c.realtime.apiKey.length > 0, "the realtime server's internal key"],
  [
    'persona or systemPrompt',
    (c) => !!c.persona !== (typeof c.systemPrompt === 'function'),
    'exactly one: the assistant’s identity comes only from the host',
  ],
  ['tools', (c) => Array.isArray(c.tools) || typeof c.tools === 'function', 'a tool list or a per-turn resolver ([] for UI actions only)'],
  ['getDb', (c) => typeof c.getDb === 'function', 'returns the handle passed to the callbacks'],
  ['getHistory', (c) => typeof c.getHistory === 'function', "loads the conversation's earlier messages"],
  ['persistMessages', (c) => typeof c.persistMessages === 'function', "keeps the turn's new messages"],
];

/** Throws, naming every missing or malformed value, unless the configuration is complete. */
export function assertAgentRuntimeConfig<TDb>(config: Partial<AgentRuntimeConfig<TDb>>): asserts config is AgentRuntimeConfig<TDb> {
  const missing = REQUIRED.filter(([, ok]) => !ok((config ?? {}) as Partial<AgentRuntimeConfig<unknown>>)).map(
    ([name, , what]) => `${name} (${what})`,
  );
  if (missing.length > 0) {
    throw new Error(`[agent-sdk] Missing required configuration: ${missing.join('; ')}`);
  }
}
