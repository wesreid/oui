/**
 * Work a page's action starts that outlives its call (a website capture, a
 * render), as the product's tab runs it: the call answers started with the
 * job's id beside what the action returned, and the action settles on the
 * job's outcome through the runtime's own polling of a job tracker, which the
 * fixture scripts (`job`). The final answer leaves on the tab's socket as the
 * product's does, so the agent waits for it in the call and with `ui_wait`.
 *
 * Before this, a fixture's action answered once and never settled: an agent
 * that waited for a capture was told nothing was running, as no real tab
 * would tell it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import { deriveInputSchema, toolName, type OuiManifest } from '@ouispec/bindings';
import type { AgentEvalPage, AgentEvalSuite } from '@ouispec/contract';
import type { OUIActionResult } from 'oui-spec/spec';
import { createFixturePage, EvalPageError, type EvalPage } from '../page.js';
import { runEvals } from '../run.js';
import { configFor, recordWith, scratch, agent } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};

const CAPTURE_INPUT = {
  type: 'object',
  properties: { url: { type: 'string' }, captureId: { type: 'string' }, followLinks: { type: 'boolean' } },
  additionalProperties: false,
};

/** A site capture, as a product's room declares it: a job, answered started with the capture's address. */
const capturePage = (surface: NonNullable<AgentEvalPage['surfaces']>[number]): AgentEvalPage => ({
  at: '/home',
  surfaces: [surface],
});

const CAPTURE_SURFACE = {
  id: 'room:website',
  name: 'Website capture',
  description: 'Opens a public website the person named.',
  actions: [
    {
      id: 'website_capture',
      description: 'Reads the page the person named.',
      effect: 'job' as const,
      input: CAPTURE_INPUT,
      result: { success: true, data: { captureId: 'cap-1', url: 'https://example.com/', followOffer: { links: 3 } } },
      job: { jobId: 'cap-1', settlesAfterMs: 600, outcome: { status: 'complete' as const, result: { mediaProjectId: 'mp-1' } } },
      cases: [
        {
          when: { followLinks: true },
          result: { success: true, data: { captureId: 'cap-1', url: 'https://example.com/' } },
          job: { jobId: 'cap-1', settlesAfterMs: 300, outcome: { status: 'failed' as const, error: 'The site refused the browser' } },
        },
        { when: { url: 'https://slow.example/' }, result: { success: true, data: { captureId: 'cap-2' } }, job: { jobId: 'cap-2' } },
      ],
    },
  ],
};

let requests = 0;
async function send(page: EvalPage, params: Record<string, unknown>): Promise<string> {
  const requestId = `r${++requests}`;
  await page.channel.dispatch('turn-room', { requestId, surfaceId: 'room:website', actionId: 'website_capture', params, timestamp: Date.now() });
  return requestId;
}
const first = (page: EvalPage, requestId: string) => page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs: 2_000 });
const final = (page: EvalPage, requestId: string, timeoutMs: number) =>
  page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs, final: true });

describe('an action that starts a job', () => {
  it('answers started with the job’s id beside its data, and its final answer is the job’s outcome once it settles', async () => {
    const page = createFixturePage(capturePage(CAPTURE_SURFACE));
    try {
      const id = await send(page, { url: 'https://example.com/' });
      expect(await first(page, id)).toMatchObject({
        success: true,
        interim: true,
        data: { captureId: 'cap-1', url: 'https://example.com/', followOffer: { links: 3 }, status: 'started', jobId: 'cap-1' },
      });
      // Not before it settles: the agent is told it is still running.
      expect(await final(page, id, 100)).toBeNull();
      const done = (await final(page, id, 3_000)) as OUIActionResult;
      expect(done).toMatchObject({ success: true, interim: false, data: { status: 'complete', jobId: 'cap-1', mediaProjectId: 'mp-1' } });
      expect(page.ran.map((r) => [r.action, r.input])).toEqual([['website_capture', { url: 'https://example.com/' }]]);
    } finally {
      page.close();
    }
  });

  it('ends a failed job as a failure with its reason, and a job started again under the same id starts over', async () => {
    const page = createFixturePage(capturePage(CAPTURE_SURFACE));
    try {
      const started = await send(page, { url: 'https://example.com/' });
      expect((await final(page, started, 3_000))?.data).toMatchObject({ status: 'complete', jobId: 'cap-1' });
      // Continued: the same capture, so the same job id, and this time its run fails.
      const continued = await send(page, { captureId: 'cap-1', followLinks: true });
      expect(await first(page, continued)).toMatchObject({ interim: true, data: { status: 'started', jobId: 'cap-1' } });
      expect(await final(page, continued, 3_000)).toMatchObject({
        success: false,
        interim: false,
        error: { code: 'JOB_FAILED', message: 'The site refused the browser' },
        data: { status: 'failed', jobId: 'cap-1', error: 'The site refused the browser' },
      });
    } finally {
      page.close();
    }
  });

  it('never settles a job with no outcome, and an action answers as before when it starts none', async () => {
    const page = createFixturePage(capturePage(CAPTURE_SURFACE));
    try {
      const slow = await send(page, { url: 'https://slow.example/' });
      expect((await first(page, slow))?.data).toMatchObject({ captureId: 'cap-2', status: 'started', jobId: 'cap-2' });
      expect(await final(page, slow, 1_500)).toBeNull();
    } finally {
      page.close();
    }
    const plain = createFixturePage({
      at: '/home',
      surfaces: [{ ...CAPTURE_SURFACE, actions: [{ id: 'website_read', description: 'Reads it.', effect: 'view', result: { success: true, data: { ok: 1 } } }] }],
    });
    try {
      const requestId = 'plain-1';
      await plain.channel.dispatch('turn-room', { requestId, surfaceId: 'room:website', actionId: 'website_read', params: {}, timestamp: 0 });
      const answer = await first(plain, requestId);
      expect(answer).toMatchObject({ success: true, data: { ok: 1 } });
      expect(answer?.interim).toBeFalsy();
      // Its first answer is its final one.
      expect(await final(plain, requestId, 10)).toEqual(answer);
    } finally {
      plain.close();
    }
  });

  it('refuses a job on an action or control whose effect does not settle on one', () => {
    const notAJob = { ...CAPTURE_SURFACE, actions: [{ ...CAPTURE_SURFACE.actions[0], effect: 'mutate' as const }] };
    expect(() => createFixturePage(capturePage(notAJob))).toThrow(EvalPageError);
    expect(() => createFixturePage(capturePage(notAJob))).toThrow(/"website_capture" of "room:website" starts a job, and its effect is not `job` or `transaction`/);
    const manifest = renderManifest('view');
    expect(() => createFixturePage({ at: '/reports', controls: { 'reports.render': { job: { jobId: 'r-1' } } } }, { manifest })).toThrow(
      /the control "reports.render" starts a job, and its binding’s effect is not `job` or `transaction`/,
    );
  });
});

