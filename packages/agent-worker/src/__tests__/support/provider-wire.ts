/**
 * Models scripted on Bedrock's, Anthropic's and OpenAI's own wire formats, through their
 * real `ai` provider packages: the provider builds its real request (kept, as
 * the body it sent) and parses the response as it would a live one. A
 * response says text, in the deltas given, then the tool calls given.
 */
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { chatCompletionsChunk } from '../../testing/scripted.js';
import type { ScriptedProvider } from './note-turn.js';

/** What a scripted response says: its text, in these pieces, then these calls. */
export interface WireReply {
  text?: string[];
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

// ─── Bedrock ConverseStream: the AWS event stream encoding ─────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One event of an AWS event stream: its string headers, its JSON payload, and both checksums. */
function eventMessage(eventType: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({ ':event-type': eventType, ':content-type': 'application/json', ':message-type': 'event' }).map(([name, value]) => {
      const n = Buffer.from(name);
      const v = Buffer.from(value);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(v.length);
      return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), length, v]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude));
  const head = Buffer.concat([prelude, preludeCrc, headers, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(head));
  return Buffer.concat([head, messageCrc]);
}

/** A ConverseStream response that says `reply`. */
export function bedrockStream(reply: WireReply): Buffer {
  const events: Buffer[] = [eventMessage('messageStart', { role: 'assistant' })];
  let index = 0;
  if (reply.text?.length) {
    for (const piece of reply.text) events.push(eventMessage('contentBlockDelta', { contentBlockIndex: index, delta: { text: piece } }));
    events.push(eventMessage('contentBlockStop', { contentBlockIndex: index }));
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    events.push(eventMessage('contentBlockStart', { contentBlockIndex: index, start: { toolUse: { toolUseId: call.id, name: call.name } } }));
    events.push(eventMessage('contentBlockDelta', { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(call.args) } } }));
    events.push(eventMessage('contentBlockStop', { contentBlockIndex: index }));
    index++;
  }
  events.push(eventMessage('messageStop', { stopReason: reply.toolCalls?.length ? 'tool_use' : 'end_turn' }));
  events.push(eventMessage('metadata', { usage: { inputTokens: 500, outputTokens: 20, totalTokens: 520 }, metrics: { latencyMs: 100 } }));
  return Buffer.concat(events);
}

/** A Bedrock model answering each request with the next reply, keeping every request body it sent. */
export function scriptedBedrock(replies: WireReply[]): ScriptedProvider {
  const requests: unknown[] = [];
  const provider = createAmazonBedrock({
    region: 'us-east-1',
    // Signed with throwaway keys; nothing leaves the process.
    credentialProvider: async () => ({ accessKeyId: 'AKIDFIXTURESCRIPT', secretAccessKey: 'fixture-script-secret' }),
    fetch: async (_input, init) => {
      const index = requests.push(JSON.parse(String(init?.body))) - 1;
      const reply = replies[index];
      if (!reply) throw new Error(`scripted Bedrock: no reply for request ${index}`);
      return new Response(bedrockStream(reply), { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
    },
  });
  return { model: provider('us.anthropic.claude-fixture-v1:0'), requests };
}

// ─── Anthropic Messages streaming ──────────────────────────────────────────

/** An Anthropic Messages stream that says `reply`. */
export function anthropicStream(reply: WireReply): string {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } } }],
  ];
  let index = 0;
  if (reply.text?.length) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
    for (const piece of reply.text) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index++;
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: reply.toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** An Anthropic model answering each request with the next reply, keeping every request body it sent. */
export function scriptedAnthropic(replies: WireReply[]): ScriptedProvider {
  const requests: unknown[] = [];
  const provider = createAnthropic({
    apiKey: 'fixture-anthropic-key',
    fetch: async (_input, init) => {
      const index = requests.push(JSON.parse(String(init?.body))) - 1;
      const reply = replies[index];
      if (!reply) throw new Error(`scripted Anthropic: no reply for request ${index}`);
      return new Response(anthropicStream(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { model: provider('claude-fixture'), requests };
}

// ─── OpenAI Chat Completions streaming ─────────────────────────────────────

/** An OpenAI model answering each request with the next reply, its text in the pieces given, keeping every request body it sent. */
export function scriptedOpenAIWire(replies: WireReply[], options: { hold?: (index: number, signal: AbortSignal) => Promise<void> } = {}): ScriptedProvider {
  const requests: unknown[] = [];
  const provider = createOpenAI({
    apiKey: 'fixture-scripted-key',
    fetch: async (_input, init) => {
      const index = requests.push(JSON.parse(String(init?.body))) - 1;
      const reply = replies[index];
      if (!reply) throw new Error(`scripted OpenAI: no reply for request ${index}`);
      const chunks = [
        ...(reply.text ?? []).map((piece) => chatCompletionsChunk([{ index: 0, delta: { content: piece }, finish_reason: null }])),
        ...(reply.toolCalls?.length
          ? [
              chatCompletionsChunk([
                {
                  index: 0,
                  delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
                  finish_reason: null,
                },
              ]),
            ]
          : []),
        chatCompletionsChunk([{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' }]),
        chatCompletionsChunk([], { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }),
      ];
      const signal = init?.signal ?? new AbortController().signal;
      // Each chunk is its own read: a hold can stop the response part way, as a live one is stopped.
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for (const [at, chunk] of chunks.entries()) {
              if (at === 1 && options.hold) await options.hold(index, signal);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { model: provider.chat('gpt-fixture'), requests };
}
