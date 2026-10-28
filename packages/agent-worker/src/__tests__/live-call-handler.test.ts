/**
 * The live-call handler between the HTTP request and the runtime: the payload
 * it builds from the host's target and the request, and how each way a turn
 * can end becomes the end of the stream. The runtime is a stand-in here that
 * emits a turn's events as the real one does; the end-to-end test runs the
 * real one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { createLiveCallTurnHandler, type LiveCallTurnHandlerConfig, type LiveCallTurnTarget } from '../live-call/handler.js';
import { LIVE_CALL_LIMITS, LIVE_CALL_OPENING_MESSAGE, liveCallOpeningMessage } from '../live-call/protocol.js';
import type { AgentTurnRunner, TurnHost, TurnOutcome } from '../runtime/turn-runner.js';
import type { AgentTurnPayload } from '../runtime/types.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const CREDENTIAL = 'handler-test-credential';

type Script = (payload: AgentTurnPayload, emit: (event: string, data: Record<string, unknown>) => void, host: TurnHost) => Promise<TurnOutcome>;

/** A runner that emits what `script` says, through the observer as the real runner's tee does. */
function stubRunner(script: Script): AgentTurnRunner & { payloads: AgentTurnPayload[]; hosts: TurnHost[] } {
  const payloads: AgentTurnPayload[] = [];
  const hosts: TurnHost[] = [];
  return {
    model: 'stub',
    logger: quiet,
    payloads,
    hosts,
    async run(payload, host = {}) {
      payloads.push(payload);
      hosts.push(host);
      return script(payload, (event, data) => host.observe?.(event, { turnId: payload.turnId, ...data }), host);
    },
    async reply(payload, text, host = {}) {
      payloads.push(payload);
      hosts.push(host);
      host.observe?.(AGENT_SOCKET_EVENTS.TOKEN, { turnId: payload.turnId, text, step: 0 });
      host.observe?.(AGENT_SOCKET_EVENTS.ROUND_END, { turnId: payload.turnId, step: 0, calledTools: false, final: true });
      host.observe?.(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId: payload.turnId, endReason: 'complete' });
      return { status: 'completed', turnId: payload.turnId, rounds: 0 };
    },
  };
}

const TARGET: LiveCallTurnTarget = {
  conversationId: 'conv-1',
  userId: 'visitor-1',
  accountId: 'rooftop-1',
  socketRoom: 'conversation:conv-1',
  userToken: 'visitor-token',
  context: { currentPath: '/inventory', input: { mode: 'typed' }, output: { mode: 'text' }, oui: { surfaces: [] } },
};

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

async function mount(runner: AgentTurnRunner, extra: Partial<LiveCallTurnHandlerConfig> = {}): Promise<string> {
  const handler = createLiveCallTurnHandler({ runner, credential: CREDENTIAL, resolveTurn: () => TARGET, ...extra });
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function call(url: string, body: Record<string, unknown>): Promise<{ status: number; events: Array<{ event: string; data: unknown }> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-1', clientRef: 'ref-1', turnId: 't-1', kind: 'message', text: 'Hello', ...body }),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [event, data] = block.split('\n');
      return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
    });
  return { status: res.status, events };
}

