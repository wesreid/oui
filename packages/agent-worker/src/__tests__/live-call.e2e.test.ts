/**
 * A live call answered by the product's own agent, end to end: the call
 * service's real HTTP requests to the mounted live-call handler, the SDK
 * realtime server on a real Redis, a real browser tab joined to the
 * conversation's room whose OUI runtime answers UI actions, and a model
 * scripted through the real `@ai-sdk/openai` package.
 *
 * The artifacts checked are what the call service receives (the event
 * stream: the reply's text, an approval's readback, the turn's end), what the
 * conversation's page receives (the same turn, streamed to its room, and every
 * UI action), and what the product stores.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { AGENT_SOCKET_EVENTS, type ApprovalRequiredEvent, type TurnStoppedMarker } from '@ouispec/agent-core';
import { inboxSurface, INTERNAL_KEY, shellSurface, startFixtureProduct, type FixtureProduct, type FixtureTab } from './support/fixture-product.js';
import { FixtureConversation } from './support/fixture-turn.js';
import { chunk, sse, type ChatRequest, type ScriptedReply } from './support/replay.js';
import { createAgentTurnRunner, type TurnOutcome } from '../runtime/turn-runner.js';
import { startContainerAgentWorker, DEFAULT_LIVE_CALL_PATH } from '../container/server.js';
import { createLiveCallTurnHandler, type LiveCallTurnHandler, type LiveCallTurnOptions, type LiveCallTurnTarget } from '../live-call/handler.js';
import { LIVE_CALL_OPENING_MESSAGE, type LiveCallTurnRequest } from '../live-call/protocol.js';
import { createHttpApprovalStoreClient } from '../approvals/client.js';
import { buildApprovalPreview } from '../approvals/preview.js';
import type { AgentRuntimeConfig } from '../runtime/types.js';
import type { RegisteredTool } from '../tools/types.js';
import type { TurnMessage } from '../types.js';
import type { LanguageModel } from '../model.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

const CREDENTIAL = 'live-call-brain-credential-2f8c1a';
const NEXT_CREDENTIAL = 'live-call-brain-credential-rotated-9d0e';
const SYSTEM_PROMPT = "You are Desk's assistant on a live call. Help the caller with the page's tools.";
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** The page the conversation is open on: what the product sends with each of its turns. */
const ON_INBOX = { currentPath: '/inbox', oui: { surfaces: [shellSurface, inboxSurface], observations: {} } };

// ─── The model ──────────────────────────────────────────────────────────────

/** One model request's answer: a scripted reply, a reply whose stream stays open until the turn is stopped, or a provider failure. */
type ModelStep = ScriptedReply | { hold: string } | { fail: number };

/**
 * OpenAI Chat Completions through the real provider package, answering its
 * requests in order from `steps`. A request past the end fails the turn.
 */
