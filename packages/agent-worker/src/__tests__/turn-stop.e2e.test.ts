/**
 * Stopping a turn, end to end (ADR-0252 §2.1–§2.4): the real realtime server,
 * the real worker on its container adapter, a real browser socket, and the
 * model replayed through its real `ai` provider package. So the stop path is
 * tried against what the `ai` library really does when its signal is aborted
 * with a tool call out, not against a stand-in for it.
 *
 * The artifact checked is what the product stores and what its user is told.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_SOCKET_EVENTS, TURN_STOP_EVENT, turnStoppedNote, type TurnStopResult } from '@ouispec/agent-core';
import { FIXTURE_TURN, INTERNAL_KEY, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { runFixtureTurn } from './support/fixture-turn.js';
import { bedrockReplay } from './support/replay.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

describe('a turn stopped by its user', () => {
  it('asked before the worker picks the turn up: the model is never called, and the turn stores and says only that it was stopped', async () => {
    const turnId = 'turn-stop-early';
    const room = `chat:turn:${turnId}`;
    const provider = bedrockReplay();
    const tab = await product.openTab('session-ana', room);

    // The person's Stop, on their own socket, from the turn's room.
    const asked = await new Promise<TurnStopResult>((resolve) => tab.socket.emit(TURN_STOP_EVENT, { turnId, room }, resolve));
    expect(asked).toEqual({ ok: true, stop: 'requested' });

    const run = await runFixtureTurn(product, { adapter: 'container', model: provider.model, turnId, tab });

    expect(run.outcome).toMatchObject({ status: 'stopped', turnId, stopReason: 'user_stop', rounds: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(tab.dispatches).toEqual([]);

    expect(run.persisted).toHaveLength(1);
    const [only] = run.persisted[0].messages;
    expect(run.persisted[0].messages).toHaveLength(1);
    expect(only).toMatchObject({ role: 'assistant', content: turnStoppedNote({ reason: 'user_stop' }), stopped: { reason: 'user_stop' } });

    const done = (await tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, turnId)) as { stopReason?: string };
    expect(done.stopReason).toBe('user_stop');
    expect(tab.turnEvents(turnId).map((e) => e.event)).not.toContain(AGENT_SOCKET_EVENTS.TURN_ERROR);
    tab.close();
  }, 30_000);

  it('asked while a UI action is out and no tab has taken it: the real model stream is aborted, the call is stored as not run, and the turn ends stopped', async () => {
    const turnId = 'turn-stop-midcall';
    const provider = bedrockReplay();
    // A tab that is not in the turn's room yet, as when the worker is ahead of the browser:
    // the action's request reaches nobody, and the turn waits on it.
    const tab = await product.openTab('session-ana', 'chat:turn:turn-stop-elsewhere');

    const running = runFixtureTurn(product, { adapter: 'container', model: provider.model, turnId, tab, tabJoinsAfterMs: 1_500 });
    await new Promise((r) => setTimeout(r, 400));
    // The host's stop for its user (a newer message arrived): the same record the socket writes.
    const res = await fetch(`${product.realtimeUrl}/internal/turns/${turnId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_KEY },
      body: JSON.stringify({ userId: FIXTURE_TURN.userId, reason: 'superseded' }),
    });
    expect(res.status).toBe(200);
    const run = await running;

    expect(run.outcome).toMatchObject({ status: 'stopped', turnId, stopReason: 'superseded' });
    // The model was asked once, made its call, and was never asked again.
    expect(provider.requests).toHaveLength(1);

    expect(run.persisted).toHaveLength(1);
    const messages = run.persisted[0].messages;
    const calls = messages.flatMap((m) => m.toolCalls ?? []);
    const results = messages.filter((m) => m.role === 'tool');
    // One call, one result: a history a model accepts.
    expect(calls.map((c) => c.id)).toEqual([provider.expected.toolCallId]);
    expect(results.map((m) => m.toolCallId)).toEqual([provider.expected.toolCallId]);
    expect(JSON.parse(results[0].content!)).toMatchObject({ stopped: true, notRun: true });
    expect(JSON.parse(results[0].content!).error).toMatch(/no open page took it/);
    // The last assistant message carries the marker, and no message is empty.
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants[assistants.length - 1].stopped).toMatchObject({ reason: 'superseded' });
    for (const m of assistants) expect(m.content === null ? (m.toolCalls?.length ?? 0) > 0 : m.content.trim() !== '').toBe(true);
    // The action never reached a tab.
    expect(tab.dispatches.filter((d) => d.requestId === provider.expected.toolCallId)).toEqual([]);
    tab.close();
  }, 30_000);
});
