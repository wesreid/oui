/**
 * A caller's earlier photo capture that did not complete can be picked up where it left off.
 *
 * The call service lists, on every turn of a session with plans, the caller's earlier captures
 * that can be continued: `client.capture.resumable`, `[{ captureId, planKey, outcome, endedAt,
 * missingSteps }]`, newest first, at most five. The worker reads it as strictly as the rest of
 * `client.capture`, lists each in `capture_start`'s description in the lines Closure's own brain
 * is shown, and gives the model the same sentence Closure's brain has: offer to finish it, with
 * `capture_start({ plan, resumeCaptureId })`. Through the real `ai` loop the model resumes it, and
 * studio-api is asked only for that.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { readLiveCallTurnRequest } from '../live-call/protocol.js';
import {
  CAPTURE_LIMITS,
  CAPTURE_OUTCOMES,
  CAPTURE_RESUMABLE_MAX,
  CAPTURE_RESUMABLE_OUTCOMES,
  CAPTURE_RESUME_WHEN,
  captureFacts,
  captureText,
  readTurnCapture,
  resumableLines,
  type TurnCapture,
} from '../prompt/capture.js';
import { CAPTURE_START_TOOL, captureTools } from '../capture/capture-tools.js';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';

const SESSION_ID = '098a0789-5b1f-4c34-9e0a-2f1c7a0d55e1';
const EARLIER = '7a2d4c1b-0e9f-4a8b-b6c5-3d2e1f0a9b8c';
const OLDER = '1c9e8f7a-6b5d-4c3e-a2f1-0e9d8c7b6a54';
const RESUMED = '5f0c7a1e-2b9d-4e63-9a7f-0d1c2b3a4e5f';
const TOKEN = 'lcb1.eyJzaWQiOiIwOThhMDc4OSIsImJybiI6ImNsaWVudCJ9.Y2FwdHVyZS1icmFpbi10b2tlbi1zaWduYXR1cmU';
const TRADE_IN = { key: 'trade-in-appraisal', title: 'Trade-in photos', offerWhen: 'The caller has a vehicle to trade in and wants a value for it.' };
const SERVICE = { key: 'service-damage', title: 'Damage photos', offerWhen: 'The caller reports damage they want the service desk to see.' };
const CONTROL_URL = `https://api.closurestudio.ai/api/v1/sessions/${SESSION_ID}/captures`;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

/** `client.capture.resumable`'s entries, exactly as studio-gateway #158 sends them. */
const PARTIAL = { captureId: EARLIER, planKey: TRADE_IN.key, outcome: 'partial', endedAt: '2026-11-17T10:00:00.000Z', missingSteps: ['vin', 'front_three_quarter'] };
const TIMED_OUT = { captureId: OLDER, planKey: TRADE_IN.key, outcome: 'abandoned', endedAt: null, missingSteps: ['odometer'] };
const captureOf = (url = CONTROL_URL, extra: Record<string, unknown> = {}) => ({
  plans: [TRADE_IN, SERVICE],
  control: { url, token: TOKEN, expiresAt: inAnHour() },
  active: null,
  update: null,
  resumable: [PARTIAL, TIMED_OUT],
  ...extra,
});
const SPOKEN = {
  sessionId: SESSION_ID,
  clientRef: 'deos-conv-81f2c0de',
  turnId: 'a3c5e1f0-7d2b-4b8e-a1c4-6f0e9d3b2a17',
  kind: 'message',
  text: 'I started the photos of my Civic yesterday but had to go. Can I finish them?',
  input: { mode: 'voice', language: 'en' },
};
const readCapture = (capture: unknown) => {
  const reading = readLiveCallTurnRequest({ ...SPOKEN, client: { capture } });
  return reading.ok ? reading.request.client?.capture : reading.error;
};
const read = (capture: unknown) => readTurnCapture(capture) as TurnCapture;

describe('the resumable captures’ contract', () => {
  // `@closurestudio/realtime-contracts` 0.29.0's capture outcomes, less the two Closure never offers back.
  it('are every contract outcome but completed and declined, at most five', () => {
    expect(CAPTURE_RESUMABLE_OUTCOMES).toEqual(['partial', 'camera_unavailable', 'abandoned', 'failed']);
    expect([...CAPTURE_RESUMABLE_OUTCOMES].sort()).toEqual(CAPTURE_OUTCOMES.filter((o) => o !== 'completed' && o !== 'declined').sort());
    expect(CAPTURE_RESUMABLE_MAX).toBe(5);
  });

  it('give the sentence Closure’s brain is given, word for word', () => {
    expect(CAPTURE_RESUME_WHEN).toBe(
      'This caller has an earlier photo capture that was not completed (listed in `capture_start`). When photos fit, offer to finish it: ' +
        'call `capture_start` with its plan and its `resumeCaptureId`, so only the missing photos are asked for.',
    );
  });
});

