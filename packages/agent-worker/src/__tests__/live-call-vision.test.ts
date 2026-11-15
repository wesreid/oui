/**
 * A live character sees the caller through their camera.
 *
 * - The call service's `client.vision` is read as strictly as `client.ui`: a
 *   malformed frame is refused naming the field, and no refusal repeats its data.
 * - A `glance` is a turn with no words and a frame, run only with leave to remark.
 * - The handler sets the frame as the turn's `vision`, logs only its facts, and
 *   an answer of nothing ends the stream `done` with no `text`.
 * - Through the real `ai` loop, the frame reaches the model as a picture after
 *   the conversation's cache breakpoint, with the vision clause; an earlier
 *   turn's frame is never sent again, and the frame is in no event, stored
 *   message or log line. The Anthropic and Bedrock providers send it as their
 *   own image block.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { LIVE_CALL_GLANCE_MESSAGE, LIVE_CALL_LIMITS, readLiveCallTurnRequest, type LiveCallRequestReading } from '../live-call/protocol.js';
import { createLiveCallTurnHandler, LIVE_CALL_MAX_BODY_BYTES, liveCallTurnMessage, type LiveCallTurnHandlerConfig } from '../live-call/handler.js';
import { readTurnVision, visionText, VISION_LIMITS, type TurnVision } from '../prompt/vision.js';
import { payloadRefusal, type AgentTurnRunner, type TurnHost, type TurnOutcome } from '../runtime/turn-runner.js';
import type { AgentTurnPayload } from '../runtime/types.js';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';
import { replayingFetch } from '../testing/cassette.js';
import type { FixtureRecording } from './support/replay.js';

// ─── Frames ─────────────────────────────────────────────────────────────────

/** A JPEG's first bytes, then bytes no prompt holds by chance: a frame as the call service sends it. */
function jpeg(seed: number): string {
  const body = Array.from({ length: 60 }, (_, i) => (i * 31 + seed * 17 + 7) % 256);
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...body]).toString('base64');
}
const FRAME = jpeg(1);
const FRAME_LATER = jpeg(2);
const frame = (data = FRAME) => ({ mediaType: 'image/jpeg', data, width: 512, height: 384, capturedAt: '2026-11-14T10:15:30.120Z' });
const seeing = (data = FRAME, remarks = true) => ({ seeing: true, remarks, frame: frame(data), absent: null });

/** A spoken question on a dealer's call, as the call service sends it. */
const SPOKEN = {
  sessionId: '098a0789-5b1f-4c34-9e0a-2f1c7a0d55e1',
  clientRef: 'deos-conv-81f2c0de',
  turnId: 'a3c5e1f0-7d2b-4b8e-a1c4-6f0e9d3b2a17',
  kind: 'message',
  text: 'What am I wearing?',
  input: { mode: 'voice', language: 'en' },
  output: { mode: 'voice' },
};
const GLANCE = { ...SPOKEN, kind: 'glance', text: '', input: undefined, client: { vision: seeing() } };

const refusal = (reading: LiveCallRequestReading) => (reading.ok ? null : reading.error);

// ─── The protocol ───────────────────────────────────────────────────────────