/** A page whose Render button starts a job, as the product's generated manifest declares it. */
function renderManifest(effect: 'view' | 'job'): OuiManifest {
  return {
    version: 1,
    buildId: 'eval',
    surfaces: [
      {
        id: 'page:reports',
        kind: 'page',
        title: 'Reports',
        description: 'Reports.',
        routes: ['/reports'],
        actions: [
          {
            name: toolName('reports.render'),
            id: 'reports.render',
            source: 'control',
            control: 'button',
            title: 'Render',
            description: 'Render the report',
            effect: effect === 'job' ? { kind: 'job', estimatedDuration: 'a minute' } : 'view',
            input: deriveInputSchema('button', {}),
            reach: [],
            declaredIn: 'reports.tsx',
          },
        ],
        observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
      },
    ],
  };
}

describe('a product control whose binding starts a job', () => {
  it('is followed through the bindings’ own tracker, to the job’s outcome', async () => {
    const page = createFixturePage(
      {
        at: '/reports',
        controls: {
          'reports.render': {
            result: { success: true, data: { reportId: 'q3' } },
            job: { jobId: 'render-q3', settlesAfterMs: 300, outcome: { status: 'complete', result: { url: 'https://cdn.example/q3.pdf' } } },
          },
        },
      },
      { manifest: renderManifest('job') },
    );
    try {
      const requestId = 'render-1';
      await page.channel.dispatch('turn-room', { requestId, surfaceId: 'page:reports', actionId: 'reports_render', params: {}, timestamp: 0 });
      expect(await first(page, requestId)).toMatchObject({ interim: true, data: { reportId: 'q3', status: 'started', jobId: 'render-q3' } });
      expect(await final(page, requestId, 3_000)).toMatchObject({
        success: true,
        data: { status: 'complete', jobId: 'render-q3', url: 'https://cdn.example/q3.pdf' },
      });
    } finally {
      page.close();
    }
  });
});

// ─── Through a turn, as the agent waits for it ───────────────────────────────

const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};
const act = (id: string, action: string, input?: Record<string, unknown>) => ({ id, name: 'ui_act', args: { action, ...(input ? { input } : {}) } });

describe('a job that outlives the call', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'capture',
    page: capturePage(CAPTURE_SURFACE),
    scenarios: [
      {
        id: 'captures-and-waits',
        title: 'Captures the site, waits for the capture, and reports it done',
        turns: [
          {
            user: 'Read https://example.com/',
            expect: {
              page: { ran: [{ action: 'website_capture', input: { url: 'https://example.com/' } }] },
              calls: [{ tool: 'ui_wait', times: 1 }],
              says: ['captured'],
            },
          },
        ],
      },
    ],
  };
  // Told it is still running when the call's wait ends, it waits; told it is complete, it says so.
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const answered = lastTool(request);
    if (answered === null) return { toolCalls: [act('call_capture', 'website_capture', { url: 'https://example.com/' })] };
    if (answered.includes('"status":"running"')) return { toolCalls: [{ id: 'call_wait', name: 'ui_wait', args: { jobId: 'cap-1' } }] };
    if (answered.includes('"status":"complete"')) return { text: 'I captured example.com.' };
    return { text: `Unexpected: ${answered.slice(0, 200)}` };
  };

  it('is reported running when the call’s wait ends, and ui_wait gets its outcome', async () => {
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      // The call waits 100 ms for the job; the capture settles at 600 ms.
      agent: () => ({ ...agent(), uiActions: { jobWaitMs: 100 } }),
    });
    const { result, requests } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    const [capture] = result.cases;
    expect(capture.failures).toEqual([]);
    expect(lastTool(requests[1])).toContain('"status":"running"');
    expect(lastTool(requests[2])).toContain('"mediaProjectId":"mp-1"');
    // And it replays from the recording, through the same page.
    expect((await runEvals(config)).failed).toBe(0);
  });
});