describe('the turn the handler runs', () => {
  it('is the host’s target with the request’s message, how it was entered, how the reply is delivered, and what it supersedes', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner);
    await call(url, { text: 'Is the blue one still there?', input: { mode: 'voice', language: 'en-us' }, output: { mode: 'voice' }, supersedes: ['t-0'] });
    expect(runner.payloads).toEqual([
      {
        turnId: 't-1',
        conversationId: 'conv-1',
        userId: 'visitor-1',
        accountId: 'rooftop-1',
        socketRoom: 'conversation:conv-1',
        content: 'Is the blue one still there?',
        // The host's own `input` and `output` give way to the request's.
        context: { currentPath: '/inventory', oui: { surfaces: [] }, input: { mode: 'voice', language: 'en-US' }, output: { mode: 'voice' } },
        // A call is spoken: its approvals are read back, and the person's next words confirm them.
        channel: 'voice',
        userToken: 'visitor-token',
        supersedes: ['t-0'],
      },
    ]);
    expect(runner.hosts[0].stopSignal).toBeInstanceOf(AbortSignal);
    expect(typeof runner.hosts[0].observe).toBe('function');
    // The host's hooks are told the turn came by a live call.
    expect(runner.hosts[0].channel).toBe('live-call');
  });

  it('is a phone call’s approvals when the host says the call came through a carrier, and refuses a channel no call can be', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    await call(await mount(runner, { resolveTurn: () => ({ ...TARGET, channel: 'phone' }) }), {});
    expect(runner.payloads[0].channel).toBe('phone');
    for (const channel of ['ui', 'sms', 'fax']) {
      const refused = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
      const url = await mount(refused, { resolveTurn: () => ({ ...TARGET, channel: channel as LiveCallTurnTarget['channel'] }) });
      expect((await call(url, {})).status).toBe(500);
      expect(refused.payloads).toEqual([]);
    }
  });

  it('gives the model the host’s copy of the person’s words in place of what was said', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner, { resolveTurn: () => ({ ...TARGET, content: 'My card number is [redacted].' }) });
    await call(url, { text: 'My card number is 4111 1111 1111 1111.' });
    expect(runner.payloads[0].content).toBe('My card number is [redacted].');
    expect(JSON.stringify(runner.payloads)).not.toContain('4111');
  });

  it('runs nothing for a copy that is not text, and answers 500', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner, { resolveTurn: () => ({ ...TARGET, content: 42 as unknown as string }) });
    expect((await call(url, {})).status).toBe(500);
    expect(runner.payloads).toEqual([]);
  });

  it('greets following on from the disclosure the call service spoke', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const disclosureLine = 'Hi! Just so you know, you are talking with an AI assistant.';
    await call(await mount(runner), { kind: 'opening', text: '', output: { mode: 'voice' }, disclosureLine });
    expect(runner.payloads[0].content).toBe(liveCallOpeningMessage({ disclosureLine }));
    expect(runner.payloads[0].content).toContain(disclosureLine);
  });

  it('runs the host’s greeting on the live-call channel too', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const { events } = await call(await mount(runner, { opening: () => 'Welcome to Quillhaven Toyota.' }), { kind: 'opening', text: '' });
    expect(runner.hosts[0].channel).toBe('live-call');
    expect(events).toEqual([
      { event: 'text', data: { text: 'Welcome to Quillhaven Toyota.' } },
      { event: 'done', data: { stopReason: 'complete' } },
    ]);
  });

  it('runs a message typed during the call as typed: no input on the context, the reply still spoken', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const res = await call(await mount(runner), { text: 'What is the VIN?', input: { mode: 'text' }, output: { mode: 'voice' } });
    expect(res.status).toBe(200);
    expect(runner.payloads[0].content).toBe('What is the VIN?');
    expect(runner.payloads[0].context).toEqual({ currentPath: '/inventory', oui: { surfaces: [] }, output: { mode: 'voice' } });
  });

  it('greets on an opening turn, with nothing said to be entered', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner);
    await call(url, { kind: 'opening', text: '', input: { mode: 'voice' }, output: { mode: 'voice' } });
    expect(runner.payloads[0].content).toBe(LIVE_CALL_OPENING_MESSAGE);
    expect(runner.payloads[0].context).not.toHaveProperty('input');
    expect(runner.payloads[0].context).toHaveProperty('output', { mode: 'voice' });
  });

  it('says nothing of the reply’s delivery when the request does not, whatever the host’s context held', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    await call(await mount(runner), {});
    expect(runner.payloads[0].context).toEqual({ currentPath: '/inventory', oui: { surfaces: [] } });
  });

  it('puts the person’s page on the turn’s context as a typed turn from that page carries it', async () => {
    const page = {
      buildId: 'deos-site-b41c',
      currentPath: '/inventory/rav4-hybrid-blue',
      oui: { index: [{ id: 'page:Vehicle', name: 'Vehicle', description: 'One vehicle', index: ['vehicle.show_photos'] }], observations: {} },
      uiKnowledge: { entries: [{ id: 'vehicle', text: 'One vehicle and its photos.' }], workflows: [] },
    };
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const seen: unknown[] = [];
    const bare = { ...TARGET, context: null };
    const url = await mount(runner, {
      resolveTurn: (request) => {
        seen.push(request.client);
        return bare;
      },
    });
    await call(url, { output: { mode: 'voice' }, client: { ui: page } });
    expect(runner.payloads[0].context).toEqual({
      output: { mode: 'voice' },
      oui: page.oui,
      uiKnowledge: page.uiKnowledge,
      currentPath: page.currentPath,
    });
    // The host sees the whole of it, its build included, to check or log.
    expect(seen).toEqual([{ ui: page }]);
  });

  it('keeps what the host’s own context sets, and adds nothing for a call with no page', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner);
    await call(url, { client: { ui: { currentPath: '/service', oui: { index: [], observations: {} }, uiKnowledge: { entries: [] } } } });
    // TARGET's context sets currentPath and oui itself: those stay; uiKnowledge is the page's.
    expect(runner.payloads[0].context).toEqual({ currentPath: '/inventory', oui: { surfaces: [] }, uiKnowledge: { entries: [] } });

    for (const client of [undefined, { ui: null }]) {
      const plain = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
      await call(await mount(plain), client === undefined ? {} : { client });
      expect(plain.payloads[0].context).toEqual({ currentPath: '/inventory', oui: { surfaces: [] } });
    }
  });

  it('refuses a page that is not one, naming it, and runs nothing', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const res = await fetch(await mount(runner), {
      method: 'POST',
      headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-1', clientRef: 'ref-1', turnId: 't-1', kind: 'message', text: 'Hello', client: { ui: { oui: 'x' } } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'client.ui.oui must be an object' } });
    expect(runner.payloads).toEqual([]);
  });

  it('takes a turn whose page is at its bound: the body limit leaves room for it', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const notes = 'x'.repeat(LIVE_CALL_LIMITS.clientUiBytes - 64);
    const url = await mount(runner, { resolveTurn: () => ({ ...TARGET, context: null }) });
    const { status } = await call(url, { text: 'y'.repeat(LIVE_CALL_LIMITS.textChars), client: { ui: { oui: { notes } } } });
    expect(status).toBe(200);
    expect((runner.payloads[0].context as { oui: { notes: string } }).oui.notes).toBe(notes);
  });

  it('carries the decision the host made on a readback', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner, { resolveTurn: () => ({ ...TARGET, approval: { approvalId: 'call_1', decision: 'approve', token: 'tok' } }) });
    await call(url, { text: 'Yes, go ahead.' });
    expect(runner.payloads[0].approval).toEqual({ approvalId: 'call_1', decision: 'approve', token: 'tok' });
  });

  it('runs nothing for a target that is not a turn, and answers 500', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner, { resolveTurn: () => ({ ...TARGET, socketRoom: '' }) });
    const res = await call(url, {});
    expect(res.status).toBe(500);
    expect(runner.payloads).toEqual([]);
  });
});