describe('client.vision on a live-call turn', () => {
  it('is read with its frame, on a message, an opening and a glance alike', () => {
    const expected = { seeing: true, remarks: true, frame: frame(), absent: null };
    for (const body of [
      { ...SPOKEN, client: { vision: seeing() } },
      { ...SPOKEN, kind: 'opening', text: '', client: { vision: seeing() } },
      GLANCE,
    ]) {
      const reading = readLiveCallTurnRequest(body);
      expect(reading.ok && reading.request.client).toEqual({ ui: null, vision: expected });
    }
  });

  it('says why no frame came, keeps no reason it does not know, and has nothing absent when a frame came', () => {
    const read = (vision: unknown) => {
      const reading = readLiveCallTurnRequest({ ...SPOKEN, client: { vision } });
      return reading.ok ? reading.request.client?.vision : reading.error;
    };
    expect(read({ seeing: true, remarks: true, frame: null, absent: 'camera_off' })).toEqual({ seeing: true, remarks: true, frame: null, absent: 'camera_off' });
    expect(read({ seeing: true, remarks: false, frame: null, absent: 'stale' })).toMatchObject({ absent: 'stale', remarks: false });
    expect(read({ seeing: true, remarks: true, frame: null, absent: 'lens_cap' })).toMatchObject({ frame: null, absent: null });
    expect(read({ ...seeing(), absent: 'stale' })).toMatchObject({ absent: null });
    // The caller turned "can see me" off: no remarks either, whatever was resolved.
    expect(read({ seeing: false, remarks: true, frame: null, absent: 'turned_off' })).toEqual({ seeing: false, remarks: false, frame: null, absent: 'turned_off' });
    // Fields it does not know are read past.
    expect(read({ ...seeing(), changed: true, frame: { ...frame(), quality: 80 } })).toEqual({ seeing: true, remarks: true, frame: frame(), absent: null });
  });

  it('refuses a malformed vision or frame naming the field, and never repeats the frame’s data', () => {
    const notJpeg = Buffer.from('GIF89a, not the type it says').toString('base64');
    const cases: Array<[unknown, RegExp]> = [
      ['on', /^client\.vision must be an object/],
      [{ seeing: 'yes', remarks: true, frame: null }, /^client\.vision\.seeing must be true or false/],
      [{ seeing: true, frame: null }, /^client\.vision\.remarks must be true or false/],
      [{ seeing: false, remarks: false, frame: frame(), absent: null }, /^client\.vision\.frame must be null when client\.vision\.seeing is false/],
      [{ ...seeing(), absent: 3 }, /^client\.vision\.absent must be a string or null/],
      [{ ...seeing(), frame: 'data:image/jpeg;base64,' + FRAME }, /^client\.vision\.frame must be an object or null/],
      [{ ...seeing(), frame: { ...frame(), mediaType: 'image/gif' } }, /^client\.vision\.frame\.mediaType must be one of image\/jpeg, image\/png, image\/webp/],
      [{ ...seeing(), frame: { ...frame(), data: `${FRAME.slice(0, -4)}*!@#` } }, /^client\.vision\.frame\.data must be standard base64/],
      [{ ...seeing(), frame: { ...frame(), data: FRAME.slice(1) } }, /^client\.vision\.frame\.data must be standard base64/],
      [{ ...seeing(), frame: { ...frame(), data: '' } }, /^client\.vision\.frame\.data must be standard base64/],
      [{ ...seeing(), frame: { ...frame(), data: 'A'.repeat(VISION_LIMITS.frameDataChars + 4) } }, /^client\.vision\.frame\.data must be standard base64 of 1–262144 characters/],
      [{ ...seeing(), frame: { ...frame(), data: notJpeg } }, /^client\.vision\.frame\.data is not a image\/jpeg image/],
      [{ ...seeing(), frame: { ...frame(), width: 0 } }, /^client\.vision\.frame\.width must be a whole number/],
      [{ ...seeing(), frame: { ...frame(), height: 512.5 } }, /^client\.vision\.frame\.height must be a whole number/],
      [{ ...seeing(), frame: { ...frame(), width: 8000 } }, /^client\.vision\.frame\.width must be a whole number of pixels from 1 to 4096/],
      [{ ...seeing(), frame: { ...frame(), capturedAt: 'yesterday' } }, /^client\.vision\.frame\.capturedAt must be an ISO 8601/],
      [{ ...seeing(), frame: { ...frame(), capturedAt: 1763115330120 } }, /^client\.vision\.frame\.capturedAt must be an ISO 8601/],
    ];
    for (const [vision, error] of cases) {
      const said = refusal(readLiveCallTurnRequest({ ...SPOKEN, client: { vision } }));
      expect(said, JSON.stringify(vision).slice(0, 80)).toMatch(error);
      expect(said).not.toContain(FRAME.slice(0, 12));
      expect(said).not.toContain(notJpeg.slice(0, 12));
    }
  });

  it('reads PNG and WebP frames by their own signatures', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
    const webp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');
    expect(readTurnVision({ seeing: true, remarks: true, frame: { ...frame(), mediaType: 'image/png', data: png } })).toMatchObject({ frame: { mediaType: 'image/png' } });
    expect(readTurnVision({ seeing: true, remarks: true, frame: { ...frame(), mediaType: 'image/webp', data: webp } })).toMatchObject({ frame: { mediaType: 'image/webp' } });
    expect(readTurnVision({ seeing: true, remarks: true, frame: { ...frame(), mediaType: 'image/png', data: FRAME } })).toBe('vision.frame.data is not a image/png image');
  });

  it('is the turn payload’s vision too, refused there the same way', () => {
    const payload = { turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'Hi' };
    expect(payloadRefusal({ ...payload, vision: seeing() })).toBeNull();
    expect(payloadRefusal({ ...payload, vision: { ...seeing(), frame: { ...frame(), data: 'not base64!' } } })).toMatch(/^vision\.frame\.data must be standard base64/);
  });
});

