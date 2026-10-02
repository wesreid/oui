/**
 * W9 acceptance: the fixture product declares its events, and an async tool
 * completes on one (ADR-0227 §2.4, §2.6 item 5).
 *
 * No Closure code, packages or infrastructure: the fixture product declares
 * `report:ready` and `report:failed` (fixture-events.ts); its realtime server
 * (agent-sdk-realtime) follows those declarations; its `export-report` intent
 * is loaded against them; the worker runs in the container adapter and waits
 * through the server's settlements (createHttpEventWaiter). The product's
 * backend emits the job's end the way a real pipeline does, some time after
 * the dispatch returned. The artifact checked is what the model was given,
 * what the product persisted, and what its user saw.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentApiSurface } from '@ouispec/agent-core';
import { AGENT_TURN_EVENTS } from '@ouispec/agent-events';
import { loadToolsFromSchema } from '../tools/schema-loader.js';
import { createHttpEventWaiter } from '../events/http-waiter.js';
import type { RegisteredTool } from '../tools/types.js';
import { INTERNAL_KEY, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { EXPORT_REPORT_INTENT, fixtureEvents } from './support/fixture-events.js';
import { runFixtureTurn } from './support/fixture-turn.js';
import { openaiReplay } from './support/replay.js';

let product: FixtureProduct;
let tools: RegisteredTool[];
let schemasDir: string;

beforeAll(async () => {
  product = await startFixtureProduct();
  schemasDir = mkdtempSync(join(tmpdir(), 'w9-fixture-intents-'));
  mkdirSync(join(schemasDir, 'intents'));
  writeFileSync(join(schemasDir, 'intents', 'export-report.yaml'), EXPORT_REPORT_INTENT);
  tools = await loadToolsFromSchema(schemasDir, {
    events: fixtureEvents,
    waiter: createHttpEventWaiter({ url: product.realtimeUrl, apiKey: INTERNAL_KEY }),
  });
}, 20_000);

afterAll(async () => {
  await product?.stop();
  if (schemasDir) rmSync(schemasDir, { recursive: true, force: true });
});

/**
 * The product's API: an export is queued, and its pipeline reports progress,
 * then how it ended, through the realtime server, after the dispatch returned.
 */
function deskApi(exportId: string, ending: { event: string; data: Record<string, unknown> }): AgentApiSurface & { emitted: number[] } {
  const emitted: number[] = [];
  return {
    emitted,
    async executeIntent(intentId: string, params: Record<string, unknown>) {
      if (intentId !== 'export-report' || params.reportId !== 'weekly') throw new Error(`unexpected ${intentId} ${JSON.stringify(params)}`);
      setTimeout(async () => {
        const rooms = [`export:${exportId}`, 'member:ana'];
        emitted.push(await product.emit('report:progress', { exportId, progress: 0.5 }, [`export:${exportId}`]));
        emitted.push(await product.emit(ending.event, { exportId, ...ending.data }, rooms));
      }, 400);
      return { success: true, data: { exportId, queued: true }, async: { jobId: exportId, estimatedDuration: '5s' } };
    },
  } as unknown as AgentApiSurface & { emitted: number[] };
}

describe('an async tool completes on a declared event', () => {
  it('waits for report:ready, hands the model the file, and the turn reports it', async () => {
    const api = deskApi('exp-7', { event: 'report:ready', data: { url: 'https://files.desk.test/exp-7.pdf', pages: 3 } });
    const reply = 'Your weekly report is ready: https://files.desk.test/exp-7.pdf (3 pages).';
    const provider = openaiReplay({ toolCall: { id: 'call_export_1', name: 'export-report', arguments: { reportId: 'weekly' } }, reply });

    const run = await runFixtureTurn(product, {
      adapter: 'container',
      model: provider.model,
      turnId: 'turn-w9-ready',
      payload: { content: 'Export my weekly report' },
      tools,
      apiSurface: api,
    });

    expect(run.outcome.status).toBe('completed');
    // The product's server accepted both declared events.
    expect(api.emitted).toEqual([200, 200]);

    // ── What the model was given: the finished file, not the dispatch ─────
    expect(provider.requests).toHaveLength(2);
    const toolResult = JSON.stringify(provider.requests[1]);
    expect(toolResult).toContain('https://files.desk.test/exp-7.pdf');
    expect(toolResult).toContain('\\"status\\":\\"complete\\"');

    // ── What the product persisted: the artifact ──────────────────────────
    const { messages } = run.persisted[0];
    const call = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(call?.toolCalls).toEqual([{ id: 'call_export_1', name: 'export-report', arguments: { reportId: 'weekly' } }]);
    const persisted = JSON.parse(messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_export_1')!.content!);
    expect(persisted).toEqual({
      exportId: 'exp-7',
      queued: true,
      jobId: 'exp-7',
      status: 'complete',
      fileUrl: 'https://files.desk.test/exp-7.pdf',
      pages: 3,
    });
    expect(messages.filter((m) => m.role === 'assistant').at(-1)?.content).toBe(reply);

    // ── What the user saw: the job's end in their room, then the tool's ────
    const order = run.tab.events.map((e) => e.event);
    expect(run.tab.events.find((e) => e.event === 'report:ready')?.data).toEqual({
      exportId: 'exp-7',
      url: 'https://files.desk.test/exp-7.pdf',
      pages: 3,
    });
    expect(order.indexOf('report:ready')).toBeLessThan(order.indexOf(AGENT_TURN_EVENTS.TOOL_CALL_COMPLETE));
    const complete = run.tab.events.find((e) => e.event === AGENT_TURN_EVENTS.TOOL_CALL_COMPLETE)?.data as { success: boolean; result: unknown };
    expect(complete).toMatchObject({ success: true, result: { status: 'complete', fileUrl: 'https://files.desk.test/exp-7.pdf' } });
  }, 30_000);

  it('fails the call with the declared reason when the job ends in report:failed', async () => {
    const api = deskApi('exp-8', { event: 'report:failed', data: { error: 'Renderer crashed' } });
    const reply = 'The export failed: the renderer crashed.';
    const provider = openaiReplay({ toolCall: { id: 'call_export_2', name: 'export-report', arguments: { reportId: 'weekly' } }, reply });

    const run = await runFixtureTurn(product, {
      adapter: 'lambda',
      model: provider.model,
      turnId: 'turn-w9-failed',
      payload: { content: 'Export my weekly report' },
      tools,
      apiSurface: api,
    });

    expect(run.outcome.status).toBe('completed');
    const { messages } = run.persisted[0];
    const persisted = JSON.parse(messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_export_2')!.content!);
    expect(persisted).toEqual({ error: 'Renderer crashed', exportId: 'exp-8', queued: true, jobId: 'exp-8', status: 'failed' });
    expect(JSON.stringify(provider.requests[1])).toContain('Renderer crashed');
    const complete = run.tab.events.find((e) => e.event === AGENT_TURN_EVENTS.TOOL_CALL_COMPLETE)?.data as { success: boolean };
    expect(complete.success).toBe(false);
  }, 30_000);

  it("refuses an event the product did not declare, so no tool could wait on it", async () => {
    expect(await product.emit('report:done', { exportId: 'exp-9', url: 'x' }, ['member:ana'])).toBe(400);
    expect(await product.emit('report:ready', { exportId: 'exp-9' }, ['member:ana'])).toBe(400);
  });
});
