/**
 * W8 part 2: an API operation that starts a job binds to a declared completion
 * event (`x-async-binding`), and its generated tool waits on it (ADR-0181 §2,
 * ADR-0227 §2.4).
 *
 * The fixture product, end to end, with no Closure code: its API (Desk) queues a
 * report export and its pipeline ends the job some time later with a declared
 * event, emitted through its own realtime server (agent-sdk-realtime on real
 * Redis). The worker waits through that server's settlements, and the model is
 * handed the finished file, not the dispatch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiTools, type OpenApiTool } from '../openapi/index.js';
import { createHttpEventWaiter } from '../events/http-waiter.js';
import { deskAgentHeaders, deskEvents, startDeskApi, type DeskApi } from '../testing/index.js';
import { INTERNAL_KEY, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { runFixtureTurn } from './support/fixture-turn.js';
import { respondingOpenAI } from './support/replay.js';

let product: FixtureProduct;
let api: DeskApi;
/** How the pipeline ends the next export. */
let ending: { event: 'report:ready'; data: { url: string; pages: number } } | { event: 'report:failed'; data: { error: string } };
const emitted: Array<{ event: string; status: number }> = [];

beforeAll(async () => {
  product = await startFixtureProduct();
  api = await startDeskApi({
    onReportQueued: (exportId) => {
      setTimeout(async () => {
        emitted.push({ event: 'report:progress', status: await product.emit('report:progress', { exportId, progress: 0.5 }, [`export:${exportId}`]) });
        emitted.push({
          event: ending.event,
          status: await product.emit(ending.event, { exportId, ...ending.data }, [`export:${exportId}`, 'member:ana']),
        });
      }, 300);
    },
  });
}, 20_000);
afterAll(async () => {
  await Promise.all([product?.stop(), api?.close()]);
});

const waiting = (): OpenApiTool[] =>
  loadOpenApiTools(api.document, {
    baseUrl: api.baseUrl,
    actAs: deskAgentHeaders,
    audience: 'agents',
    events: deskEvents,
    waiter: createHttpEventWaiter({ url: product.realtimeUrl, apiKey: INTERNAL_KEY }),
  });
const ctx = { userId: 'ana', accountId: 'desk-1', turnId: 't', conversationId: 'c' };
const input = { kind: 'pnl', from: '2026-09-01' };

describe('an async operation completes on a declared event', () => {
  it('in a real turn: the tool waits for report:ready, and the model is handed the file', async () => {
    ending = { event: 'report:ready', data: { url: 'https://files.desk.test/pnl.pdf', pages: 4 } };
    emitted.length = 0;
    const tools = waiting();
    const runReport = tools.find((t) => t.name === 'runReport')!;
    expect(runReport.description).toContain('It waits for report:ready');

    const reply = 'Your P&L report is ready: https://files.desk.test/pnl.pdf (4 pages).';
    const model = respondingOpenAI((_req, i) =>
      i === 0 ? { toolCalls: [{ id: 'call_report_1', name: 'runReport', args: input }] } : i === 1 ? { text: reply } : undefined,
    );
    const run = await runFixtureTurn(product, {
      adapter: 'container',
      model: model.model,
      turnId: 'turn-w8-async',
      payload: { content: 'Run my P&L report from September' },
      tools,
    });

    expect(run.outcome.status).toBe('completed');
    expect(emitted).toEqual([
      { event: 'report:progress', status: 200 },
      { event: 'report:ready', status: 200 },
    ]);
    // The API queued it for ana.
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/reports', caller: 'ana', body: input });
    // The model read the finished file: the declared result, the job id and how it ended.
    const toolMessage = (model.requests[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!;
    expect(JSON.parse(toolMessage.content)).toEqual({
      exportId: expect.stringMatching(/^exp-\d+$/),
      url: 'https://files.desk.test/pnl.pdf',
      pages: 4,
      status: 'complete',
    });
    expect(run.persisted[0]!.messages.at(-1)).toMatchObject({ role: 'assistant', content: reply });
  }, 30_000);

  it('fails the call with the declared reason when the job fails', async () => {
    ending = { event: 'report:failed', data: { error: 'The ledger is closed for September' } };
    const result = await waiting().find((t) => t.name === 'runReport')!.execute(input, ctx);
    expect(result).toEqual({
      success: false,
      error: 'The ledger is closed for September',
      data: { exportId: expect.stringMatching(/^exp-\d+$/), status: 'failed' },
    });
  }, 30_000);

  it('returns the dispatch when the host gives no waiter, and does not promise the event', async () => {
    ending = { event: 'report:ready', data: { url: 'https://files.desk.test/x.pdf', pages: 1 } };
    const [runReport] = loadOpenApiTools(api.document, {
      baseUrl: api.baseUrl,
      actAs: deskAgentHeaders,
      audience: 'agents',
      events: deskEvents,
    }).filter((t) => t.name === 'runReport');
    expect(runReport!.description).not.toContain('It waits for');
    expect(await runReport!.execute(input, ctx)).toEqual({
      success: true,
      data: { exportId: expect.stringMatching(/^exp-\d+$/), status: 'queued' },
    });
  });
});