describe('a glance turn', () => {
  it('is a look with no words: text empty, nothing entered, the frame its reason to run', () => {
    const reading = readLiveCallTurnRequest(GLANCE);
    expect(reading.ok && reading.request).toMatchObject({ kind: 'glance', text: '', input: null, disclosureLine: null, client: { vision: { frame: frame() } } });
    expect(liveCallTurnMessage({ kind: 'glance', text: '', disclosureLine: null })).toBe(LIVE_CALL_GLANCE_MESSAGE);
    expect(LIVE_CALL_GLANCE_MESSAGE).toMatch(/^<call_glance>.*nothing at all.*<\/call_glance>$/);
  });

  it('is refused with words, without a frame, or without leave to remark', () => {
    expect(refusal(readLiveCallTurnRequest({ ...GLANCE, text: 'hello' }))).toBe('a glance turn carries no text');
    expect(refusal(readLiveCallTurnRequest({ ...GLANCE, client: undefined }))).toBe('a glance turn needs client.vision.frame');
    expect(refusal(readLiveCallTurnRequest({ ...GLANCE, client: { vision: { seeing: true, remarks: true, frame: null, absent: 'stale' } } }))).toBe(
      'a glance turn needs client.vision.frame',
    );
    expect(refusal(readLiveCallTurnRequest({ ...GLANCE, client: { vision: seeing(FRAME, false) } }))).toBe('a glance turn needs client.vision.remarks on');
  });
});

describe('the vision clause', () => {
  it('says what the model may do with the picture, with remarks on or off, and what it never does', () => {
    const on = visionText(readTurnVision(seeing()) as TurnVision)!;
    expect(on).toMatch(/^<vision>You can see the user through their camera: the picture with this note/);
    expect(on).toContain('compliment something they are wearing');
    expect(on).toContain('at most one remark about their appearance in your greeting, and never the same remark twice in a call');
    expect(on).toContain('never identify anyone from their face');
    expect(on).toContain('a guessed age or weight');
    const off = visionText(readTurnVision(seeing(FRAME, false)) as TurnVision)!;
    expect(off).toContain('Do not bring up what you see unless they ask about it.');
    expect(off).not.toContain('compliment');
  });

  it('says the model cannot see, and why, when no frame came', () => {
    const line = (vision: unknown) => visionText(readTurnVision(vision) as TurnVision)!;
    expect(line({ seeing: true, remarks: true, frame: null, absent: 'camera_off' })).toContain('The user’s camera is off, so you cannot see them right now.');
    expect(line({ seeing: false, remarks: false, frame: null, absent: 'turned_off' })).toContain('turned off your view of their camera');
    expect(line({ seeing: true, remarks: true, frame: null, absent: 'stale' })).toContain('too old to go by');
    expect(line({ seeing: true, remarks: true, frame: null, absent: null })).toContain('No picture from the user’s camera came with this message');
    expect(line({ seeing: true, remarks: true, frame: null, absent: 'camera_off' })).toContain('tell them you cannot see them right now, and why');
    expect(visionText(null)).toBeNull();
  });
});

