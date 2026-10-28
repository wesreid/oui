/**
 * The runtime's hooks around every turn, on every channel: `beforeTurn`
 * (what the model reads, or that the turn does not run at all) and
 * `filterEvent` (what of the turn leaves the runtime). The orchestrator is a
 * stand-in that emits what a turn emits; the artifacts checked are what the
 * realtime server is sent, what a host observing the turn sees, and what the
 * turn was run with.
 */
import http from 'node:http';
import type { SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../runtime/types.js';
import type { AgentTurnInfo } from '../runtime/turn-info.js';

const orchestrator = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../orchestrator.js', async (original) => ({ ...(await original<typeof import('../orchestrator.js')>()), runAgentTurn: orchestrator.run }));

const { createAgentTurnRunner } = await import('../runtime/turn-runner.js');
const { createLambdaAgentHandler } = await import('../lambda/handler.js');
const { startContainerAgentWorker } = await import('../container/server.js');

/** What the realtime server was sent, in order. */
const room: Array<{ event: string; data: Record<string, unknown> }> = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/api/emit')) {
      const body = JSON.parse(init!.body!) as { event: string; data: Record<string, unknown> };
      room.push({ event: body.event, data: body.data });
    }
    return Response.json({ ok: true });
  }),
);

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, peakPromptTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** The original of what the stand-in emits for its tool call, to show the filter is given a copy. */
let callInput: Record<string, unknown>;

/** A turn as the orchestrator emits it: a round that calls a tool, then the final round, then the end. */
async function emittingTurn(config: AgentWorkerConfig, input: AgentTurnInput) {
  const emit = (event: string, data: Record<string, unknown>) => config.emit.emit(input.socketRoom, event, { turnId: input.turnId, ...data, timestamp: 1 });
  callInput = { card: '4111 1111 1111 1111', note: 'pay' };
  await emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Let me check your card.', step: 0 });
  await emit(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, { toolUseId: 'call_1', name: 'payment_check', input: callInput });
  await emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 0, calledTools: true, final: false });
  await emit(AGENT_SOCKET_EVENTS.REASONING_STARTED, { reasoningId: 'r1' });
  await emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'Your card ending 1111 is fine.', step: 1 });
  await emit(AGENT_SOCKET_EVENTS.ROUND_END, { step: 1, calledTools: false, final: true });
  await config.beforeTurnComplete?.({ rounds: 2, usage: USAGE, newMessages: [{ role: 'assistant', content: 'ok' }] });
  await emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { rounds: 2, usage: USAGE, endReason: 'complete' });
  return { rounds: 2, usage: USAGE, newMessages: [{ role: 'assistant', content: 'ok' }], maxRoundsReached: false, stopReason: 'complete' };
}

const SPOKEN_TURN: AgentTurnPayload = {
  turnId: 't1',
  conversationId: 'c1',
  userId: 'u1',
  accountId: 'a1',
  socketRoom: 'agent:turn:t1',
  content: 'My card is 4111 1111 1111 1111',
  context: { currentPath: '/pay', input: { mode: 'voice', language: 'es' } },
};

function config(extra: Partial<AgentRuntimeConfig<object>> = {}): AgentRuntimeConfig<object> {
  return {
    model: 'provider/model-id',
    realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
    systemPrompt: () => 'You help.',
    tools: [],
    getDb: vi.fn(async () => ({})),
    getHistory: async () => [],
    persistMessages: vi.fn(async () => {}),
    logger: { info() {}, warn() {}, error: vi.fn(), debug() {} },
    approvals: { store: { create: async () => {}, redeem: async () => ({ ok: false, reason: 'used', error: 'used' }), status: async () => null } },
    stops: { client: { watch: (_t, _u, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })) } },
    uiActions: { channel: { request: vi.fn() } as never },
    ...extra,
  };
}

const ranWith = () => orchestrator.run.mock.calls.at(-1) as [AgentWorkerConfig, AgentTurnInput] | undefined;
const REDACTED = 'My card is [card number]';
const redact = (payload: AgentTurnPayload): AgentTurnPayload => ({ ...payload, content: payload.content.replace(/\d{4}( \d{4}){3}/, '[card number]') });

beforeEach(() => {
  room.length = 0;
  orchestrator.run.mockReset();
  orchestrator.run.mockImplementation(emittingTurn);
});