function scriptedModel(steps: ModelStep[]): { model: LanguageModel; requests: ChatRequest[]; aborted: number[] } {
  const requests: ChatRequest[] = [];
  const aborted: number[] = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  const respond: typeof fetch = async (_input, init) => {
    const index = requests.push(JSON.parse(String(init?.body)) as ChatRequest) - 1;
    const step = steps[index];
    if (!step) throw new Error(`scripted model: no reply for request ${index}`);
    if ('fail' in step) {
      return new Response(JSON.stringify({ error: { message: 'upstream exploded: internal detail 0x7f3a', type: 'server_error' } }), {
        status: step.fail,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('hold' in step) {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content: step.hold }, finish_reason: null }]))}\n\n`));
          const stop = () => {
            aborted.push(index);
            controller.error(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          };
          if (signal?.aborted) stop();
          else signal?.addEventListener('abort', stop, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const chunks: unknown[] = [];
    if (step.text) chunks.push(chunk([{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }]));
    if (step.toolCalls?.length) {
      chunks.push(
        chunk([
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: step.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            },
            finish_reason: null,
          },
        ]),
      );
    }
    chunks.push(chunk([{ index: 0, delta: {}, finish_reason: step.toolCalls?.length ? 'tool_calls' : 'stop' }]));
    chunks.push(chunk([], { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }));
    return new Response(Buffer.from(sse(chunks).bodyBase64, 'base64'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { model: createOpenAI({ apiKey: 'fixture-live-call-key', fetch: respond }).chat('gpt-fixture'), requests, aborted };
}

/** The text of a model request's messages, in order. */
const textsOf = (request: ChatRequest) =>
  request.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')));

// ─── The product ────────────────────────────────────────────────────────────

/** A pending approval the conversation shows: the newest result of its call still says it waits. */
function waitingApproval(conversation: FixtureConversation): string | null {
  const latest = new Map<string, string>();
  for (const m of conversation.history) if (m.role === 'tool' && m.tool_call_id) latest.set(m.tool_call_id, m.content);
  const waiting = [...latest].filter(([, content]) => {
    try {
      return (JSON.parse(content) as { awaitingApproval?: unknown }).awaitingApproval === true;
    } catch {
      return false;
    }
  });
  return waiting.at(-1)?.[0] ?? null;
}

/** The product's classifier for an answer to a readback: a plain yes. */
const AFFIRMATIVE = /^\s*(yes|yeah|yep|sure|go ahead|please do)\b/i;

/**
 * The product's side of the call: its conversation for the call's
 * `clientRef`, what it stores, and the live-call handler on its own server.
 */
interface CallProduct {
  url: string;
  clientRef: string;
  room: string;
  conversationId: string;
  tab: FixtureTab;
  conversation: FixtureConversation;
  /** Each request the host's resolver was given. */
  resolved: LiveCallTurnRequest[];
  /** What each turn's history read was told. */
  histories: Array<{ turnId: string; supersedes: string[] }>;
  persisted: Array<{ turnId: string; messages: TurnMessage[]; stopped?: TurnStoppedMarker }>;
  outcomes: TurnOutcome[];
  /** The decisions the product made on a readback from what the person said. */
  decisions: Array<{ approvalId: string; channel: string }>;
  handler: LiveCallTurnHandler;
  close(): Promise<void>;
}

interface CallProductOptions {
  model: LanguageModel;
  tools?: RegisteredTool[];
  opening?: LiveCallTurnOptions['opening'];
  keepAliveMs?: number;
  retries?: number;
  resolveFails?: boolean;
}

function runtimeConfig(name: string, options: CallProductOptions, state: Pick<CallProduct, 'conversation' | 'histories' | 'persisted'>): AgentRuntimeConfig<object> {
  return {
    model: options.model,
    realtime: { url: product.realtimeUrl, apiKey: INTERNAL_KEY },
    systemPrompt: () => SYSTEM_PROMPT,
    tools: options.tools ?? [],
    uiActions: { resultTimeoutMs: 10_000 },
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    getDb: async () => ({ name }),
    getHistory: async (_conversationId, _db, turn) => {
      state.histories.push({ turnId: turn.turnId, supersedes: [...turn.supersedes] });
      return [...state.conversation.history];
    },
    persistMessages: async ({ turnId, messages, stopped }) => {
      state.persisted.push({ turnId, messages, ...(stopped ? { stopped } : {}) });
      state.conversation.persist(messages);
    },
    logger: quiet,
  };
}

/** The product's resolver: its conversation for the call, the person's message stored, and a spoken yes decided. */
function resolver(state: Omit<CallProduct, 'url' | 'handler' | 'close' | 'outcomes'>, options: CallProductOptions): LiveCallTurnOptions['resolveTurn'] {
  const approvals = createHttpApprovalStoreClient({ url: product.realtimeUrl, apiKey: INTERNAL_KEY });
  return async (request) => {
    state.resolved.push(request);
    if (options.resolveFails) throw new Error('database unreachable: password=hunter2');
    if (request.clientRef !== state.clientRef) return null;
    const target: LiveCallTurnTarget = {
      conversationId: state.conversationId,
      userId: 'ana',
      accountId: 'desk-1',
      socketRoom: state.room,
      context: { ...ON_INBOX, output: { mode: 'text' } },
    };
    // The readback waiting for an answer is answered by this message, or dropped by it.
    const waiting = request.kind === 'message' ? waitingApproval(state.conversation) : null;
    state.conversation.addUser(request.kind === 'opening' ? LIVE_CALL_OPENING_MESSAGE : request.text);
    if (waiting && AFFIRMATIVE.test(request.text)) {
      const decided = await approvals.decide!(waiting, { userId: 'ana', decision: 'approve', channel: 'voice' });
      if (!decided.ok || decided.decision !== 'approve') throw new Error(`the store refused the decision: ${JSON.stringify(decided)}`);
      state.decisions.push({ approvalId: waiting, channel: decided.channel });
      target.approval = { approvalId: waiting, decision: 'approve', token: decided.token };
    }
    return target;
  };
}

let products = 0;
async function startCallProduct(options: CallProductOptions): Promise<CallProduct> {
  const n = ++products;
  const room = `chat:turn:call-conv-${n}`;
  const state = {
    clientRef: `desk-call-${n}`,
    room,
    conversationId: `conv-call-${n}`,
    tab: await product.openTab('session-ana', room),
    conversation: new FixtureConversation(),
    resolved: [] as LiveCallTurnRequest[],
    histories: [] as CallProduct['histories'],
    persisted: [] as CallProduct['persisted'],
    decisions: [] as CallProduct['decisions'],
  };
  const outcomes: TurnOutcome[] = [];
  const runner = createAgentTurnRunner(runtimeConfig(`call-${n}`, options, state));
  const handler = createLiveCallTurnHandler({
    runner,
    credential: [CREDENTIAL, NEXT_CREDENTIAL],
    resolveTurn: resolver(state, options),
    ...(options.opening ? { opening: options.opening } : {}),
    ...(options.keepAliveMs ? { keepAliveMs: options.keepAliveMs } : {}),
    onTurnEnd: (outcome) => outcomes.push(outcome),
  });
  // The product's own server, with the handler mounted on one of its routes.
  const server = http.createServer((req, res) => {
    if (req.url === '/agent/live-call/turns') handler(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    ...state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/live-call/turns`,
    outcomes,
    handler,
    async close() {
      await handler.close();
      state.tab.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ─── The call service ───────────────────────────────────────────────────────

let turns = 0;
/** A turn request as the call service sends it. */
function turnRequest(call: { clientRef: string }, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: '098a0789-5b1f-4c34-9e0a-2f1c7a0d55e1',
    clientRef: call.clientRef,
    turnId: `call-turn-${++turns}`,
    kind: 'message',
    text: 'Open my reports',
    input: { mode: 'voice', language: 'en' },
    output: { mode: 'voice' },
    ...overrides,
  };
}

