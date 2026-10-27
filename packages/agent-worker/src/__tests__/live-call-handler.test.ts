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
import { LIVE_CALL_OPENING_MESSAGE } from '../live-call/protocol.js';
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
    async reply() {
      throw new Error('not used here');
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
        userToken: 'visitor-token',
        supersedes: ['t-0'],
      },
    ]);
    expect(runner.hosts[0].stopSignal).toBeInstanceOf(AbortSignal);
    expect(typeof runner.hosts[0].observe).toBe('function');
  });

  it('puts the caller’s time zone on the context, unless the host’s context already names one', async () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const url = await mount(runner);
    await call(url, { text: 'What day is it?', caller: { timeZone: 'America/New_York' } });
    expect(runner.payloads[0].context).toMatchObject({ timeZone: 'America/New_York' });

    const hostKnows = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 1 }));
    const hostUrl = await mount(hostKnows, {
      resolveTurn: async () => ({ ...TARGET, context: { ...TARGET.context, timeZone: 'Europe/Paris' } }),
    });
    await call(hostUrl, { text: 'What day is it?', caller: { timeZone: 'America/New_York' } });
    expect(hostKnows.payloads[0].context).toMatchObject({ timeZone: 'Europe/Paris' });
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
      ['refused', (turnId) => ({ status: 'refused', turnId, reason: 'already completed' }), { code: 'TURN_REFUSED', message: 'The turn was refused by its record: it already ended or was given up on.' }],
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

describe('createLiveCallTurnHandler', () => {
  it('names what is missing', () => {
    const runner = stubRunner(async (p) => ({ status: 'completed', turnId: p.turnId, rounds: 0 }));
    expect(() => createLiveCallTurnHandler({ credential: CREDENTIAL, resolveTurn: () => null } as unknown as LiveCallTurnHandlerConfig)).toThrow(/runner/);
    expect(() => createLiveCallTurnHandler({ runner, credential: [], resolveTurn: () => null })).toThrow(/credential/);
    expect(() => createLiveCallTurnHandler({ runner, credential: CREDENTIAL } as unknown as LiveCallTurnHandlerConfig)).toThrow(/resolveTurn/);
    expect(() => createLiveCallTurnHandler({ runner, credential: CREDENTIAL, resolveTurn: () => null, keepAliveMs: 0 })).toThrow(/keepAliveMs/);
  });
});
