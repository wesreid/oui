import type { AgentRuntimeConfig } from './types.js';
import { resolveCommunicationStyle } from '../prompt/rules/communication.js';
import { resolveNarration } from '../prompt/rules/narration.js';
import { readTurnContextPlacement } from '../step-messages.js';
import { isRealtimeApiKey } from '../realtime/api-key.js';

/**
 * Every value the runtime cannot run without, and what it is for. A missing
 * one fails start-up — when the adapter is created, before any turn — with
 * this text. Nothing falls back to an environment variable or an empty
 * string: a fallback is how a worker once ran with no realtime URL and
 * streamed every turn to nobody.
 */
const REQUIRED: ReadonlyArray<[string, (c: Partial<AgentRuntimeConfig<unknown>>) => boolean, string]> = [
  ['model', (c) => !!c.model, 'an `ai` library model'],
  ['realtime.url', (c) => typeof c.realtime?.url === 'string' && /^https?:\/\//.test(c.realtime.url), 'the realtime server URL (http or https)'],
  ['realtime.apiKey', (c) => isRealtimeApiKey(c.realtime?.apiKey), "the realtime server's internal key: a string, or a getter that reads it"],
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
  // A malformed communication style fails here, before any turn, rather than
  // on the first turn's prompt: a channel that needs plain text is never sent
  // a turn the worker cannot write a prompt for.
  if (config.persona) resolveCommunicationStyle(config.persona.overrides?.communicationStyle);
  // So does a narration setting it does not know: a host that means to say how
  // much the agent narrates is never quietly held to one line.
  if (config.persona) resolveNarration(config.persona.overrides?.narration);
  // So does a turn context placement the worker does not know.
  readTurnContextPlacement(config.turnContextPlacement);
}