// ─── The handler ────────────────────────────────────────────────────────────

type Script = (payload: AgentTurnPayload, emit: (event: string, data: Record<string, unknown>) => void) => Promise<TurnOutcome>;
const CREDENTIAL = 'vision-test-credential';

function stubRunner(script: Script, lines: unknown[][]): AgentTurnRunner & { payloads: AgentTurnPayload[] } {
  const payloads: AgentTurnPayload[] = [];
  const record = (...args: unknown[]) => lines.push(args);
  return {
    model: 'stub',
    logger: { info: record, warn: record, error: record, debug: record },
    payloads,
    async run(payload, host: TurnHost = {}) {
      payloads.push(payload);
      return script(payload, (event, data) => host.observe?.(event, { turnId: payload.turnId, ...data }));
    },
    async reply() {
      throw new Error('not used');
    },
  };
}

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

async function mount(runner: AgentTurnRunner, extra: Partial<LiveCallTurnHandlerConfig> = {}): Promise<string> {
  const handler = createLiveCallTurnHandler({
    runner,
    credential: CREDENTIAL,
    resolveTurn: () => ({ conversationId: 'conv-1', userId: 'visitor-1', accountId: 'rooftop-1', socketRoom: 'conversation:conv-1' }),
    ...extra,
  });
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function call(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [event, data] = block.split('\n');
      return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) as unknown };
    });
  return { status: res.status, events, text };
}

const completes: Script = async (p, emit) => {
  emit(AGENT_SOCKET_EVENTS.TOKEN, { text: 'I like that yellow shirt.', step: 0 });
  emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'complete' });
  return { status: 'completed', turnId: p.turnId, rounds: 1 };
};

