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
import { createOpenAI } from '@ai-sdk/openai';
import { bedrockReplay, chunk } from './support/replay.js';
import type { LanguageModel } from '../model.js';

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

    // Stopped once the action's request is out: waited for, not timed, so a loaded machine cannot stop the turn first.
    let out!: () => void;
    const requestOut = new Promise<void>((resolve) => (out = resolve));
    const running = runFixtureTurn(product, {
      adapter: 'container',
      model: provider.model,
      turnId,
      tab,
      tabJoinsAfterMs: 1_500,
      onUIDispatch: () => out(),
    });
    await requestOut;
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

  it('asked mid-text in its second step: stores step one whole, then exactly the text streamed in step two, with nothing repeated and nothing missing', async () => {
    const turnId = 'turn-stop-midtext';
    const STEP_ONE = ['Opening ', 'your reports', ' now. '];
    const STEP_TWO = ['They are open. ', 'Next I will export ', 'the Q3 one'];
    const call = { id: 'call_nav_mid', name: 'ui_act', args: { action: 'navigate', input: { path: '/reports' } } };

    // The real OpenAI provider package over a stream this test holds open: step one says
    // something and calls the page's navigate; step two says something and never finishes.
    const sse = (c: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(c)}\n\n`);
    const text = (content: string) => sse(chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]));
    let requests = 0;
    let secondStepAborted = false;
    const provider = createOpenAI({
      apiKey: 'fixture-key',
      fetch: (async (_input: unknown, init?: { signal?: AbortSignal }) => {
        const step = ++requests;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (step === 1) {
              for (const piece of STEP_ONE) controller.enqueue(text(piece));
              controller.enqueue(
                sse(
                  chunk([
                    {
                      index: 0,
                      delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
                      finish_reason: null,
                    },
                  ]),
                ),
              );
              controller.enqueue(sse(chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }])));
              controller.enqueue(sse(chunk([], { usage: { prompt_tokens: 600, completion_tokens: 20, total_tokens: 620 } })));
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            // Step two: its text, then silence until the turn is stopped.
            for (const piece of STEP_TWO) controller.enqueue(text(piece));
            init?.signal?.addEventListener('abort', () => {
              secondStepAborted = true;
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
            });
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    const model: LanguageModel = provider.chat('gpt-fixture');

    const tab = await product.openTab('session-ana', `chat:turn:${turnId}`);
    const running = runFixtureTurn(product, { adapter: 'container', model, turnId, tab });

    // The person watches step two's text arrive, then presses Stop.
    const streamed = () =>
      tab
        .turnEvents(turnId)
        .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
        .map((e) => (e.data as { text: string }).text)
        .join('');
    await expect.poll(streamed, { timeout: 10_000, interval: 20 }).toContain(STEP_TWO.join(''));
    const room = `chat:turn:${turnId}`;
    expect(await new Promise<TurnStopResult>((resolve) => tab.socket.emit(TURN_STOP_EVENT, { turnId, room }, resolve))).toEqual({ ok: true, stop: 'requested' });
    const run = await running;

    expect(run.outcome).toMatchObject({ status: 'stopped', stopReason: 'user_stop', rounds: 1 });
    expect(requests).toBe(2);
    expect(secondStepAborted).toBe(true);
    // The action of step one ran on the page, once.
    expect(tab.dispatches.filter((d) => d.requestId === call.id)).toHaveLength(1);

    const messages = run.persisted[0].messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    // Step one, whole: its text, its call, and the call's real result.
    expect(messages[0]).toMatchObject({ content: STEP_ONE.join(''), toolCalls: [{ id: call.id, name: 'ui_act', arguments: call.args }] });
    expect(messages[0].stopped).toBeUndefined();
    expect(messages[1]).toMatchObject({ toolCallId: call.id, name: 'ui_act' });
    expect(JSON.parse(messages[1].content!)).not.toHaveProperty('stopped');
    // Step two: exactly what was streamed in it. Cut by where step one's text ended, so this is
    // the proof that the library's step text is the concatenation of that step's stream.
    expect(messages[2]).toEqual({ role: 'assistant', content: STEP_TWO.join(''), stopped: expect.objectContaining({ reason: 'user_stop' }) });
    // And what was stored is what the person saw: the two rounds, stored as two messages, streamed
    // as two paragraphs (step one ended in a call, so a break comes before step two's text).
    expect(streamed()).toBe(STEP_ONE.join('') + '\n\n' + STEP_TWO.join(''));

    const done = (await tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, turnId)) as { stopReason?: string };
    expect(done.stopReason).toBe('user_stop');
    tab.close();
  }, 30_000);
});
