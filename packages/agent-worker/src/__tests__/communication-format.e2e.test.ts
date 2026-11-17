/**
 * A persona's reply format, through a whole turn: the runtime a host creates
 * (`createAgentTurnRunner` with a persona), the real orchestrator and `ai`
 * loop, and a model scripted through the real `@ai-sdk/openai` package, on a
 * text channel and on a live call. The artifact checked is the request the
 * provider sends the model: its system prompt, its tools' descriptions and
 * its messages.
 *
 * A live call's turn is told after the conversation that its reply will be
 * spoken (prompt/spoken-reply.ts). In plain text the two agree: neither asks
 * for markdown, and the system prompt is the same on the call as in the chat,
 * so the call reads the chat's cached prefix.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { createAgentTurnRunner } from '../runtime/turn-runner.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import { createLiveCallTurnHandler } from '../live-call/handler.js';
import { spokenReplyText } from '../prompt/spoken-reply.js';
import { scriptedChatCompletions, type ChatRequest } from '../testing/scripted.js';
import type { AgentPersonaConfig } from '../prompt/types.js';
import type { CommunicationStyleSetting } from '../prompt/rules/communication.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../runtime/types.js';
import { markdownRequests, MARKDOWN_ONLY_LINES, PLAIN_LINES } from './support/communication-format.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const REPLY = 'We have two blue RAV4s under thirty thousand dollars, a 2024 and a 2025. Would you like to see either one?';
const SAID = 'Do you have any blue RAV4s under thirty thousand?';
const CREDENTIAL = 'communication-format-call-credential';

// ─── The realtime server: records what the turn sends its room ───────────────

const room: Array<{ event: string; data: Record<string, unknown> }> = [];
let realtime: http.Server;
let realtimeUrl: string;
beforeAll(async () => {
  realtime = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/emit') room.push(JSON.parse(body) as { event: string; data: Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => realtime.listen(0, '127.0.0.1', resolve));
  realtimeUrl = `http://127.0.0.1:${(realtime.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => realtime.close(() => resolve()));
});

// ─── The product ─────────────────────────────────────────────────────────────

const persona = (communicationStyle?: CommunicationStyleSetting): AgentPersonaConfig => ({
  name: 'Deos',
  identity: 'You are Deos, the assistant at a car dealership.',
  instructions: ['Quote only the dealer price.'],
  fewShotExamples: [{ user: 'Is the red one still there?', assistant: 'It is. Want me to hold it for you?', toolCalls: ['inventory_search'] }],
  overrides: { disableUIControlRules: true, ...(communicationStyle ? { communicationStyle } : {}) },
});

/** A runtime as a host creates it, whose model answers every request with REPLY; the requests it sent, in order. */
function product(communicationStyle?: CommunicationStyleSetting) {
  const scripted = scriptedChatCompletions(() => ({ text: REPLY }));
  const config: AgentRuntimeConfig<object> = {
    model: createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scripted.fetch }).chat('gpt-fixture'),
    realtime: { url: realtimeUrl, apiKey: 'realtime-key' },
    persona: persona(communicationStyle),
    // The SDK's own interaction tools (choices, confirmations, decisions), so their descriptions are read too.
    tools: loadBuiltinTools(),
    getDb: async () => ({}),
    getHistory: async () => [{ role: 'user', content: SAID }],
    persistMessages: async () => {},
    logger: quiet,
    approvals: { store: { create: async () => {}, redeem: async () => ({ ok: false, reason: 'used', error: 'used' }), status: async () => null } },
    stops: { client: { watch: (_t, _u, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })) } },
    uiActions: { channel: { request: async () => ({ success: false, error: 'not used' }) } as never },
  };
  return { runner: createAgentTurnRunner(config), requests: scripted.requests };
}