describe('client.capture.resumable on a live-call turn', () => {
  it('is read as the gateway sends it, newest first', () => {
    expect(readCapture(captureOf())).toMatchObject({ resumable: [PARTIAL, TIMED_OUT] });
  });

  it('is none when the call service says nothing of it, or lists none', () => {
    expect(readCapture({ ...captureOf(), resumable: undefined })).toMatchObject({ resumable: [] });
    expect(readCapture({ ...captureOf(), resumable: [] })).toMatchObject({ resumable: [] });
  });

  it('leaves out a capture this call could never continue: of a plan the session does not offer, missing nothing, or listed twice', () => {
    const read = readCapture({
      ...captureOf(),
      resumable: [PARTIAL, { ...TIMED_OUT, planKey: 'loan-documents' }, { ...TIMED_OUT, missingSteps: [] }, PARTIAL],
    }) as TurnCapture;
    expect(read.resumable).toEqual([PARTIAL]);
  });

  it('reads past fields it does not know in an entry', () => {
    const read = readCapture({ ...captureOf(), resumable: [{ ...PARTIAL, visitorRef: 'shopper-4412', expiresAt: '2026-12-17T10:00:00.000Z' }] }) as TurnCapture;
    expect(Object.keys(read.resumable![0])).toEqual(['captureId', 'planKey', 'outcome', 'endedAt', 'missingSteps']);
  });

  it('refuses a malformed entry naming it, and never repeats the token', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['cap-0', /^client\.capture\.resumable must be a list/],
      [Array.from({ length: CAPTURE_LIMITS.resumable + 1 }, (_, i) => ({ ...PARTIAL, captureId: `cap-${i}` })), /^client\.capture\.resumable lists more than 20 captures/],
      [['cap-0'], /^client\.capture\.resumable\[0\] must be an object/],
      [[{ ...PARTIAL, captureId: '' }], /^client\.capture\.resumable\[0\]\.captureId must be a capture id/],
      [[{ ...PARTIAL, planKey: 'Trade In' }], /^client\.capture\.resumable\[0\]\.planKey must be a plan key/],
      [[{ ...PARTIAL, outcome: 'declined' }], /^client\.capture\.resumable\[0\]\.outcome must be one of partial, camera_unavailable, abandoned, failed$/],
      [[{ ...PARTIAL, outcome: 'completed' }], /^client\.capture\.resumable\[0\]\.outcome must be one of/],
      [[{ ...PARTIAL, endedAt: 'yesterday' }], /^client\.capture\.resumable\[0\]\.endedAt must be an ISO 8601/],
      [[{ ...PARTIAL, missingSteps: 'vin' }], /^client\.capture\.resumable\[0\]\.missingSteps must be a list/],
      [[{ ...PARTIAL, missingSteps: ['VIN plate'] }], /^client\.capture\.resumable\[0\]\.missingSteps must be a list/],
    ];
    for (const [resumable, error] of cases) {
      const said = readCapture({ ...captureOf(), resumable });
      expect(said, JSON.stringify(resumable).slice(0, 80)).toMatch(error);
      expect(said).not.toContain(TOKEN.slice(5, 20));
    }
  });
});