describe('how the stream ends', () => {
  it('reads an approval back after every piece of text, even text sent after the approval was asked for', async () => {
    const runner = stubRunner(async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'I can ' });
      emit(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, { approvalId: 'call_1', expiresAt: Date.UTC(2026, 9, 23, 12, 5), preview: { title: 'Book', arguments: [], readback: 'Book a service.' } });
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'book that.' });
      // The runtime's readback, as the turn's last words: its own event on the call, never text as well.
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: '\n\nBook a service.', readback: true });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'awaiting_approval' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    });
    const { events } = await call(await mount(runner), {});
    expect(events).toEqual([
      { event: 'text', data: { text: 'I can ' } },
      { event: 'text', data: { text: 'book that.' } },
      { event: 'readback', data: { approvalId: 'call_1', text: 'Book a service.', expiresAt: '2026-10-23T12:05:00.000Z' } },
      { event: 'done', data: { stopReason: 'awaiting_approval' } },
    ]);
  });

  it('reads back nothing for an approval the turn did not read back: a UI action’s, which is its card on the person’s screen', async () => {
    const runner = stubRunner(async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'The approval card is on your screen.' });
      emit(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, { approvalId: 'call_1', expiresAt: Date.now() + 60_000, preview: { title: 'Send', arguments: [], readback: 'Send a report.' } });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'awaiting_approval' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    });
    expect((await call(await mount(runner), {})).events).toEqual([
      { event: 'text', data: { text: 'The approval card is on your screen.' } },
      { event: 'done', data: { stopReason: 'awaiting_approval' } },
    ]);
  });

  it('says nothing for a turn of a conversation a person on the staff holds, and ends it taken_over', async () => {
    const runner = stubRunner(async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { stopReason: 'taken_over' });
      return { status: 'stopped', turnId: p.turnId, rounds: 0, stopReason: 'taken_over' };
    });
    expect((await call(await mount(runner), {})).events).toEqual([{ event: 'done', data: { stopReason: 'taken_over' } }]);
  });

  it('reads back the host’s spoken readback when it wrote one', async () => {
    const runner = stubRunner(async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, {
        approvalId: 'call_1',
        expiresAt: Date.UTC(2026, 9, 23, 12, 5),
        preview: { title: 'Book', arguments: [], readback: 'Book a visit on 2026-10-28 at 13:30.', spokenReadback: 'Book a visit on October twenty-eighth at one thirty.' },
      });
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Book a visit on October twenty-eighth at one thirty.', readback: true });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'awaiting_approval' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    });
    const { events } = await call(await mount(runner), {});
    expect(events[0]).toEqual({
      event: 'readback',
      data: { approvalId: 'call_1', text: 'Book a visit on October twenty-eighth at one thirty.', expiresAt: '2026-10-23T12:05:00.000Z' },
    });
  });

  it('never reads back an approval its stopped turn withdrew', async () => {
    const runner = stubRunner(async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, { approvalId: 'call_1', expiresAt: Date.now() + 60_000, preview: { title: 'Book', arguments: [], readback: 'Book a service.' } });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { stopReason: 'user_stop' });
      return { status: 'stopped', turnId: p.turnId, rounds: 1, stopReason: 'user_stop' };
    });
    const { events } = await call(await mount(runner), {});
    expect(events).toEqual([{ event: 'done', data: { stopReason: 'user_stop' } }]);
  });

  it('ignores events of another turn', async () => {
    const runner = stubRunner(async (p, _emit, host) => {
      host.observe?.(AGENT_SOCKET_EVENTS.TOKEN, { turnId: 'someone-else', text: 'not mine' });
      host.observe?.(AGENT_SOCKET_EVENTS.TOKEN, { turnId: p.turnId, text: 'mine' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    });
    const { events } = await call(await mount(runner), {});
    expect(events).toEqual([
      { event: 'text', data: { text: 'mine' } },
      { event: 'done', data: {} },
    ]);
  });

  it('says how a stopped turn ended when the room was not told', async () => {
    const runner = stubRunner(async (p) => ({ status: 'stopped', turnId: p.turnId, rounds: 0, stopReason: 'deadline' }));
    expect((await call(await mount(runner), {})).events).toEqual([{ event: 'done', data: { stopReason: 'deadline' } }]);
  });

  it('is an error for a turn that ran out of time and kept nothing, a refused turn, and a failed one', async () => {
    const cases: Array<[TurnOutcome['status'], (turnId: string) => TurnOutcome, { code: string; message: string }]> = [
      [
        'stopped',
        (turnId) => ({ status: 'stopped', turnId, rounds: 1, stopReason: 'deadline', stored: false }),
        { code: 'TURN_DEADLINE_EXCEEDED', message: 'The turn ran out of time.' },
      ],
      [
        'refused',
        (turnId) => ({ status: 'refused', turnId, reason: 'already completed', refusedBy: 'record' }),
        { code: 'TURN_REFUSED', message: 'The turn was refused by its record: it already ended or was given up on.' },
      ],
      [
        'refused',
        (turnId) => ({ status: 'refused', turnId, reason: 'refused by beforeTurn', refusedBy: 'beforeTurn' }),
        { code: 'TURN_DECLINED', message: 'The product declined to run the turn.' },
      ],
      [
        'failed',
        (turnId) => ({ status: 'failed', turnId, error: { code: 'RATE_LIMIT', message: 'provider said: slow down, key sk-123', recoverable: true }, cause: null }),
        { code: 'RATE_LIMIT', message: 'The model provider is rate-limiting requests.' },
      ],
    ];
    for (const [, outcome, error] of cases) {
      const ended: TurnOutcome[] = [];
      const runner = stubRunner(async (p) => outcome(p.turnId));
      const { events } = await call(await mount(runner, { onTurnEnd: (o) => ended.push(o) }), {});
      expect(events).toEqual([{ event: 'error', data: error }]);
      expect(ended).toEqual([outcome('t-1')]);
    }
  });

  it('is an error when the runtime itself throws around the turn', async () => {
    const runner = stubRunner(async () => {
      throw new Error('getDb exploded');
    });
    expect((await call(await mount(runner), {})).events).toEqual([{ event: 'error', data: { code: 'WORKER_ERROR', message: 'The turn failed.' } }]);
  });
});

