/**
 * The fixture turn, with the realtime key read by the host's getter.
 *
 * A host that keeps the realtime server's key in its secret store gives the runtime a getter
 * instead of the key. The turn runs against the real SDK realtime server and a real tab, on both
 * host adapters: every request the runtime makes (the turn's events, the UI action's dispatch and
 * the long poll for its answer, the stop watch) presents the key, the getter is read once for all
 * of them, and the product persists the whole turn. When the key was rotated after the host's
 * cache last read it, the first refused request makes the runtime read it again, and the turn
 * completes as if nothing happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { INTERNAL_KEY, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { runFixtureTurn, type FixtureTurnRun, type HostAdapter } from './support/fixture-turn.js';
import { openaiReplay } from './support/replay.js';
import { createRealtimeKeySource } from '../realtime/api-key.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

/** The host's secret store, holding the realtime server's key. */
function secretStore(key: string) {
  const store = {
    key,
    reads: 0,
    getter: async () => {
      store.reads++;
      return store.key;
    },
  };
  return store;
}

/** What the product and its user got from a turn that ran well: the same as with a fixed key. */
function expectCompleteTurn(run: FixtureTurnRun, expected: ReturnType<typeof openaiReplay>['expected']) {
  expect(run.outcome.status).toBe('completed');
  // The UI action went through the realtime server to the tab, and its answer came back.
  expect(run.tab.dispatches).toEqual([expect.objectContaining({ requestId: expected.toolCallId, actionId: 'navigate', params: { path: '/reports' } })]);
  const streamed = run.tab.events
    .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
    .map((e) => (e.data as { text: string }).text)
    .join('');
  expect(streamed).toContain(expected.reply);
  expect(run.tab.events.some((e) => e.event === AGENT_SOCKET_EVENTS.TURN_COMPLETE)).toBe(true);
  // The artifact: the call, the tab's real answer and the reply, persisted once.
  expect(run.persisted).toHaveLength(1);
  const { messages } = run.persisted[0];
  const call = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
  expect(call?.toolCalls).toEqual([{ id: expected.toolCallId, name: 'ui_act', arguments: { action: 'navigate', input: { path: '/reports' } } }]);
  const toolResult = messages.find((m) => m.role === 'tool' && m.toolCallId === expected.toolCallId);
  expect(JSON.parse(toolResult!.content!)).toMatchObject({ result: { navigatedTo: '/reports' } });
  expect(messages.filter((m) => m.role === 'assistant').at(-1)?.content).toBe(expected.reply);
}

const adapters: HostAdapter[] = ['lambda', 'container'];

describe('a turn whose realtime key the host reads with a getter', () => {
  it.each(adapters)('on the %s adapter: completes, and the getter is read once for every request of the turn', async (adapter) => {
    const provider = openaiReplay();
    const store = secretStore(INTERNAL_KEY);
    const run = await runFixtureTurn(product, {
      adapter,
      model: provider.model,
      turnId: `turn-fx-key-getter-${adapter}`,
      apiKey: store.getter,
    });
    expectCompleteTurn(run, provider.expected);
    expect(store.reads).toBe(1);
  }, 30_000);

  it.each(adapters)('on the %s adapter: a key rotated after the host last read it is read again at the first refusal, and the turn completes', async (adapter) => {
    const provider = openaiReplay();
    // The host's cache read the key before the rotation; the store and the server now hold the new one.
    const store = secretStore('fixture-product-retired-key');
    const source = createRealtimeKeySource(store.getter);
    expect(await source.get()).toBe('fixture-product-retired-key');
    store.key = INTERNAL_KEY;

    const run = await runFixtureTurn(product, {
      adapter,
      model: provider.model,
      turnId: `turn-fx-key-rotated-${adapter}`,
      apiKey: source,
    });
    expectCompleteTurn(run, provider.expected);
    // One read before the rotation, one at the first refusal, none after.
    expect(store.reads).toBe(2);
    expect(await source.get()).toBe(INTERNAL_KEY);
  }, 30_000);

  it('a key the server never accepts reaches nothing, as a wrong fixed key does, and each refusal reads the store once', async () => {
    const provider = openaiReplay();
    const store = secretStore('not-the-realtime-key');
    const tab = await product.openTab('session-ana', 'chat:turn:turn-fx-key-wrong');
    await expect(
      runFixtureTurn(product, { adapter: 'container', model: provider.model, turnId: 'turn-fx-key-wrong', apiKey: store.getter, tab }),
    ).rejects.toThrow(/tab saw no agent:turn_complete/);
    // Nothing of the turn reached the tab: no event, no UI action.
    expect(tab.events).toEqual([]);
    expect(tab.dispatches).toEqual([]);
    // The store was asked again after refusals, found the same key each time, and no request was
    // sent twice with it: the reads are bounded by the requests, not a loop.
    expect(store.reads).toBeGreaterThan(1);
    expect(store.reads).toBeLessThan(50);
  }, 30_000);
});
