/**
 * A model whose every answer a test states outright, through a provider's real
 * package: OpenAI Chat Completions streaming responses, built from a script
 * that reads the request the provider actually sent. Hand its `fetch` to
 * `createOpenAI({ fetch })`. A request the script has no answer for fails,
 * so an unexpected extra round is caught.
 */
import type { RecordedExchange } from './cassette.js';

/** What the scripted model says: text, before its tool calls when it makes both. */
export interface ScriptedReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** A Chat Completions request, as the provider sent it. */
export interface ChatRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string; description?: string } }>;
  /** Whether the provider asked for a stream (`streamText`) or one response (`generateText`). */
  stream?: boolean;
}

/** One Chat Completions streaming response, from its chunks. */
export function chatCompletionsStream(chunks: unknown[]): RecordedExchange {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
  return { path: '/v1/chat/completions', status: 200, contentType: 'text/event-stream', bodyBase64: Buffer.from(body).toString('base64') };
}

/** One Chat Completions stream chunk. */
export function chatCompletionsChunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 'chatcmpl-fx', object: 'chat.completion.chunk', created: 1790700000, model: 'gpt-fixture', choices, ...extra };
}

/** The streaming response that says `reply`. */
export function scriptedReplyExchange(reply: ScriptedReply): RecordedExchange {
  const chunks: unknown[] = [];
  if (reply.text) chunks.push(chatCompletionsChunk([{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }]));
  if (reply.toolCalls?.length) {
    chunks.push(
      chatCompletionsChunk([
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          },
          finish_reason: null,
        },
      ]),
    );
  }
  chunks.push(chatCompletionsChunk([{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' }]));
  chunks.push(chatCompletionsChunk([], { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }));
  return chatCompletionsStream(chunks);
}

/** The one-piece response that says `reply`, for a request that asked for no stream. */
export function scriptedCompletionExchange(reply: ScriptedReply): RecordedExchange {
  const toolCalls = reply.toolCalls?.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  const body = {
    id: 'chatcmpl-fx',
    object: 'chat.completion',
    created: 1790700000,
    model: 'gpt-fixture',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: reply.text ?? null, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
  };
  return { path: '/v1/chat/completions', status: 200, contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify(body)).toString('base64') };
}

/** A fetch answering each Chat Completions request as `script` says, keeping every request it was sent. */
export function scriptedChatCompletions(script: (request: ChatRequest, index: number) => ScriptedReply | undefined): {
  fetch: typeof fetch;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const scripted: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const index = requests.push(request) - 1;
    const reply = script(request, index);
    if (!reply) throw new Error(`scripted model: no reply for request ${index}`);
    const exchange = request.stream === true ? scriptedReplyExchange(reply) : scriptedCompletionExchange(reply);
    return new Response(Buffer.from(exchange.bodyBase64, 'base64'), { status: 200, headers: { 'content-type': exchange.contentType } });
  };
  return { fetch: scripted, requests };
}
