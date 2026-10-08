/**
 * Recorded model responses, replayed through each provider's real `ai`
 * package: the provider builds its real request and parses the recorded wire
 * format, so the worker core is tested against the provider, not a stand-in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAI } from '@ai-sdk/openai';
import { PROMPT_CACHE_BREAKPOINTS, type LanguageModel, type ProviderOptions } from '../../model.js';
import { replayingFetch, type RecordedExchange } from '../../testing/cassette.js';
import {
  chatCompletionsChunk,
  chatCompletionsStream,
  scriptedChatCompletions,
  type ChatRequest,
  type ScriptedReply,
} from '../../testing/scripted.js';

export type { RecordedExchange } from '../../testing/cassette.js';

export interface FixtureRecording {
  provider: string;
  modelId: string;
  recordedAt: string;
  /** What the recorded turn did: the id of its navigate call, and its closing words. */
  expected: { toolCallId: string; reply: string };
  exchanges: RecordedExchange[];
}

export interface ReplayedProvider {
  name: string;
  model: LanguageModel;
  promptCacheBreakpoint?: ProviderOptions;
  expected: FixtureRecording['expected'];
  /** The request bodies the provider sent, in order. */
  requests: unknown[];
}

/** A fetch that answers each request with the next recorded response, and refuses one more. */
export const replayFetch = (exchanges: RecordedExchange[], requests: unknown[]): typeof fetch => replayingFetch(exchanges, requests);

/** Bedrock ConverseStream responses, recorded from a live model (evals/fixture-turn.record.ts). */
export function bedrockReplay(): ReplayedProvider {
  const recording = JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/fixture-turn.bedrock.json', import.meta.url)), 'utf8'),
  ) as FixtureRecording;
  const requests: unknown[] = [];
  const provider = createAmazonBedrock({
    region: 'us-east-1',
    // Replay signs with throwaway keys; nothing leaves the process.
    credentialProvider: async () => ({ accessKeyId: 'AKIDFIXTUREREPLAY', secretAccessKey: 'fixture-replay-secret' }),
    fetch: replayFetch(recording.exchanges, requests),
  });
  return {
    name: 'amazon-bedrock',
    model: provider(recording.modelId),
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
    expected: recording.expected,
    requests,
  };
}

// ─── OpenAI Chat Completions ────────────────────────────────────────────────

/** One Chat Completions streaming response, from its chunks. */
export const sse = chatCompletionsStream;

/** One Chat Completions stream chunk. */
export const chunk = chatCompletionsChunk;

/** A turn in OpenAI's format: one tool call, then a text reply. */
export interface OpenAIScript {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  reply: string;
}

/** The fixture turn: run the page's `navigate` action to the reports page, then say so. */
export const NAVIGATE_SCRIPT: OpenAIScript = {
  toolCall: { id: 'call_nav_1', name: 'ui_act', arguments: { action: 'navigate', input: { path: '/reports' } } },
  reply: 'Your reports are open.',
};

/**
 * The script in OpenAI's Chat Completions streaming format: the tool call
 * whose arguments arrive in pieces, then the text reply.
 */
function openaiExchanges({ toolCall, reply }: OpenAIScript): RecordedExchange[] {
  const args = JSON.stringify(toolCall.arguments);
  const cut = Math.ceil(args.length / 2);
  return [
    sse([
      chunk([
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: '' } }],
          },
          finish_reason: null,
        },
      ]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, cut) } }] }, finish_reason: null }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
      chunk([], { usage: { prompt_tokens: 640, completion_tokens: 18, total_tokens: 658 } }),
    ]),
    sse([
      chunk([{ index: 0, delta: { role: 'assistant', content: reply.slice(0, 10) }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: reply.slice(10) }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      chunk([], { usage: { prompt_tokens: 702, completion_tokens: 7, total_tokens: 709 } }),
    ]),
  ];
}

/** A one-tool turn on a real OpenAI provider. Default: the fixture turn. */
export function openaiReplay(script: OpenAIScript = NAVIGATE_SCRIPT): ReplayedProvider {
  return scriptedOpenAI(openaiExchanges(script), { toolCallId: script.toolCall.id, reply: script.reply });
}

/**
 * A real OpenAI provider whose responses are the given exchanges, in order: for a
 * turn scripted in Chat Completions streaming format.
 */
export function scriptedOpenAI(exchanges: RecordedExchange[], expected: FixtureRecording['expected']): ReplayedProvider {
  const requests: unknown[] = [];
  const provider = createOpenAI({ apiKey: 'fixture-replay-key', fetch: replayFetch(exchanges, requests) });
  return { name: 'openai', model: provider.chat('gpt-fixture'), expected, requests };
}

// ─── A scripted model ───────────────────────────────────────────────────────

export type { ScriptedReply, ChatRequest } from '../../testing/scripted.js';

/**
 * OpenAI Chat Completions through the real `@ai-sdk/openai` package, each
 * response decided by `script` from the request the provider actually sent: a
 * model whose behaviour a multi-turn test states outright. A request past the
 * script's end fails the turn, so an unexpected extra round is caught.
 */
export function respondingOpenAI(script: (request: ChatRequest, index: number) => ScriptedReply | undefined): {
  model: LanguageModel;
  requests: ChatRequest[];
} {
  const scripted = scriptedChatCompletions(script);
  const provider = createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scripted.fetch });
  return { model: provider.chat('gpt-fixture'), requests: scripted.requests };
}