describe('what of the reply is spoken', () => {
  /** A turn that looks something up, then answers: the model's words before the call, its call, and its answer. */
  const lookupThenAnswer: Script = async (p, emit) => {
    emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'The customer wants service, ', step: 0 });
    emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'so let me check the calendar.', step: 0 });
    emit(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, { toolUseId: 'call_1', name: 'calendar_search', input: {} });
    emit(AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE, { toolUseId: 'call_1', name: 'calendar_search', success: true });
    emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 0, calledTools: true, final: false });
    emit(AGENT_SOCKET_EVENTS.TOKEN, { text: '\n\nService has a slot ', step: 1 });
    emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'at two tomorrow.', step: 1 });
    emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 1, calledTools: false, final: true });
    emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'complete' });
    return { status: 'completed', turnId: p.turnId, rounds: 2 };
  };

  it('is every round, as written, by default', async () => {
    const { events } = await call(await mount(stubRunner(lookupThenAnswer)), {});
    expect(events.filter((e) => e.event === 'text').map((e) => (e.data as { text: string }).text).join('')).toBe(
      'The customer wants service, so let me check the calendar.\n\nService has a slot at two tomorrow.',
    );
  });

  it('with final-round, is only the round the turn ends with: nothing written before a tool call', async () => {
    const { events } = await call(await mount(stubRunner(lookupThenAnswer), { speak: 'final-round' }), {});
    expect(events).toEqual([
      { event: 'text', data: { text: 'Service has a slot at two tomorrow.' } },
      { event: 'done', data: { stopReason: 'complete' } },
    ]);
  });

  it('with final-round, speaks the host’s holding line once, as the first tool starts, in place of the model’s words', async () => {
    const twoLookups: Script = async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'I looked up the wrong date earlier.', step: 0 });
      emit(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, { toolUseId: 'call_1', name: 'calendar_search', input: {} });
      emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 0, calledTools: true, final: false });
      emit(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, { toolUseId: 'call_2', name: 'calendar_search', input: {} });
      emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 1, calledTools: true, final: false });
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Two tomorrow works.', step: 2 });
      emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 2, calledTools: false, final: true });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'complete' });
      return { status: 'completed', turnId: p.turnId, rounds: 3 };
    };
    const holdingLine = (request: { input: { language?: string } | null }) => (request.input?.language === 'es' ? 'Un momento.' : 'One moment.');
    const url = await mount(stubRunner(twoLookups), { speak: 'final-round', holdingLine });
    expect((await call(url, { input: { mode: 'voice', language: 'en' } })).events).toEqual([
      { event: 'text', data: { text: 'One moment.' } },
      { event: 'text', data: { text: '\n\nTwo tomorrow works.' } },
      { event: 'done', data: { stopReason: 'complete' } },
    ]);
    expect((await call(url, { turnId: 't-2', input: { mode: 'voice', language: 'es' } })).events[0]).toEqual({ event: 'text', data: { text: 'Un momento.' } });
  });

  it('with final-round, speaks the round that asks for approval, then its readback, and no holding line for it', async () => {
    const booking: Script = async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'I can book that for you.', step: 0 });
      emit(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, { approvalId: 'call_1', expiresAt: Date.UTC(2026, 9, 23, 12, 5), preview: { title: 'Book', arguments: [], readback: 'Book a visit.' } });
      emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 0, calledTools: true, final: true });
      // The readback belongs to no round: it is its own event, whatever of the rounds is spoken.
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: '\n\nBook a visit.', readback: true });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'awaiting_approval' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    };
    const { events } = await call(await mount(stubRunner(booking), { speak: 'final-round', holdingLine: 'One moment.' }), {});
    expect(events.map((e) => [e.event, (e.data as { text?: string }).text])).toEqual([
      ['text', 'I can book that for you.'],
      ['readback', 'Book a visit.'],
      ['done', undefined],
    ]);
  });

  it('with final-round, says no holding line for a choice the turn ends with, and nothing of a round that never ended', async () => {
    const choice: Script = async (p, emit) => {
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Which day suits you?', step: 0 });
      emit(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, { toolUseId: 'call_1', name: 'present_options', input: {} });
      emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 0, calledTools: true, final: true });
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Half a thought', step: 1 });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { stopReason: 'superseded' });
      return { status: 'stopped', turnId: p.turnId, rounds: 2, stopReason: 'superseded' };
    };
    const { events } = await call(await mount(stubRunner(choice), { speak: 'final-round', holdingLine: 'One moment.' }), {});
    expect(events).toEqual([
      { event: 'text', data: { text: 'Which day suits you?' } },
      { event: 'done', data: { stopReason: 'superseded' } },
    ]);
  });

  it('fails the turn when the host’s holding line throws, and runs nothing', async () => {
    const runner = stubRunner(lookupThenAnswer);
    const url = await mount(runner, {
      speak: 'final-round',
      holdingLine: () => {
        throw new Error('template store down');
      },
    });
    expect((await call(url, {})).events).toEqual([{ event: 'error', data: { code: 'WORKER_ERROR', message: 'The turn failed.' } }]);
    expect(runner.payloads).toEqual([]);
  });
});