describe('beforeTurn', () => {
  it('replaces what the model reads, and is told which turn it is, how it came and how it was entered', async () => {
    const beforeTurn = vi.fn(async (payload: AgentTurnPayload, _info: AgentTurnInfo) => redact(payload));
    const outcome = await createAgentTurnRunner(config({ beforeTurn })).run(SPOKEN_TURN, { channel: 'sms' });

    expect(outcome).toEqual({ status: 'completed', turnId: 't1', rounds: 2 });
    expect(beforeTurn).toHaveBeenCalledExactlyOnceWith(SPOKEN_TURN, { id: 't1', channel: 'sms', inputMode: 'voice', language: 'es', approvalChannel: 'ui' });
    const [, input] = ranWith()!;
    expect(input.content).toBe(REDACTED);
    expect(input.channel).toBe('sms');
    expect(input.context).toEqual(SPOKEN_TURN.context);
  });

  it('is told where the person approves: the payload’s channel, which the turn carries on to the orchestrator', async () => {
    const beforeTurn = vi.fn(async (payload: AgentTurnPayload) => payload);
    await createAgentTurnRunner(config({ beforeTurn })).run({ ...SPOKEN_TURN, channel: 'sms' }, { channel: 'container' });
    expect(beforeTurn.mock.calls[0][1]).toMatchObject({ channel: 'container', approvalChannel: 'sms' });
    const [, input] = ranWith()!;
    expect(input.channel).toBe('container');
    expect(input.approvalChannel).toBe('sms');
  });

  it('names the turn’s channel `direct` when the host names none', async () => {
    const beforeTurn = vi.fn(async (payload: AgentTurnPayload) => payload);
    await createAgentTurnRunner(config({ beforeTurn })).run({ ...SPOKEN_TURN, context: null });
    expect(beforeTurn.mock.calls[0][1]).toEqual({ id: 't1', channel: 'direct', inputMode: 'text', language: null, approvalChannel: 'ui' });
    expect(ranWith()![1].channel).toBe('direct');
  });

  it('refuses a turn with null: nothing is read, run, stored or sent, and the outcome says who refused it', async () => {
    const cfg = config({ beforeTurn: async () => null });
    const outcome = await createAgentTurnRunner(cfg).run(SPOKEN_TURN);
    expect(outcome).toEqual({ status: 'refused', turnId: 't1', reason: 'refused by beforeTurn', refusedBy: 'beforeTurn' });
    expect(cfg.getDb).not.toHaveBeenCalled();
    expect(orchestrator.run).not.toHaveBeenCalled();
    expect(cfg.persistMessages).not.toHaveBeenCalled();
    expect(room).toEqual([]);
  });

  it('fails the turn when it throws, or returns a turn that cannot run or is another turn', async () => {
    for (const beforeTurn of [
      async () => {
        throw new Error('redaction service down');
      },
      async (p: AgentTurnPayload) => ({ ...p, content: 7 }) as unknown as AgentTurnPayload,
      async (p: AgentTurnPayload) => ({ ...p, turnId: 'other' }),
      async (p: AgentTurnPayload) => ({ ...p, socketRoom: 'agent:turn:elsewhere' }),
    ]) {
      room.length = 0;
      orchestrator.run.mockClear();
      const outcome = await createAgentTurnRunner(config({ beforeTurn })).run(SPOKEN_TURN);
      expect(outcome).toMatchObject({ status: 'failed', turnId: 't1', error: { code: 'WORKER_ERROR' } });
      expect(orchestrator.run).not.toHaveBeenCalled();
      // The client is told, so it stops waiting: in the turn's own room, never another.
      expect(room).toEqual([{ event: AGENT_SOCKET_EVENTS.TURN_ERROR, data: expect.objectContaining({ turnId: 't1' }) }]);
    }
  });

  it('runs before a reply the host already has, which streams as one final round', async () => {
    const seen: string[] = [];
    const runner = createAgentTurnRunner(config({ beforeTurn: async (p, info) => (seen.push(info.channel), p) }));
    await expect(runner.reply(SPOKEN_TURN, 'Hola.', { channel: 'live-call' })).resolves.toEqual({ status: 'completed', turnId: 't1', rounds: 0 });
    expect(seen).toEqual(['live-call']);
    expect(room.map((e) => [e.event, e.data.step, e.data.final])).toEqual([
      [AGENT_SOCKET_EVENTS.TOKEN, 0, undefined],
      [AGENT_SOCKET_EVENTS.ROUND_END, 0, true],
      [AGENT_SOCKET_EVENTS.TURN_COMPLETE, undefined, undefined],
    ]);

    room.length = 0;
    const refusing = createAgentTurnRunner(config({ beforeTurn: async () => null }));
    await expect(refusing.reply(SPOKEN_TURN, 'Hola.')).resolves.toMatchObject({ status: 'refused', refusedBy: 'beforeTurn' });
    expect(room).toEqual([]);
  });

  it('is told the channel each adapter runs on: the Lambda adapter and the container', async () => {
    const channels: string[] = [];
    const beforeTurn = async (p: AgentTurnPayload, info: AgentTurnInfo) => (channels.push(info.channel), p);

    await createLambdaAgentHandler(config({ beforeTurn }))({ Records: [{ body: JSON.stringify(SPOKEN_TURN) }] } as unknown as SQSEvent);

    let ended!: () => void;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const worker = await startContainerAgentWorker({ ...config({ beforeTurn }), port: 0, workerApiKey: 'k', onTurnEnd: () => ended() });
    try {
      const res = await fetchLocal(worker.port, '/turns', { ...SPOKEN_TURN, turnId: 't2', socketRoom: 'agent:turn:t2' });
      expect(res.status).toBe(202);
      await done;
    } finally {
      await worker.close();
    }
    expect(channels).toEqual(['lambda', 'container']);
  });
});

