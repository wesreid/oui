/**
 * The fixture turn, end to end (ADR-0227 W6 and W7 acceptance).
 *
 * W6: it completes against `agent-sdk-realtime`, with no studio-realtime and
 * no Closure code involved.
 * W7: it passes the same way on both host adapters (Lambda + SQS, container)
 * and on two model providers (Bedrock, OpenAI), each replaying recorded
 * responses through its real `ai` provider package.
 *
 * The model calls the page's `navigate` UI tool; the dispatch goes through the
 * SDK realtime server to a real browser socket; the tab answers through OUI's
 * transport; the answer comes back through the server's result store; the turn
 * continues on the new page; the reply streams to the tab. The artifact checked
 * is what the product persists and what its user saw.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { runFixtureTurn, type HostAdapter } from './support/fixture-turn.js';
import { bedrockReplay, openaiReplay, type ReplayedProvider } from './support/replay.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

const providers: Array<() => ReplayedProvider> = [bedrockReplay, openaiReplay];
const adapters: HostAdapter[] = ['lambda', 'container'];

describe.each(providers.map((make) => [make().name, make] as const))('on %s', (_name, makeProvider) => {
  it.each(adapters)('the %s adapter runs the fixture turn through the real tab and persists a complete, true turn', async (adapter) => {
    const provider = makeProvider();
    const run = await runFixtureTurn(product, {
      adapter,
      model: provider.model,
      promptCacheBreakpoint: provider.promptCacheBreakpoint,
    });

    // ── The turn ended well, on the model the host passed ────────────────
    expect(run.outcome.status).toBe('completed');
    expect(run.startedWithModel).toHaveLength(1);
    expect(run.startedWithModel[0]).toContain(provider.name === 'openai' ? 'openai' : 'bedrock');

    // ── What the tab saw ──────────────────────────────────────────────────
    expect(run.tab.dispatches).toEqual([
      expect.objectContaining({
        requestId: provider.expected.toolCallId,
        surfaceId: 'app-shell',
        actionId: 'navigate',
        params: { path: '/reports' },
      }),
    ]);
    const streamed = run.tab.events
      .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(streamed).toContain(provider.expected.reply);
    const order = run.tab.events.map((e) => e.event);
    expect(order.indexOf('oui:dispatch')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('oui:dispatch')).toBeLessThan(order.indexOf(AGENT_SOCKET_EVENTS.TURN_COMPLETE));

    // ── What the provider was sent ────────────────────────────────────────
    expect(provider.requests).toHaveLength(2);
    const first = JSON.stringify(provider.requests[0]);
    const second = JSON.stringify(provider.requests[1]);
    // The host's prompt, the three UI tools in the provider's format, and the page's index on the message.
    expect(first).toContain('Desk, a reporting product');
    for (const tool of ['ui_act', 'ui_describe', 'ui_read']) expect(first).toContain(`"${tool}"`);
    expect(first).toContain('- navigate: ');
    // The knowledge the tab sent for its page, rendered by the SDK after the
    // host's prompt (the host's callback never sees it): the app's map, the
    // page in full, the page it leads to, and the recipe the UI implies.
    for (const section of [
      '## Platform Knowledge (Context-Aware)',
      '### Desk\\nPages: Inbox (/inbox), Reports (/reports).',
      '### Inbox, in full\\nLists messages newest first.',
      '### Reports\\nSaved reports: export one, or email it.',
      '## Active Workflows',
      '### Find a report\\nTrigger: The user asks for a report\\nSteps:\\n1. Go to /reports\\n2. Read the reports observation',
    ]) {
      expect(first).toContain(section);
    }
    expect(first.indexOf('Desk, a reporting product')).toBeLessThan(first.indexOf('## Platform Knowledge'));
    expect(first.split('## Platform Knowledge').length).toBe(2);
    expect(first).not.toContain('uiKnowledge');
    // The tab's real answer, carried back through the server's result store,
    // and the turn continued on the page the tab is now on.
    expect(second).toContain('navigatedTo');
    expect(second).toContain('/reports');
    expect(second).toContain('reports_export');
    if (provider.promptCacheBreakpoint) expect(first).toContain('cachePoint');
    else expect(first).not.toContain('cachePoint');

    // ── What the product persisted: the artifact ──────────────────────────
    expect(run.persisted).toHaveLength(1);
    const { turnId, conversationId, messages } = run.persisted[0];
    expect(turnId).toBe(run.outcome.turnId);
    expect(conversationId).toBe('conv-fx-1');
    const call = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    // The model runs the page's action through `ui_act`, and that is the call the product keeps.
    expect(call?.toolCalls).toEqual([
      { id: provider.expected.toolCallId, name: 'ui_act', arguments: { action: 'navigate', input: { path: '/reports' } } },
    ]);
    const toolResult = messages.find((m) => m.role === 'tool' && m.toolCallId === provider.expected.toolCallId);
    expect(JSON.parse(toolResult!.content!)).toMatchObject({ result: { navigatedTo: '/reports' } });
    expect(messages.filter((m) => m.role === 'assistant').at(-1)?.content).toBe(provider.expected.reply);
  }, 30_000);
});