describe('createLiveCallTurnHandler', () => {
  it('names what is missing', () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 0 }));
    expect(() => createLiveCallTurnHandler({ credential: CREDENTIAL, resolveTurn: () => null } as unknown as LiveCallTurnHandlerConfig)).toThrow(/runner/);
    expect(() => createLiveCallTurnHandler({ runner, credential: [], resolveTurn: () => null })).toThrow(/credential/);
    expect(() => createLiveCallTurnHandler({ runner, credential: CREDENTIAL } as unknown as LiveCallTurnHandlerConfig)).toThrow(/resolveTurn/);
    expect(() => createLiveCallTurnHandler({ runner, credential: CREDENTIAL, resolveTurn: () => null, keepAliveMs: 0 })).toThrow(/keepAliveMs/);
  });

  it('refuses a way of speaking it does not know, and a holding line where the model’s own words are spoken', () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 0 }));
    const base = { runner, credential: CREDENTIAL, resolveTurn: () => null };
    expect(() => createLiveCallTurnHandler({ ...base, speak: 'some' as never })).toThrow(/speak must be one of all, final-round/);
    expect(() => createLiveCallTurnHandler({ ...base, holdingLine: 'One moment.' })).toThrow(/holdingLine is spoken only with speak: 'final-round'/);
    expect(() => createLiveCallTurnHandler({ ...base, speak: 'final-round', holdingLine: 7 as never })).toThrow(/holdingLine must be a string or a function/);
    expect(() => createLiveCallTurnHandler({ ...base, speak: 'final-round', holdingLine: 'One moment.' })).not.toThrow();
  });
});