describe('telling the model what it can pick up', () => {
  it('lists each in capture_start’s description, in the lines Closure’s brain is shown', () => {
    const [start] = captureTools(read(captureOf()));
    expect(start.name).toBe(CAPTURE_START_TOOL);
    expect(start.description).toContain(
      '\nEarlier photo captures for this caller that were not completed, which can be continued (pass its plan and its id as resumeCaptureId):' +
        `\n- ${EARLIER} (plan trade-in-appraisal): partial, ended 2026-11-17T10:00:00.000Z; missing: vin, front_three_quarter` +
        `\n- ${OLDER} (plan trade-in-appraisal): abandoned; missing: odometer`,
    );
    expect(resumableLines([PARTIAL as never])).toBe(`\n- ${EARLIER} (plan trade-in-appraisal): partial, ended 2026-11-17T10:00:00.000Z; missing: vin, front_three_quarter`);
  });

  it('says to offer to finish it in the turn’s capture line, and says nothing of it when there is none', () => {
    expect(captureText(read(captureOf()))).toContain(CAPTURE_RESUME_WHEN);
    expect(captureText(read({ ...captureOf(), resumable: [] }))).not.toContain('earlier photo capture');
    expect(captureTools(read({ ...captureOf(), resumable: [] }))[0].description).not.toContain('Earlier photo captures');
  });

  it('offers nothing to resume on a turn that cannot start photos', () => {
    expect(captureText(read({ ...captureOf(), control: null }))).not.toContain('resumeCaptureId');
    expect(captureTools(read({ ...captureOf(), control: null }))).toEqual([]);
  });

  it('logs how many there are, never their ids', () => {
    const facts = captureFacts(read(captureOf()));
    expect(facts).toMatchObject({ resumable: 2 });
    expect(JSON.stringify(facts)).not.toContain(EARLIER);
  });
});

// ─── The real `ai` loop, against a mock studio-api ──────────────────────────

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  vi.restoreAllMocks();
});

async function studioApi(): Promise<{ url: string; received: Array<{ path: string; authorization?: string; body: unknown }> }> {
  const state = { url: '', received: [] as Array<{ path: string; authorization?: string; body: unknown }> };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.received.push({ path: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          captureId: RESUMED,
          status: 'starting',
          outcome: null,
          resumedFrom: EARLIER,
          words: 'Photo capture "Trade-in photos" is starting on the caller\'s screen: 2 photos to go, VIN and Front corner.',
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/sessions/${SESSION_ID}/captures`;
  return state;
}

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

describe('picking up an earlier capture, through the real ai loop', () => {
  it('the model resumes the capture the turn names, with its plan and its id; only the missing photos are asked for', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const api = await studioApi();
    const prompts: unknown[] = [];
    const tools: Array<Array<{ name: string; description?: string }>> = [];
    const model = new MockLanguageModelV4({
      doStream: async (options: { prompt: unknown; tools?: unknown }) => {
        prompts.push(options.prompt);
        tools.push((options.tools ?? []) as Array<{ name: string; description?: string }>);
        const chunks =
          prompts.length === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Of course, let’s pick up where you left off. ' },
                { type: 'text-end', id: '0' },
                { type: 'tool-call', toolCallId: 'call-1', toolName: CAPTURE_START_TOOL, input: JSON.stringify({ plan: TRADE_IN.key, resumeCaptureId: EARLIER }) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Just the VIN and one front corner to go.' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    } as never);
    const config: AgentWorkerConfig = {
      tools: createToolRegistry([]),
      emit: { emit: vi.fn(async () => {}) },
      model: model as AgentWorkerConfig['model'],
      systemPrompt: 'You are the dealership’s assistant on a live call.',
      promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.anthropic,
    };
    const input: AgentTurnInput = {
      turnId: 'turn-resume-1',
      conversationId: 'conv-1',
      userId: 'visitor-1',
      accountId: 'rooftop-1',
      socketRoom: 'conversation:conv-1',
      content: SPOKEN.text,
      history: [{ role: 'user', content: SPOKEN.text }],
      capture: read(captureOf(api.url)),
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config, input);

    // The capture to pick up was named to the model, in the tool and in the turn's context.
    const start = tools[0].find((t) => t.name === CAPTURE_START_TOOL)!;
    expect(start.description).toContain(`- ${EARLIER} (plan trade-in-appraisal): partial, ended 2026-11-17T10:00:00.000Z; missing: vin, front_three_quarter`);
    expect(JSON.stringify(prompts[0])).toContain('offer to finish it: call `capture_start` with its plan and its `resumeCaptureId`');
    // The artifact: studio-api was asked to continue exactly that capture, with the turn's token.
    expect(api.received).toEqual([
      { path: `/api/v1/sessions/${SESSION_ID}/captures`, authorization: `Bearer ${TOKEN}`, body: { plan: TRADE_IN.key, resumeCaptureId: EARLIER } },
    ]);
    const startResult = result.newMessages.find((m) => m.role === 'tool' && m.name === CAPTURE_START_TOOL)!;
    expect(JSON.parse(startResult.content as string)).toMatchObject({ captureId: RESUMED, status: 'starting' });
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: 'Just the VIN and one front corner to go.' });
  });
});