function post(url: string, body: unknown, init: { credential?: string | null; contentType?: string; signal?: AbortSignal; method?: string } = {}) {
  const headers: Record<string, string> = { accept: 'text/event-stream', 'content-type': init.contentType ?? 'application/json' };
  if (init.credential !== null) headers.authorization = `Bearer ${init.credential ?? CREDENTIAL}`;
  return fetch(url, {
    method: init.method ?? 'POST',
    headers,
    ...(init.method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

type StreamEvent = { event: string; data: Record<string, unknown> };

/** Reads a server-sent event stream as the call service does: event by event, comments kept apart. */
class EventStreamReader {
  readonly events: StreamEvent[] = [];
  readonly comments: string[] = [];
  /** Every block in order, an event as its name and a comment as itself. */
  readonly sequence: string[] = [];
  private buffer = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }

  async next(): Promise<StreamEvent | null> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(':')) {
          this.comments.push(block);
          this.sequence.push(block);
          continue;
        }
        const lines = block.split('\n');
        expect(lines).toHaveLength(2);
        const event = { event: lines[0].replace(/^event: /, ''), data: JSON.parse(lines[1].replace(/^data: /, '')) as Record<string, unknown> };
        this.events.push(event);
        this.sequence.push(event.event);
        return event;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        expect(this.buffer).toBe('');
        return null;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Reads until the stream ends. */
  async rest(): Promise<StreamEvent[]> {
    while (await this.next());
    return this.events;
  }

  /** The reply's text, as the call service assembles it from the `text` events. */
  text(): string {
    return this.events
      .filter((e) => e.event === 'text')
      .map((e) => e.data.text as string)
      .join('');
  }
}

async function streamOf(res: Response): Promise<EventStreamReader> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const reader = new EventStreamReader(res);
  await reader.rest();
  return reader;
}

/** The text the conversation's page received for a turn, in order. */
const roomText = (tab: FixtureTab, turnId: string) =>
  tab
    .turnEvents(turnId)
    .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
    .map((e) => (e.data as { text: string }).text)
    .join('');

// ─── The tests ──────────────────────────────────────────────────────────────

describe('a spoken message on a live call', () => {
  it('is answered on the stream with the model’s reply, while the conversation’s page gets the same turn and its UI action', async () => {
    const m = scriptedModel([
      { text: 'Opening your reports now.', toolCalls: [{ id: 'call_nav_1', name: 'ui_act', args: { action: 'navigate', input: { path: '/reports' } } }] },
      { text: 'Your two reports are on screen: Q3 results and Q2 results.' },
    ]);
    const call = await startCallProduct({ model: m.model });
    try {
      const body = turnRequest(call, { text: 'Can you open my reports?' });
      const stream = await streamOf(await post(call.url, body));

      // ── What the call service receives ──
      expect(stream.text()).toBe('Opening your reports now.\n\nYour two reports are on screen: Q3 results and Q2 results.');
      expect(stream.events.filter((e) => e.event === 'text').length).toBeGreaterThanOrEqual(2);
      expect(stream.events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'complete' } });
      expect(stream.events.map((e) => e.event)).not.toContain('error');
      expect(stream.events.map((e) => e.event)).not.toContain('readback');

      // ── What the conversation's page receives: the same turn, through its room ──
      await call.tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, body.turnId);
      expect(roomText(call.tab, body.turnId)).toBe(stream.text());
      expect(call.tab.turnEvents(body.turnId).map((e) => e.event)).toEqual(
        expect.arrayContaining([AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE, AGENT_SOCKET_EVENTS.TURN_COMPLETE]),
      );
      // In the order it happened: the words said before the action, then the action.
      const order = call.tab.turnEvents(body.turnId).map((e) => e.event);
      expect(order.indexOf(AGENT_SOCKET_EVENTS.TOKEN)).toBeLessThan(order.indexOf(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED));
      // The UI action reached the page, and its runtime ran it: the model read the page it opened.
      expect(call.tab.dispatches).toEqual([expect.objectContaining({ actionId: 'navigate', surfaceId: 'app-shell', params: { path: '/reports' } })]);
      expect(textsOf(m.requests[1]).join('\n')).toContain('"navigatedTo":"/reports"');

      // ── What the model was told ──
      const [first] = m.requests;
      const said = textsOf(first);
      expect(said[0]).toBe(SYSTEM_PROMPT);
      expect(said.some((t) => t === 'Can you open my reports?')).toBe(true);
      const tail = said.at(-1)!;
      expect(tail).toContain('<input>The user spoke their newest message');
      expect(tail).toContain('<output>Your reply will be spoken aloud to the user on a live call');
      expect(said.slice(0, -1).join('\n')).not.toMatch(/<output>|<input>/);

      // ── What the product resolved and stored ──
      expect(call.resolved).toEqual([
        expect.objectContaining({ clientRef: call.clientRef, turnId: body.turnId, kind: 'message', input: { mode: 'voice', language: 'en' }, output: { mode: 'voice' } }),
      ]);
      const stored = call.persisted.find((p) => p.turnId === body.turnId)!;
      expect(stored.messages.filter((msg) => msg.role === 'assistant').map((msg) => msg.content)).toEqual([
        'Opening your reports now.',
        'Your two reports are on screen: Q3 results and Q2 results.',
      ]);
      expect(call.outcomes).toEqual([{ status: 'completed', turnId: body.turnId, rounds: 2 }]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('keeps a stream that is silent through a long tool call alive with comments', async () => {
    const lookups: unknown[] = [];
    const inventory: RegisteredTool = {
      name: 'inventory_search',
      description: 'Searches the store’s inventory.',
      effect: { kind: 'read' },
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute(input) {
        lookups.push(input);
        await new Promise((r) => setTimeout(r, 300));
        return { success: true, data: { matches: [{ model: 'RAV4', colour: 'blue', price: 28_500 }] } };
      },
    };
    const m = scriptedModel([
      { text: 'Let me look.', toolCalls: [{ id: 'call_inv_1', name: 'inventory_search', args: { query: 'blue RAV4' } }] },
      { text: 'We have one blue RAV4 at twenty-eight thousand five hundred dollars.' },
    ]);
    const call = await startCallProduct({ model: m.model, tools: [inventory], keepAliveMs: 60 });
    try {
      const stream = await streamOf(await post(call.url, turnRequest(call, { text: 'Any blue RAV4s?' })));
      expect(lookups).toEqual([{ query: 'blue RAV4' }]);
      expect(stream.text()).toBe('Let me look.\n\nWe have one blue RAV4 at twenty-eight thousand five hundred dollars.');
      // While the tool ran, the stream said nothing but stayed alive.
      const firstText = stream.sequence.indexOf('text');
      const lastText = stream.sequence.lastIndexOf('text');
      const between = stream.sequence.slice(firstText, lastText).filter((b) => b === ': keep-alive');
      expect(between.length).toBeGreaterThanOrEqual(2);
      expect(stream.sequence.at(-1)).toBe('done');
    } finally {
      await call.close();
    }
  }, 30_000);
});

describe('the opening of a live call', () => {
  it('is a greeting the model gives, to an instruction where the person’s words would be', async () => {
    const m = scriptedModel([{ text: 'Hi, this is Desk. What can I help you with today?' }]);
    const call = await startCallProduct({ model: m.model });
    try {
      const body = turnRequest(call, { kind: 'opening', text: '', input: undefined });
      const stream = await streamOf(await post(call.url, body));
      expect(stream.text()).toBe('Hi, this is Desk. What can I help you with today?');
      expect(stream.events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'complete' } });

      const said = textsOf(m.requests[0]);
      expect(said).toContain(LIVE_CALL_OPENING_MESSAGE);
      // Nothing was said, so nothing is said to be spoken; the reply still is.
      expect(said.at(-1)).not.toContain('<input>');
      expect(said.at(-1)).toContain('<output>Your reply will be spoken aloud');
      expect(call.resolved[0]).toMatchObject({ kind: 'opening', text: '', input: null });

      await call.tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, body.turnId);
      expect(roomText(call.tab, body.turnId)).toBe(stream.text());
      expect(call.conversation.history.map((h) => [h.role, h.content])).toEqual([
        ['user', LIVE_CALL_OPENING_MESSAGE],
        ['assistant', 'Hi, this is Desk. What can I help you with today?'],
      ]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('is the product’s template when it gives one: streamed, sent to the room and stored as the model’s would be, with no model call', async () => {
    const m = scriptedModel([]);
    const greeted: Array<{ kind: string; conversationId: string }> = [];
    const call = await startCallProduct({
      model: m.model,
      opening: (request, target) => {
        greeted.push({ kind: request.kind, conversationId: target.conversationId });
        return '  Hello, you have reached Desk. How can I help?  ';
      },
    });
    try {
      const body = turnRequest(call, { kind: 'opening', text: '' });
      const stream = await streamOf(await post(call.url, body));
      expect(m.requests).toHaveLength(0);
      expect(greeted).toEqual([{ kind: 'opening', conversationId: call.conversationId }]);
      expect(stream.events).toEqual([
        { event: 'text', data: { text: 'Hello, you have reached Desk. How can I help?' } },
        { event: 'done', data: { stopReason: 'complete' } },
      ]);
      const complete = (await call.tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, body.turnId)) as { endReason?: string; rounds?: number };
      expect(complete).toMatchObject({ endReason: 'complete', rounds: 0 });
      expect(roomText(call.tab, body.turnId)).toBe('Hello, you have reached Desk. How can I help?');
      expect(call.persisted).toEqual([{ turnId: body.turnId, messages: [{ role: 'assistant', content: 'Hello, you have reached Desk. How can I help?' }] }]);
      expect(call.outcomes).toEqual([{ status: 'completed', turnId: body.turnId, rounds: 0 }]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('fails the turn when the template throws: the model does not greet instead', async () => {
    const m = scriptedModel([]);
    const call = await startCallProduct({
      model: m.model,
      opening: () => {
        throw new Error('template store down');
      },
    });
    try {
      const stream = await streamOf(await post(call.url, turnRequest(call, { kind: 'opening', text: '' })));
      expect(m.requests).toHaveLength(0);
      expect(stream.events).toEqual([{ event: 'error', data: { code: 'WORKER_ERROR', message: 'The turn failed.' } }]);
    } finally {
      await call.close();
    }
  }, 30_000);
});

describe('an irreversible action on a live call', () => {
  const booked: Array<Record<string, unknown>> = [];
  const bookService: RegisteredTool = {
    name: 'service_book',
    title: 'Book a service appointment',
    description: 'Books a service appointment for the caller’s vehicle.',
    consequence: 'Reserves the slot and texts the caller a confirmation.',
    effect: { kind: 'transaction' },
    inputSchema: {
      type: 'object',
      properties: { slot: { type: 'string', title: 'Time' }, vehicle: { type: 'string', title: 'Vehicle' } },
      required: ['slot', 'vehicle'],
      additionalProperties: false,
    },
    async execute(input) {
      booked.push(input);
      return { success: true, data: { booked: true, confirmation: 'SV-2231', ...input } };
    },
  };
  const args = { slot: 'Tuesday 9:00', vehicle: '2021 RAV4' };

  it('is read back verbatim from its preview; a spoken yes runs exactly the stored call, once', async () => {
    const m = scriptedModel([
      { text: 'I can book that for you.', toolCalls: [{ id: 'call_book_1', name: 'service_book', args }] },
      { text: 'You are booked for Tuesday at nine. A confirmation text is on its way.' },
      { text: 'You are all set; nothing else to confirm.' },
    ]);
    const call = await startCallProduct({ model: m.model, tools: [bookService] });
    try {
      // ── Turn 1: the call stops at the readback ──
      const ask = turnRequest(call, { text: 'Book my RAV4 in for Tuesday at nine.' });
      const first = await streamOf(await post(call.url, ask));
      const readback = buildApprovalPreview(bookService, args).readback;
      expect(readback).toBe('Book a service appointment: Time Tuesday 9:00, Vehicle 2021 RAV4. Reserves the slot and texts the caller a confirmation.');
      expect(first.events.map((e) => e.event)).toEqual([...first.events.filter((e) => e.event === 'text').map(() => 'text'), 'readback', 'done']);
      expect(first.text()).toBe('I can book that for you.');
      const [card] = call.tab
        .turnEvents(ask.turnId)
        .filter((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED)
        .map((e) => e.data as ApprovalRequiredEvent);
      expect(card.preview.readback).toBe(readback);
      const roomOrder = call.tab.turnEvents(ask.turnId).map((e) => e.event);
      expect(roomOrder.indexOf(AGENT_SOCKET_EVENTS.TOKEN)).toBeLessThan(roomOrder.indexOf(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED));
      expect(first.events.find((e) => e.event === 'readback')!.data).toEqual({
        approvalId: 'call_book_1',
        text: readback,
        expiresAt: new Date(card.expiresAt).toISOString(),
      });
      expect(Date.parse(first.events.find((e) => e.event === 'readback')!.data.expiresAt as string) - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(first.events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'awaiting_approval' } });
      expect(booked).toEqual([]);

      // ── Turn 2: the person says yes; the product decides, and the stored call runs ──
      const yes = turnRequest(call, { text: 'Yes, please book it.' });
      const second = await streamOf(await post(call.url, yes));
      expect(call.decisions).toEqual([{ approvalId: 'call_book_1', channel: 'voice' }]);
      expect(booked).toEqual([args]);
      expect(second.text()).toBe('You are booked for Tuesday at nine. A confirmation text is on its way.');
      expect(second.events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'complete' } });
      expect(textsOf(m.requests[1]).join('\n')).toContain('"confirmation":"SV-2231"');
      const ran = call.persisted.find((p) => p.turnId === yes.turnId)!.messages[0];
      expect(ran).toMatchObject({ role: 'tool', toolCallId: 'call_book_1', name: 'service_book' });
      expect(JSON.parse(ran.content!)).toMatchObject({ approval: { decided: 'approved', ran: true } });

      // ── Turn 3: another yes is an ordinary message; nothing runs again ──
      const again = await streamOf(await post(call.url, turnRequest(call, { text: 'Yes.' })));
      expect(again.text()).toBe('You are all set; nothing else to confirm.');
      expect(call.decisions).toHaveLength(1);
      expect(booked).toEqual([args]);
    } finally {
      booked.length = 0;
      await call.close();
    }
  }, 40_000);
});

describe('barge-in', () => {
  it('a closed connection stops the turn as a superseding message does; the next turn names it and reads after it', async () => {
    const m = scriptedModel([{ hold: 'We have three blue RAV4s, ' }, { text: 'Sure, the cheapest one is twenty-six thousand dollars.' }]);
    const call = await startCallProduct({ model: m.model });
    try {
      const hangUp = new AbortController();
      const interrupted = turnRequest(call, { text: 'What blue RAV4s do you have?' });
      const res = await post(call.url, interrupted, { signal: hangUp.signal });
      const reader = new EventStreamReader(res);
      expect(await reader.next()).toEqual({ event: 'text', data: { text: 'We have three blue RAV4s, ' } });

      // The person speaks over the reply: the call service closes the connection.
      hangUp.abort();

      // The turn stopped, as a superseding message stops it: its model stream was aborted, what it said is
      // stored with the mark, and the conversation's page is told.
      const complete = (await call.tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, interrupted.turnId, 10_000)) as { stopReason?: string };
      expect(complete.stopReason).toBe('superseded');
      expect(m.aborted).toEqual([0]);
      const stored = call.persisted.find((p) => p.turnId === interrupted.turnId)!;
      expect(stored.stopped).toMatchObject({ reason: 'superseded' });
      expect(stored.messages.at(-1)).toMatchObject({ role: 'assistant', stopped: { reason: 'superseded' } });
      expect(stored.messages.at(-1)!.content).toContain('We have three blue RAV4s,');
      await expect.poll(() => call.outcomes).toEqual([{ status: 'stopped', turnId: interrupted.turnId, rounds: 0, stopReason: 'superseded' }]);

      // ── The next turn names it, and is answered ──
      const next = turnRequest(call, { text: 'Just the cheapest one.', supersedes: [interrupted.turnId] });
      const stream = await streamOf(await post(call.url, next));
      expect(stream.text()).toBe('Sure, the cheapest one is twenty-six thousand dollars.');
      expect(call.histories.find((h) => h.turnId === next.turnId)).toEqual({ turnId: next.turnId, supersedes: [interrupted.turnId] });
      expect(call.resolved.at(-1)!.supersedes).toEqual([interrupted.turnId]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('a request that supersedes a turn still streaming here stops it, and that stream ends saying so', async () => {
    const m = scriptedModel([{ hold: 'Our service hours are ' }, { text: 'We open at eight.' }]);
    const call = await startCallProduct({ model: m.model });
    try {
      const firstTurn = turnRequest(call, { text: 'When are you open?' });
      const reader = new EventStreamReader(await post(call.url, firstTurn));
      expect((await reader.next())?.event).toBe('text');

      const second = await streamOf(await post(call.url, turnRequest(call, { text: 'On Saturday?', supersedes: [firstTurn.turnId] })));
      expect(second.text()).toBe('We open at eight.');
      await reader.rest();
      expect(reader.events.at(-1)).toEqual({ event: 'done', data: { stopReason: 'superseded' } });
      expect(m.aborted).toEqual([0]);
    } finally {
      await call.close();
    }
  }, 30_000);
});

describe('requests that are not a turn it can run', () => {
  it('refuses a missing, wrong or badly sent credential with 401, and runs nothing', async () => {
    const m = scriptedModel([]);
    const call = await startCallProduct({ model: m.model });
    try {
      for (const credential of [null, 'wrong-credential', `${CREDENTIAL}x`]) {
        const res = await post(call.url, turnRequest(call), { credential });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing credential' } });
      }
      const basic = await fetch(call.url, { method: 'POST', headers: { authorization: `Basic ${CREDENTIAL}`, 'content-type': 'application/json' }, body: JSON.stringify(turnRequest(call)) });
      expect(basic.status).toBe(401);
      expect(call.resolved).toEqual([]);
      expect(m.requests).toEqual([]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('accepts either credential while one is rotated', async () => {
    const m = scriptedModel([{ text: 'Hello again.' }]);
    const call = await startCallProduct({ model: m.model });
    try {
      const stream = await streamOf(await post(call.url, turnRequest(call, { text: 'Hello?' }), { credential: NEXT_CREDENTIAL }));
      expect(stream.text()).toBe('Hello again.');
    } finally {
      await call.close();
    }
  }, 30_000);

  it('refuses a malformed request with 400, 405, 413 or 415 naming what is wrong, and runs nothing', async () => {
    const m = scriptedModel([]);
    const call = await startCallProduct({ model: m.model });
    try {
      const refused = async (res: Response, status: number, code: string, message?: RegExp) => {
        expect(res.status).toBe(status);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe(code);
        if (message) expect(body.error.message).toMatch(message);
      };
      await refused(await post(call.url, '{"sessionId": ', {}), 400, 'INVALID_REQUEST', /not JSON/);
      await refused(await post(call.url, turnRequest(call, { text: '' })), 400, 'INVALID_REQUEST', /needs the text the person said/);
      await refused(await post(call.url, turnRequest(call, { kind: 'hello' })), 400, 'INVALID_REQUEST', /^kind/);
      await refused(await post(call.url, turnRequest(call, { turnId: 'not an id' })), 400, 'INVALID_REQUEST', /^turnId/);
      await refused(await post(call.url, turnRequest(call, { supersedes: 'call-turn-1' })), 400, 'INVALID_REQUEST', /^supersedes/);
      await refused(await post(call.url, turnRequest(call), { contentType: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      await refused(await post(call.url, turnRequest(call, { text: 'x'.repeat(70 * 1024) })), 413, 'BODY_TOO_LARGE');
      const get = await post(call.url, undefined, { method: 'GET' });
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect(call.resolved).toEqual([]);
      expect(m.requests).toEqual([]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('answers 404 for a clientRef the product does not know, and 409 for a turn already running', async () => {
    const m = scriptedModel([{ hold: 'Let me think, ' }]);
    const call = await startCallProduct({ model: m.model });
    try {
      const unknown = await post(call.url, turnRequest(call, { clientRef: 'someone-elses-call' }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: { code: 'UNKNOWN_CLIENT_REF', message: 'No conversation for this clientRef' } });
      expect(m.requests).toEqual([]);

      const hangUp = new AbortController();
      const running = turnRequest(call, { text: 'Tell me about financing.' });
      const reader = new EventStreamReader(await post(call.url, running, { signal: hangUp.signal }));
      await reader.next();
      const again = await post(call.url, running);
      expect(again.status).toBe(409);
      expect((await again.json()) as unknown).toEqual({ error: { code: 'TURN_RUNNING', message: `turn ${running.turnId} is already running` } });
      expect(call.handler.running()).toBe(1);
      hangUp.abort();
      await expect.poll(() => call.handler.running()).toBe(0);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('answers 500 when the product cannot resolve the turn, without saying why', async () => {
    const m = scriptedModel([]);
    const call = await startCallProduct({ model: m.model, resolveFails: true });
    try {
      const res = await post(call.url, turnRequest(call));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: { code: 'RESOLVE_FAILED', message: 'The turn could not be resolved' } });
      expect(text).not.toContain('hunter2');
      expect(m.requests).toEqual([]);
    } finally {
      await call.close();
    }
  }, 30_000);

  it('ends a turn the model provider fails with an error event carrying the code and a fixed line, never the cause', async () => {
    const m = scriptedModel([{ fail: 500 }]);
    const call = await startCallProduct({ model: m.model, retries: 0 });
    try {
      const body = turnRequest(call, { text: 'Hello?' });
      const res = await post(call.url, body);
      const reader = new EventStreamReader(res);
      await reader.rest();
      expect(reader.events).toEqual([{ event: 'error', data: { code: 'WORKER_ERROR', message: 'The turn failed.' } }]);
      expect(JSON.stringify(reader.events)).not.toContain('0x7f3a');
      // The conversation's page is told too, as for any failed turn.
      await call.tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_ERROR, body.turnId);
      expect(call.outcomes).toEqual([expect.objectContaining({ status: 'failed', turnId: body.turnId })]);
    } finally {
      await call.close();
    }
  }, 30_000);
});

describe('on the container adapter', () => {
  it('serves the live-call route beside /turns, from the same turn slots', async () => {
    const m = scriptedModel([{ hold: 'Checking the calendar, ' }]);
    const room = 'chat:turn:container-call-conv';
    const tab = await product.openTab('session-ana', room);
    const conversation = new FixtureConversation();
    const state = { conversation, histories: [] as CallProduct['histories'], persisted: [] as CallProduct['persisted'] };
    const outcomes: TurnOutcome[] = [];
    const worker = await startContainerAgentWorker({
      ...runtimeConfig('container', { model: m.model }, state),
      port: 0,
      workerApiKey: 'container-worker-key',
      onTurnEnd: (outcome) => outcomes.push(outcome),
      liveCall: {
        credential: CREDENTIAL,
        resolveTurn: (request) => {
          conversation.addUser(request.text);
          return { conversationId: 'conv-container', userId: 'ana', accountId: 'desk-1', socketRoom: room, context: ON_INBOX };
        },
      },
    });
    try {
      const url = `http://127.0.0.1:${worker.port}${DEFAULT_LIVE_CALL_PATH}`;
      const hangUp = new AbortController();
      const body = { ...turnRequest({ clientRef: 'container-call' }), text: 'Can I come in tomorrow?' };
      const reader = new EventStreamReader(await post(url, body, { signal: hangUp.signal }));
      expect(await reader.next()).toEqual({ event: 'text', data: { text: 'Checking the calendar, ' } });

      // One set of slots: the same turn id cannot also arrive on /turns, and health counts it.
      const health = (await (await fetch(`http://127.0.0.1:${worker.port}/health`)).json()) as { running: number };
      expect(health.running).toBe(1);
      const queued = await fetch(`http://127.0.0.1:${worker.port}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'container-worker-key' },
        body: JSON.stringify({ turnId: body.turnId, conversationId: 'conv-container', userId: 'ana', accountId: 'desk-1', socketRoom: room, content: 'x' }),
      });
      expect(queued.status).toBe(409);
      // The live-call route takes the call service's credential, not the worker's key.
      expect((await post(url, turnRequest({ clientRef: 'container-call' }), { credential: 'container-worker-key' })).status).toBe(401);

      hangUp.abort();
      const complete = (await tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, body.turnId, 10_000)) as { stopReason?: string };
      expect(complete.stopReason).toBe('superseded');
      await expect.poll(() => outcomes).toEqual([{ status: 'stopped', turnId: body.turnId, rounds: 0, stopReason: 'superseded' }]);
      expect(state.persisted[0].stopped).toMatchObject({ reason: 'superseded' });
    } finally {
      await worker.close();
      tab.close();
    }
  }, 30_000);

  it('refuses a live-call path that is not its own', async () => {
    const m = scriptedModel([]);
    const base = runtimeConfig('container', { model: m.model }, { conversation: new FixtureConversation(), histories: [], persisted: [] });
    for (const path of ['/turns', 'live', '/health']) {
      await expect(
        startContainerAgentWorker({ ...base, port: 0, workerApiKey: 'k', liveCall: { path, credential: CREDENTIAL, resolveTurn: () => null } }),
      ).rejects.toThrow(/liveCall\.path must be a path of its own/);
    }
    await expect(startContainerAgentWorker({ ...base, port: 0, workerApiKey: 'k', liveCall: { credential: '', resolveTurn: () => null } })).rejects.toThrow(
      /Missing required configuration for the live-call route: credential/,
    );
  });
});