describe('the live-call handler with a frame', () => {
  it('sets the frame as the turn’s vision and logs only its facts', async () => {
    const lines: unknown[][] = [];
    const runner = stubRunner(completes, lines);
    const res = await call(await mount(runner), { ...SPOKEN, client: { vision: seeing() } });
    expect(res.status).toBe(200);
    expect(runner.payloads[0].vision).toEqual({ seeing: true, remarks: true, frame: frame(), absent: null });
    expect(runner.payloads[0].content).toBe(SPOKEN.text);

    const turnLine = lines.find((l) => l[0] === '[agent-sdk] Live-call turn')!;
    expect(turnLine[1]).toMatchObject({ vision: { seeing: true, remarks: true, attached: true, frameBytes: Buffer.from(FRAME, 'base64').length } });
    expect((turnLine[1] as { vision: { frameAgeMs: number } }).vision.frameAgeMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(lines)).not.toContain(FRAME.slice(0, 12));
  });

  it('logs why no frame came, and sets no vision when the call says nothing of it', async () => {
    const lines: unknown[][] = [];
    const runner = stubRunner(completes, lines);
    const url = await mount(runner);
    await call(url, { ...SPOKEN, client: { vision: { seeing: true, remarks: true, frame: null, absent: 'camera_off' } } });
    expect(runner.payloads[0].vision).toEqual({ seeing: true, remarks: true, frame: null, absent: 'camera_off' });
    expect(lines.find((l) => l[0] === '[agent-sdk] Live-call turn')![1]).toMatchObject({ vision: { attached: false, absent: 'camera_off' } });
    await call(url, { ...SPOKEN, turnId: 'turn-without-vision' });
    expect(runner.payloads[1]).not.toHaveProperty('vision');
  });

  it('runs a glance on its instruction, even when the host gives blank content, and refuses a malformed frame before resolving', async () => {
    const lines: unknown[][] = [];
    const runner = stubRunner(completes, lines);
    const resolved: string[] = [];
    const url = await mount(runner, {
      resolveTurn: (request) => {
        resolved.push(request.kind);
        // As a host that stores and redacts `request.text` does: nothing, for a glance.
        return { conversationId: 'conv-1', userId: 'visitor-1', accountId: 'rooftop-1', socketRoom: 'conversation:conv-1', content: request.text };
      },
    });
    await call(url, GLANCE);
    expect(runner.payloads[0].content).toBe(LIVE_CALL_GLANCE_MESSAGE);
    expect(runner.payloads[0].vision?.frame?.data).toBe(FRAME);

    const bad = await call(url, { ...SPOKEN, turnId: 'turn-bad-frame', client: { vision: { ...seeing(), frame: { ...frame(), data: '%%%%' } } } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('client.vision.frame.data must be standard base64');
    expect(resolved).toEqual(['glance']);
  });

  it('ends a glance the model answers with nothing as done, with no text: silence', async () => {
    const lines: unknown[][] = [];
    const runner = stubRunner(async (p, emit) => {
      // Whitespace is not a remark: nothing is spoken.
      emit(AGENT_SOCKET_EVENTS.TOKEN, { text: ' \n', step: 0 });
      emit(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { endReason: 'complete' });
      return { status: 'completed', turnId: p.turnId, rounds: 1 };
    }, lines);
    const res = await call(await mount(runner), GLANCE);
    expect(res.events).toEqual([{ event: 'done', data: { stopReason: 'complete' } }]);
  });

  it('takes a turn with the page’s UI and a frame at their bounds within its default body size', async () => {
    const lines: unknown[][] = [];
    const runner = stubRunner(completes, lines);
    const big = 'A'.repeat(VISION_LIMITS.frameDataChars - FRAME.length);
    const data = (FRAME.slice(0, -4) + big + FRAME.slice(-4)).slice(0, VISION_LIMITS.frameDataChars);
    const ui = { oui: { notes: 'x'.repeat(LIVE_CALL_LIMITS.clientUiBytes - 200) } };
    const body = { ...SPOKEN, client: { ui, vision: seeing(data) } };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(LIVE_CALL_MAX_BODY_BYTES);
    const res = await call(await mount(runner), body);
    expect(res.status).toBe(200);
    expect(runner.payloads[0].vision?.frame?.data.length).toBe(VISION_LIMITS.frameDataChars);
  });
});

// ─── The real `ai` loop ─────────────────────────────────────────────────────

type PromptPart = { type: string; text?: string; data?: unknown; mediaType?: string };
type PromptMessage = { role: string; content: string | PromptPart[]; providerOptions?: Record<string, unknown> };

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A model that makes these calls, one step each, then answers `answer` (nothing, when empty). Each step's prompt is kept. */
function scripted(calls: Array<{ tool: string; input: Record<string, unknown> }>, answer = 'That is a yellow shirt.') {
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      const next = calls[prompts.length - 1];
      const chunks = next
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${prompts.length}`, toolName: next.tool, input: JSON.stringify(next.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            ...(answer
              ? [
                  { type: 'text-start', id: '0' },
                  { type: 'text-delta', id: '0', delta: answer },
                  { type: 'text-end', id: '0' },
                ]
              : []),
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

const lookup = {
  name: 'inventory_search',
  description: 'Searches the inventory',
  inputSchema: { type: 'object' as const, properties: {} },
  execute: async () => ({ success: true, data: { vehicles: 2 } }),
};

function config(model: unknown, overrides: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry([lookup]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    systemPrompt: 'You are the dealership’s assistant on a live call.',
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.anthropic,
    ...overrides,
  };
}

function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    turnId: 'turn-vision-1',
    conversationId: 'conv-1',
    userId: 'visitor-1',
    accountId: 'rooftop-1',
    socketRoom: 'conversation:conv-1',
    content: 'What am I wearing?',
    history: [{ role: 'user', content: 'What am I wearing?' }],
    vision: readTurnVision(seeing()) as TurnVision,
    ...overrides,
  };
}

const isTail = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('"stepTail":true');
/** A file part's bytes as base64, however the prompt carries them (`{ type: 'data', data }` in a V4 prompt). */
const base64Of = (data: unknown): string => {
  const raw = data && typeof data === 'object' && 'type' in data && (data as { type: unknown }).type === 'data' ? (data as { data: unknown }).data : data;
  return typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('base64');
};
/** Every picture in a prompt, as base64. */
const picturesIn = (prompt: PromptMessage[]) =>
  prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'file').map((p) => base64Of(p.data)) : []));
const textOf = (m: PromptMessage) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n'));

let consoleLines: string[] = [];
beforeEach(() => {
  consoleLines = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the frame, through the real ai loop', () => {
  it('reaches the model as a picture after the conversation’s cache breakpoint, with the vision clause, on every step', async () => {
    const { model, prompts } = scripted([{ tool: 'inventory_search', input: {} }]);
    const emit = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(model, { emit: { emit } }), input());

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      // One picture a step, the frame, in the step's tail: after the conversation and its breakpoint.
      expect(picturesIn(prompt)).toEqual([FRAME]);
      const tail = prompt.at(-1)!;
      expect(isTail(tail)).toBe(true);
      const parts = tail.content as PromptPart[];
      expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/jpeg' });
      expect(textOf(tail)).toContain('<vision>You can see the user through their camera');
      expect(textOf(tail)).toContain('compliment something they are wearing');
      const beforeTail = prompt.at(-2)!;
      expect(JSON.stringify(beforeTail.providerOptions)).toContain('ephemeral');
    }
    // The person's own message is their words alone.
    const message = prompts[0].find((m) => m.role === 'user' && !isTail(m))!;
    expect(textOf(message)).toBe('What am I wearing?');

    // Nowhere else: not an event, not a stored message, not a log line.
    expect(JSON.stringify(emit.mock.calls)).not.toContain(FRAME.slice(0, 12));
    expect(JSON.stringify(result.newMessages)).not.toContain(FRAME.slice(0, 12));
    expect(consoleLines.join('\n')).not.toContain(FRAME.slice(0, 12));
  });

  it('never sends an earlier turn’s frame again: the next turn carries only its own', async () => {
    const first = scripted([]);
    const { runAgentTurn } = await import('../orchestrator.js');
    const turn1 = await runAgentTurn(config(first.model), input());
    expect(picturesIn(first.prompts[0])).toEqual([FRAME]);

    // The host stored the turn's words and reply; the next turn comes with a newer frame.
    const second = scripted([]);
    await runAgentTurn(
      config(second.model),
      input({
        turnId: 'turn-vision-2',
        content: 'And now?',
        history: [
          { role: 'user', content: 'What am I wearing?' },
          ...turn1.newMessages.map((m) => ({ role: 'assistant' as const, content: m.content })),
          { role: 'user', content: 'And now?' },
        ],
        vision: readTurnVision(seeing(FRAME_LATER)) as TurnVision,
      }),
    );
    expect(picturesIn(second.prompts[0])).toEqual([FRAME_LATER]);

    // A turn without vision sends no picture at all.
    const third = scripted([]);
    await runAgentTurn(config(third.model), input({ turnId: 'turn-vision-3', vision: undefined }));
    expect(picturesIn(third.prompts[0])).toEqual([]);
    expect(JSON.stringify(third.prompts[0])).not.toContain('<vision>');
  });

  it('tells the model it cannot see, and why, with no picture, when no frame came', async () => {
    const { model, prompts } = scripted([]);
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(model), input({ vision: readTurnVision({ seeing: false, remarks: false, frame: null, absent: 'turned_off' }) as TurnVision }));
    expect(picturesIn(prompts[0])).toEqual([]);
    expect(textOf(prompts[0].at(-1)!)).toContain('The user has turned off your view of their camera, so you cannot see them right now.');
  });

  it('runs a glance the model answers with nothing as a turn that says and stores nothing', async () => {
    const { model, prompts } = scripted([], '');
    const emit = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    // The host stored the glance as the empty words it carried: read past, and the instruction is the message.
    const result = await runAgentTurn(
      config(model, { emit: { emit } }),
      input({
        turnId: 'turn-glance-1',
        content: LIVE_CALL_GLANCE_MESSAGE,
        history: [{ role: 'user', content: 'Hi there' }, { role: 'assistant', content: 'Hello! How can I help?' }, { role: 'user', content: '' }],
      }),
    );
    const said = prompts[0].filter((m) => !isTail(m));
    expect(said.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(textOf(said.at(-1)!)).toBe(LIVE_CALL_GLANCE_MESSAGE);
    expect(picturesIn(prompts[0])).toEqual([FRAME]);
    expect(result.newMessages).toEqual([]);
    expect(emit.mock.calls.filter(([, event]) => event === AGENT_SOCKET_EVENTS.TOKEN)).toEqual([]);
  });
});

// ─── The providers ──────────────────────────────────────────────────────────

/** An Anthropic Messages stream answering `text`. */
function anthropicStream(text: string): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_vision', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 420, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('the frame on the providers’ wire', () => {
  it('is an Anthropic base64 image block, after the conversation’s cache_control, in the turn’s user message', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = [];
    const anthropic = createAnthropic({
      apiKey: 'fixture-anthropic-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return anthropicStream('That is a yellow shirt.');
      },
    });
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(anthropic('claude-fixture'), { promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.anthropic }), input());
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: 'That is a yellow shirt.' });

    const last = bodies[0].messages.at(-1)!;
    expect(last.role).toBe('user');
    const words = last.content.findIndex((b) => b.type === 'text' && b.text === 'What am I wearing?');
    const image = last.content.findIndex((b) => b.type === 'image');
    expect(words).toBeGreaterThanOrEqual(0);
    expect(last.content[words].cache_control).toEqual({ type: 'ephemeral' });
    expect(image).toBeGreaterThan(words);
    expect(last.content[image]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: FRAME } });
    expect(String(last.content[image + 1].text)).toContain('<vision>');
    expect(bodies[0].messages.filter((m) => JSON.stringify(m).includes(FRAME.slice(0, 12)))).toHaveLength(1);
  });

  it('is a Bedrock image block, after the conversation’s cachePoint, in the turn’s user message', async () => {
    const recording = JSON.parse(
      readFileSync(fileURLToPath(new URL('./fixtures/fixture-turn.bedrock.json', import.meta.url)), 'utf8'),
    ) as FixtureRecording;
    const requests: unknown[] = [];
    const bedrock = createAmazonBedrock({
      region: 'us-east-1',
      credentialProvider: async () => ({ accessKeyId: 'AKIDFIXTUREREPLAY', secretAccessKey: 'fixture-replay-secret' }),
      // The recorded turn's second response is a plain text answer.
      fetch: replayingFetch([recording.exchanges[1]], requests),
    });
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(bedrock(recording.modelId), { promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock }), input());
    expect(result.newMessages.at(-1)?.role).toBe('assistant');

    const sent = requests[0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const last = sent.messages.at(-1)!;
    expect(last.role).toBe('user');
    const cachePoint = last.content.findIndex((b) => 'cachePoint' in b);
    const image = last.content.findIndex((b) => 'image' in b);
    expect(cachePoint).toBeGreaterThan(0);
    expect(image).toBeGreaterThan(cachePoint);
    expect(last.content[image]).toEqual({ image: { format: 'jpeg', source: { bytes: FRAME } } });
    expect(String(last.content[image + 1].text)).toContain('<vision>');
  });
});
