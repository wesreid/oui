/**
 * Required configuration is required (ADR-0227 §2.2, W7): a missing value
 * fails when the adapter is created — at start-up, before any turn — and the
 * error names it. Nothing falls back to an environment variable or ''.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { createLambdaAgentHandler } from '../lambda/handler.js';
import { startContainerAgentWorker } from '../container/server.js';
import { createAgentTurnRunner, categorizeError, payloadRefusal } from '../runtime/turn-runner.js';
import { createHttpEmitAdapter } from '../emit/http-adapter.js';
import { createHttpUIActionChannel } from '../ui/channel.js';
import type { AgentRuntimeConfig } from '../runtime/types.js';

const complete: AgentRuntimeConfig<object> = {
  model: 'provider/model-id',
  realtime: { url: 'http://127.0.0.1:1', apiKey: 'realtime-key' },
  systemPrompt: () => 'You help.',
  tools: [],
  getDb: async () => ({}),
  getHistory: async () => [],
  persistMessages: async () => {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};

function without(path: string): AgentRuntimeConfig<object> {
  const copy: Record<string, unknown> = { ...complete, realtime: { ...complete.realtime } };
  const [head, tail] = path.split('.');
  if (tail) delete (copy[head] as Record<string, unknown>)[tail];
  else delete copy[head];
  return copy as unknown as AgentRuntimeConfig<object>;
}

describe('the runtime refuses to start without a required value, naming it', () => {
  const cases: Array<[string, string]> = [
    ['model', 'model'],
    ['realtime', 'realtime.url'],
    ['realtime.url', 'realtime.url'],
    ['realtime.apiKey', 'realtime.apiKey'],
    ['systemPrompt', 'persona or systemPrompt'],
    ['tools', 'tools'],
    ['getDb', 'getDb'],
    ['getHistory', 'getHistory'],
    ['persistMessages', 'persistMessages'],
  ];
  for (const [removed, named] of cases) {
    it(`without ${removed}, on the Lambda adapter and the container adapter`, async () => {
      const pattern = new RegExp(`Missing required configuration: .*${named.replace('.', '\\.')}`);
      expect(() => createLambdaAgentHandler(without(removed))).toThrow(pattern);
      await expect(startContainerAgentWorker({ ...without(removed), port: 0, workerApiKey: 'k' })).rejects.toThrow(pattern);
    });
  }

  it('an empty realtime URL or key, the old silent fallback, is missing', () => {
    expect(() => createAgentTurnRunner({ ...complete, realtime: { url: '', apiKey: '' } })).toThrow(/realtime\.url.*realtime\.apiKey/);
  });

  it('both persona and systemPrompt is refused: the identity has one source', () => {
    expect(() =>
      createAgentTurnRunner({ ...complete, persona: { name: 'A', identity: 'You are A.' } as never }),
    ).toThrow(/persona or systemPrompt/);
  });

  it('names every missing value at once', () => {
    expect(() => createAgentTurnRunner({} as AgentRuntimeConfig<object>)).toThrow(
      /model .*realtime\.url .*realtime\.apiKey .*persona or systemPrompt .*tools .*getDb .*getHistory .*persistMessages/,
    );
  });

  it('the container adapter also needs its port and its key', async () => {
    await expect(startContainerAgentWorker({ ...complete, port: 0, workerApiKey: '' })).rejects.toThrow(/workerApiKey/);
    await expect(startContainerAgentWorker({ ...complete, workerApiKey: 'k' } as never)).rejects.toThrow(/port/);
  });

  it('the realtime adapters refuse a missing URL or key when created, not on first use', () => {
    expect(() => createHttpEmitAdapter({ url: '', apiKey: 'k' })).toThrow(/realtime\.url/);
    expect(() => createHttpUIActionChannel({ url: 'http://x', apiKey: '' })).toThrow(/realtime\.apiKey/);
  });
});

describe('a turn payload', () => {
  it('is refused when a field the turn needs is missing', () => {
    expect(payloadRefusal(null)).toMatch(/object/);
    expect(payloadRefusal({ turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', content: 'hi' })).toMatch(/socketRoom/);
    expect(payloadRefusal({ turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'hi', context: 'x' })).toMatch(
      /context/,
    );
    expect(payloadRefusal({ turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: '' })).toBeNull();
  });
});

describe('model errors, from any provider', () => {
  const apiError = (statusCode: number) =>
    new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider', requestBodyValues: {}, statusCode });

  it('sorts a provider rate limit or outage as recoverable, and names no provider', () => {
    expect(categorizeError(apiError(429))).toEqual({ code: 'RATE_LIMIT', message: 'The model provider is rate-limiting requests', recoverable: true });
    expect(categorizeError(apiError(529)).code).toBe('SERVICE_UNAVAILABLE');
    expect(categorizeError(new RetryError({ message: 'retries', reason: 'maxRetriesExceeded', errors: [apiError(503)] })).code).toBe(
      'SERVICE_UNAVAILABLE',
    );
    expect(categorizeError(new Error('ThrottlingException: Too many requests')).recoverable).toBe(true);
  });

  it('sorts anything else as a worker error, which is not retried', () => {
    expect(categorizeError(new Error('boom'))).toEqual({ code: 'WORKER_ERROR', message: 'boom', recoverable: false });
    expect(categorizeError(new Error('Turn deadline exceeded')).code).toBe('TURN_TIMEOUT');
  });
});

describe('the container adapter', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function start(overrides: Partial<Parameters<typeof startContainerAgentWorker>[0]> = {}) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const worker = await startContainerAgentWorker({
      ...complete,
      // A turn that holds until the test lets it go, and fails without a model call.
      getDb: async () => {
        await gate;
        throw new Error('fixture: no database');
      },
      port: 0,
      workerApiKey: 'worker-key',
      maxConcurrentTurns: 1,
      ...overrides,
    });
    close = async () => {
      release();
      await worker.close();
    };
    const post = (body: unknown, key = 'worker-key') =>
      fetch(`http://127.0.0.1:${worker.port}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    return { worker, post, release };
  }

  const turn = (turnId: string) => ({ turnId, conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: `chat:turn:${turnId}`, content: 'hi' });

  it('refuses a wrong key, a body that is not a turn, a second copy of a running turn, and a turn past capacity', async () => {
    const { post, worker } = await start();
    expect((await post(turn('t1'), 'wrong')).status).toBe(401);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ turnId: 't1' })).status).toBe(400);
    expect((await post(turn('t1'))).status).toBe(202);
    expect(worker.running()).toBe(1);
    expect((await post(turn('t1'))).status).toBe(409);
    expect((await post(turn('t2'))).status).toBe(503);
  });

  it('reports its health, and waits for running turns when it closes', async () => {
    const outcomes: string[] = [];
    const { post, worker, release } = await start({ onTurnEnd: (o) => outcomes.push(o.status) });
    const health = await (await fetch(`http://127.0.0.1:${worker.port}/health`)).json();
    expect(health).toEqual({ status: 'ok', running: 0, capacity: 1, model: 'provider/model-id' });
    expect((await post(turn('t3'))).status).toBe(202);
    const closing = worker.close();
    release();
    await closing;
    close = null;
    // The turn's own failure (its database) is an outcome, reported, not lost.
    expect(outcomes).toEqual(['failed']);
    expect(worker.running()).toBe(0);
  });
});
