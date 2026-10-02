/**
 * Records the fixture turn from live Bedrock, for the acceptance test to replay
 * (src/__tests__/fixture-turn.e2e.test.ts).
 *
 * The turn runs exactly as the test runs it — the fixture product, the SDK
 * realtime server on Redis, a browser tab answering through OUI's transport —
 * with a live model whose HTTP responses are kept as they arrive: status,
 * content type and body bytes. Requests, and so credentials, are never kept.
 *
 * Run: `AWS_PROFILE=<profile> AWS_REGION=us-east-1 pnpm --filter @ouispec/agent-worker record:fixture-turn`
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_CACHE_BREAKPOINTS } from '../src/model.js';
import { startFixtureProduct } from '../src/__tests__/support/fixture-product.js';
import { runFixtureTurn } from '../src/__tests__/support/fixture-turn.js';
import type { RecordedExchange, FixtureRecording } from '../src/__tests__/support/replay.js';
import { LIVE_MODEL_ID, liveBedrock } from './support/bedrock.js';

const OUT = fileURLToPath(new URL('../src/__tests__/fixtures/fixture-turn.bedrock.json', import.meta.url));

describe('record the fixture turn', () => {
  it(`from ${LIVE_MODEL_ID} on Bedrock`, async () => {
    const exchanges: RecordedExchange[] = [];
    const tee: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body = Buffer.from(await res.arrayBuffer());
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      exchanges.push({
        path: decodeURIComponent(url.pathname),
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        bodyBase64: body.toString('base64'),
      });
      return new Response(body, { status: res.status, headers: { 'content-type': exchanges.at(-1)!.contentType } });
    };

    const product = await startFixtureProduct();
    try {
      const run = await runFixtureTurn(product, {
        adapter: 'lambda',
        model: liveBedrock({ fetch: tee })(LIVE_MODEL_ID),
        promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
        turnId: 'turn-fx-record',
      });
      expect(run.outcome.status).toBe('completed');
      expect(exchanges.every((e) => e.status === 200)).toBe(true);
      // What the recording must show for the test to mean anything: the page's
      // navigate action, then a reply.
      expect(run.tab.dispatches.map((d) => [d.actionId, d.params])).toEqual([['navigate', { path: '/reports' }]]);
      const reply = run.persisted[0].messages.filter((m) => m.role === 'assistant').at(-1)?.content;
      expect(reply).toBeTruthy();

      const recording: FixtureRecording = {
        provider: 'amazon-bedrock',
        modelId: LIVE_MODEL_ID,
        recordedAt: new Date().toISOString(),
        expected: { toolCallId: run.tab.dispatches[0].requestId, reply: reply! },
        exchanges,
      };
      writeFileSync(OUT, JSON.stringify(recording, null, 2) + '\n');
    } finally {
      await product.stop();
    }
  });
});