describe('filterEvent', () => {
  /** The host's filter: card numbers masked wherever they are, and the model's thinking never sent. */
  const mask = (event: string, data: Record<string, unknown>) =>
    event === AGENT_SOCKET_EVENTS.REASONING_STARTED ? null : (JSON.parse(JSON.stringify(data).replace(/\d{4}( \d{4}){3}/g, '•••• 1111')) as Record<string, unknown>);

  it('decides what the room and an observing host receive, before either sees it', async () => {
    const filterEvent = vi.fn(mask);
    const observed: Array<{ event: string; data: unknown }> = [];
    await createAgentTurnRunner(config({ filterEvent })).run(SPOKEN_TURN, { observe: (event, data) => void observed.push({ event, data }), channel: 'live-call' });

    const sent = room.map((e) => e.event);
    expect(sent).not.toContain(AGENT_SOCKET_EVENTS.REASONING_STARTED);
    expect(JSON.stringify(room)).not.toContain('4111 1111 1111 1111');
    expect(room.find((e) => e.event === AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED)?.data.input).toEqual({ card: '•••• 1111', note: 'pay' });
    // The host observing the turn (the live-call handler) gets exactly what the room got.
    expect(observed).toEqual(room);
    // Told which turn each event is of.
    expect(filterEvent.mock.calls[0][2]).toEqual({ id: 't1', channel: 'live-call', inputMode: 'voice', language: 'es', approvalChannel: 'ui' });
    // Given a copy: what it changes reaches no other part of the turn.
    expect(callInput).toEqual({ card: '4111 1111 1111 1111', note: 'pay' });
  });

  it('fails closed: an event it throws on, or answers with something that is not a payload, is not sent, and the failure is logged', async () => {
    const cfg = config({
      filterEvent: (event, data) => {
        if (event === AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED) throw new Error('redactor crashed');
        if (event === AGENT_SOCKET_EVENTS.REASONING_STARTED) return undefined as unknown as null;
        return data;
      },
    });
    await createAgentTurnRunner(cfg).run(SPOKEN_TURN);
    const sent = room.map((e) => e.event);
    expect(sent).not.toContain(AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED);
    expect(sent).not.toContain(AGENT_SOCKET_EVENTS.REASONING_STARTED);
    expect(sent).toEqual([
      AGENT_SOCKET_EVENTS.TOKEN,
      AGENT_SOCKET_EVENTS.ROUND_END,
      AGENT_SOCKET_EVENTS.TOKEN,
      AGENT_SOCKET_EVENTS.ROUND_END,
      AGENT_SOCKET_EVENTS.TURN_COMPLETE,
    ]);
    expect(cfg.logger!.error).toHaveBeenCalledWith(
      '[agent-sdk] The host’s event filter failed; the event was not sent',
      expect.objectContaining({ turnId: 't1', event: AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, error: 'redactor crashed' }),
    );
    expect(cfg.logger!.error).toHaveBeenCalledWith(
      '[agent-sdk] The host’s event filter failed; the event was not sent',
      expect.objectContaining({ event: AGENT_SOCKET_EVENTS.REASONING_STARTED, error: expect.stringContaining('undefined') }),
    );
  });

  it('filters a failed turn’s error and a host reply too', async () => {
    orchestrator.run.mockImplementation(async () => {
      throw new Error('card 4111 1111 1111 1111 declined upstream');
    });
    const runner = createAgentTurnRunner(config({ filterEvent: mask }));
    await runner.run(SPOKEN_TURN);
    expect(room.map((e) => e.event)).toEqual([AGENT_SOCKET_EVENTS.TURN_ERROR]);
    expect(JSON.stringify(room)).not.toContain('4111 1111 1111 1111');

    room.length = 0;
    await runner.reply(SPOKEN_TURN, 'Your card 4111 1111 1111 1111 is on file.');
    expect(room[0].data.text).toBe('Your card •••• 1111 is on file.');
  });

  it('passes the host’s approval hooks to the turn', async () => {
    const preview = vi.fn();
    const validateBeforeApproval = vi.fn();
    await createAgentTurnRunner(config({ approvals: { store: config().approvals!.store, preview, validateBeforeApproval } })).run(SPOKEN_TURN);
    expect(ranWith()![0].approvalHooks).toEqual({ preview, validateBeforeApproval });
    await createAgentTurnRunner(config()).run(SPOKEN_TURN);
    expect(ranWith()![0].approvalHooks).toBeUndefined();
  });
});

function fetchLocal(port: number, path: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
