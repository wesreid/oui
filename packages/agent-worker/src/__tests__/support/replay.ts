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

export interface RecordedExchange {
  /** The request path the provider called. */
  path: string;
  status: number;
  contentType: string;
  bodyBase64: string;
}

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
export function replayFetch(exchanges: RecordedExchange[], requests: unknown[]): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const exchange = exchanges[next++];
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!exchange) throw new Error(`replay: no recorded response for request ${next} (${url.pathname})`);
    if (decodeURIComponent(url.pathname) !== exchange.path) {
      throw new Error(`replay: request ${next} went to ${url.pathname}, the recording to ${exchange.path}`);
    }
    requests.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    return new Response(Buffer.from(exchange.bodyBase64, 'base64'), {
      status: exchange.status,
      headers: { 'content-type': exchange.contentType },
    });
  };
}

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
export function sse(chunks: unknown[]): RecordedExchange {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
  return { path: '/v1/chat/completions', status: 200, contentType: 'text/event-stream', bodyBase64: Buffer.from(body).toString('base64') };
}

/** One Chat Completions stream chunk. */
export function chunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 'chatcmpl-fx', object: 'chat.completion.chunk', created: 1790700000, model: 'gpt-fixture', choices, ...extra };
}

/** A turn in OpenAI's format: one tool call, then a text reply. */
export interface OpenAIScript {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  reply: string;
}

/** The fixture turn: `navigate` to the reports page, then say so. */
export const NAVIGATE_SCRIPT: OpenAIScript = {
  toolCall: { id: 'call_nav_1', name: 'navigate', arguments: { path: '/reports' } },
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

export interface ScriptedReply {
  /** Text the model says; before its tool calls when it makes both. */
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** A Chat Completions request as the provider sent it. */
export interface ChatRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string; description?: string } }>;
}

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
  const requests: ChatRequest[] = [];
  const scriptedFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const index = requests.push(request) - 1;
    const reply = script(request, index);
    if (!reply) throw new Error(`scripted model: no reply for request ${index}`);
    const chunks: unknown[] = [];
    if (reply.text) chunks.push(chunk([{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }]));
    if (reply.toolCalls?.length) {
      chunks.push(
        chunk([
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: reply.toolCalls.map((c, i) => ({
                index: i,
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            finish_reason: null,
          },
        ]),
      );
    }
    chunks.push(chunk([{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' }]));
    chunks.push(chunk([], { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }));
    const exchange = sse(chunks);
    return new Response(Buffer.from(exchange.bodyBase64, 'base64'), { status: 200, headers: { 'content-type': exchange.contentType } });
  };
  const provider = createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scriptedFetch });
  return { model: provider.chat('gpt-fixture'), requests };
}