const TURN: AgentTurnPayload = {
  turnId: 'turn-sms-1',
  conversationId: 'conv-1',
  userId: 'visitor-1',
  accountId: 'rooftop-1',
  socketRoom: 'conversation:conv-1',
  content: SAID,
  context: {
    currentPath: '/inventory',
    timeZone: 'America/Chicago',
    // The page's surfaces, so the turn's UI tools and the page's index are read too.
    oui: {
      surfaces: [
        {
          id: 'app-shell',
          name: 'App Shell',
          description: 'The frame around every page',
          actions: [{ id: 'navigate', description: 'Go to a page', input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
        },
      ],
      observations: {},
    },
  },
};

// ─── What the model was sent ─────────────────────────────────────────────────

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? '').join('\n') : '';
const systemOf = (request: ChatRequest) => request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');
/** Everything in a request the model reads: its messages and every tool's description. */
const everything = (request: ChatRequest) =>
  [...request.messages.map((m) => textOf(m.content)), ...(request.tools ?? []).map((t) => t.function.description ?? '')].join('\n');

describe('the format, through a turn on a text channel', () => {
  it('plain text reaches the model: the plain rules in its system prompt, and no request for markdown anywhere it reads', async () => {
    const { runner, requests } = product({ preset: 'concise', format: 'plain' });
    room.length = 0;
    const outcome = await runner.run(TURN, { channel: 'sms' });

    expect(outcome).toMatchObject({ status: 'completed', turnId: 'turn-sms-1' });
    expect(requests).toHaveLength(1);
    const system = systemOf(requests[0]);
    for (const line of PLAIN_LINES) expect(system).toContain(line);
    expect(system).toContain('- Use one or two short sentences over a paragraph.');
    expect(system).toContain('\nUser: Is the red one still there?');
    for (const line of [...MARKDOWN_ONLY_LINES.common, ...MARKDOWN_ONLY_LINES.presets]) expect(everything(requests[0])).not.toContain(line);
    expect(markdownRequests(everything(requests[0]))).toEqual([]);
    // The tools it checked: the SDK's interaction tools and the page's UI tools.
    expect((requests[0].tools ?? []).map((t) => t.function.name)).toEqual(expect.arrayContaining(['present_options', 'confirm_action', 'ui_act', 'ui_describe']));
    // The reply the model wrote reaches the conversation's room.
    expect(room.some((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN && String(e.data.text).includes('two blue RAV4s'))).toBe(true);
  });

  it('a persona that names no format still asks for markdown, as every persona did before', async () => {
    for (const style of [undefined, 'concise', { preset: 'concise' as const }]) {
      const { runner, requests } = product(style);
      await runner.run(TURN, { channel: 'chat' });
      const system = systemOf(requests[0]);
      expect(system).toContain('- Format responses with rich markdown: **bold**, headings, bullet lists, and tables when comparing data.');
      expect(system).toContain('\n**User:** Is the red one still there?');
      for (const line of PLAIN_LINES) expect(system).not.toContain(line);
    }
  });

  it('a format the worker does not know fails when the runtime is created, before any turn', () => {
    expect(() => product({ format: 'html' as never })).toThrow(/communicationStyle\.format must be one of markdown, plain, not "html"/);
    expect(() => product({ preset: 'casual' as never, format: 'plain' })).toThrow(/communicationStyle\.preset/);
  });
});

describe('the format, through a turn on a live call', () => {
  let call: http.Server;
  let callUrl: string;
  let plain: ReturnType<typeof product>;
  beforeAll(async () => {
    plain = product({ preset: 'conversational', format: 'plain' });
    const handler = createLiveCallTurnHandler({
      runner: plain.runner,
      credential: CREDENTIAL,
      resolveTurn: () => ({ conversationId: 'conv-1', userId: 'visitor-1', accountId: 'rooftop-1', socketRoom: 'conversation:conv-1', context: TURN.context }),
    });
    call = http.createServer(handler);
    await new Promise<void>((resolve) => call.listen(0, '127.0.0.1', resolve));
    callUrl = `http://127.0.0.1:${(call.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => call.close(() => resolve()));
  });

  it('agrees with the spoken reply: no markdown asked for anywhere, and the system prompt is the chat turn’s, byte for byte', async () => {
    await plain.runner.run({ ...TURN, turnId: 'turn-chat-1' }, { channel: 'chat' });
    const chat = plain.requests.at(-1)!;

    const res = await fetch(callUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-1', clientRef: 'ref-1', turnId: 'turn-call-1', kind: 'message', text: SAID, output: { mode: 'voice' } }),
    });
    const stream = await res.text();
    expect(res.status).toBe(200);
    expect(stream).toContain('two blue RAV4s');

    const spoken = plain.requests.at(-1)!;
    expect(spoken).not.toBe(chat);
    // The call is told its reply is heard, after the conversation; the system prompt does not change.
    expect(textOf(spoken.messages.at(-1)!.content)).toContain(spokenReplyText({ mode: 'voice' }));
    expect(systemOf(spoken)).toBe(systemOf(chat));
    for (const line of PLAIN_LINES) expect(systemOf(spoken)).toContain(line);
    expect(markdownRequests(everything(spoken))).toEqual([]);
  });
});
