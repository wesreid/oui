/**
 * An async tool waits on events the product declares (W9, ADR-0227 §2.4).
 *
 * Loading: an intent's `subscribe` block names its completion (and may name
 * its failure) and its id field; the declarations must hold them, as a
 * completion and its paired failure correlated on that field, and every
 * mapped result field must be one the completion carries. Anything else fails
 * when the tools load, naming the intent and the event.
 *
 * Running: the tool waits for its job to settle. A completion hands the model
 * the result; a failure fails the call with its declared reason; no
 * settlement leaves the model the job id and the fact that it is still running.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentApiSurface } from '@ouispec/agent-core';
import type { EventWaiter, Settlement, SettlementRequest } from '@ouispec/agent-events';
import { loadToolsFromSchema } from '../tools/schema-loader.js';
import type { ToolExecutionContext } from '../tools/types.js';
import { EXPORT_REPORT_INTENT, fixtureEvents } from './support/fixture-events.js';

async function load(intentYaml: string, options: Parameters<typeof loadToolsFromSchema>[1] = { events: fixtureEvents }) {
  const dir = mkdtempSync(join(tmpdir(), 'w9-intents-'));
  try {
    mkdirSync(join(dir, 'intents'));
    writeFileSync(join(dir, 'intents', 'intent.yaml'), intentYaml);
    return await loadToolsFromSchema(dir, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const variant = (from: string, to: string) => {
  expect(EXPORT_REPORT_INTENT).toContain(from);
  return EXPORT_REPORT_INTENT.replace(from, to);
};

function context(dispatch: Record<string, unknown> = { exportId: 'exp-1' }): ToolExecutionContext {
  const apiSurface = {
    async executeIntent() {
      return { success: true, data: dispatch, async: { jobId: String(dispatch.exportId ?? 'none') } };
    },
  } as unknown as AgentApiSurface;
  return { userId: 'ana', accountId: 'desk-1', turnId: 't-1', conversationId: 'c-1', apiSurface };
}

function waiterSettling(settlement: Omit<Settlement, 'kind'> | null): EventWaiter & { requests: SettlementRequest[] } {
  const requests: SettlementRequest[] = [];
  return {
    requests,
    async waitForSettlement(request) {
      requests.push(request);
      return settlement ? { kind: request.binding.kind, ...settlement } : null;
    },
  };
}

describe('loading an async tool against the declarations', () => {
  it('binds it to the declared completion, its paired failure and its id field', async () => {
    const waiter = waiterSettling(null);
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents, waiter });
    expect(tool.name).toBe('export-report');
    expect(tool.description).toContain('The result arrives via the report:ready realtime event.');

    await tool.execute({ reportId: 'weekly' }, context());
    expect(waiter.requests).toEqual([
      {
        binding: { usedBy: "intent 'export-report'", kind: 'export', completion: 'report:ready', failure: 'report:failed', correlation: 'exportId' },
        id: 'exp-1',
        timeoutMs: 20_000,
      },
    ]);
  });

  it('fails when the event is not declared, naming the intent and the event', async () => {
    await expect(load(variant('event: report:ready', 'event: report:done'))).rejects.toThrow(
      "[agent-sdk-events] intent 'export-report' names the event 'report:done', which is not declared. Declared: report:ready.",
    );
  });

  it('fails when it waits on progress, or names another failure or id field', async () => {
    await expect(load(variant('event: report:ready', 'event: report:progress'))).rejects.toThrow(
      "intent 'export-report': waits on 'report:progress', a progress event",
    );
    await expect(load(variant('event: report:ready', 'event: report:ready\n      failure: agent:turn_error'))).rejects.toThrow(
      "intent 'export-report': names 'agent:turn_error' as the failure of 'report:ready', but the declarations pair it with 'report:failed'",
    );
    await expect(load(variant('        exportId: ${ response.exportId }\n      timeout', '        reportId: ${ response.exportId }\n      timeout'))).rejects.toThrow(
      "intent 'export-report': correlates 'report:ready' on 'reportId', but it is declared to carry its job's id in 'exportId'",
    );
  });

  it('fails when a mapped field is not one the completion carries, or would be overwritten', async () => {
    await expect(load(variant('fileUrl: ${ event.url }', 'fileUrl: ${ event.link }'))).rejects.toThrow(
      "[agent-sdk] intent 'export-report': subscribe.resultMapping.fileUrl reads '${ event.link }', and report:ready carries no 'link' (it carries: exportId, url, pages)",
    );
    await expect(load(variant('fileUrl: ${ event.url }', 'fileUrl: ${ response.url }'))).rejects.toThrow(
      "[agent-sdk] intent 'export-report': subscribe.resultMapping.fileUrl reads '${ response.url }'; a subscribe mapping reads the completion, so it must be ${ event.… }",
    );
    await expect(load(variant('fileUrl: ${ event.url }', 'status: ${ event.url }'))).rejects.toThrow(
      "[agent-sdk] intent 'export-report': subscribe.resultMapping maps 'status', which the SDK sets to how the job ended",
    );
  });

  it('fails when it waits with no declarations, or with a timeout it cannot read', async () => {
    await expect(load(EXPORT_REPORT_INTENT, {})).rejects.toThrow(
      "[agent-sdk] intent 'export-report' waits on 'report:ready', but no event declarations were given (LoadToolsOptions.events)",
    );
    await expect(load(variant('timeout: 20s', 'timeout: soon'))).rejects.toThrow(
      "[agent-sdk] intent 'export-report': subscribe.timeout 'soon' is not a duration like 60s or 2m",
    );
  });
});

describe('running an async tool', () => {
  it('hands the model the result when the job completes', async () => {
    const waiter = waiterSettling({
      role: 'completion',
      event: 'report:ready',
      id: 'exp-1',
      payload: { exportId: 'exp-1', url: 'https://files/exp-1.pdf', pages: 4 },
    });
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents, waiter });
    expect(await tool.execute({ reportId: 'weekly' }, context())).toEqual({
      success: true,
      data: { exportId: 'exp-1', jobId: 'exp-1', status: 'complete', fileUrl: 'https://files/exp-1.pdf', pages: 4 },
    });
  });

  it('fails the call with the declared reason when the job fails', async () => {
    const waiter = waiterSettling({ role: 'failure', event: 'report:failed', id: 'exp-1', payload: { exportId: 'exp-1', error: 'Renderer crashed' } });
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents, waiter });
    expect(await tool.execute({ reportId: 'weekly' }, context())).toEqual({
      success: false,
      error: 'Renderer crashed',
      data: { exportId: 'exp-1', jobId: 'exp-1', status: 'failed' },
    });
  });

  it('leaves the model the job id when the job has not settled in time', async () => {
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents, waiter: waiterSettling(null) });
    expect(await tool.execute({ reportId: 'weekly' }, context())).toEqual({
      success: true,
      data: {
        exportId: 'exp-1',
        jobId: 'exp-1',
        status: 'dispatched',
        warning: 'Neither report:ready nor report:failed arrived for exportId exp-1 within 20s: the job is still running.',
      },
    });
  });

  it('does not wait when the dispatch returned no id to correlate on', async () => {
    const waiter = waiterSettling(null);
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents, waiter });
    const result = await tool.execute({ reportId: 'weekly' }, context({ exportRef: 'x' }));
    expect(waiter.requests).toEqual([]);
    expect(result).toMatchObject({
      success: true,
      data: { status: 'dispatched', warning: "The dispatch returned no 'exportId', so its report:ready cannot be waited on." },
    });
  });

  it('returns the dispatch at once, and promises no event, without a waiter', async () => {
    const [tool] = await load(EXPORT_REPORT_INTENT, { events: fixtureEvents });
    expect(tool.description).not.toContain('realtime event');
    expect(await tool.execute({ reportId: 'weekly' }, context())).toEqual({ success: true, data: { exportId: 'exp-1', jobId: 'exp-1', status: 'dispatched' } });
  });
});
