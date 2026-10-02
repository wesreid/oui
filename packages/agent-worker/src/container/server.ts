/**
 * The container host adapter: a long-running HTTP server that takes turns.
 *
 * The host's API POSTs a turn to `/turns` with the worker's key; the worker
 * answers `202` once the turn is accepted and runs it, streaming to the
 * realtime server as the Lambda adapter does. The same runtime core runs it
 * (runtime/turn-runner.ts), so a turn behaves the same on either host.
 *
 *   POST /turns    AgentTurnPayload → 202 { turnId }
 *                  400 not a turn · 401 wrong key · 409 turn already running
 *                  503 at capacity or shutting down (retry later)
 *   GET  /health   200 { status, running, capacity, model }
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createAgentTurnRunner, payloadRefusal, type TurnOutcome } from '../runtime/turn-runner.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../runtime/types.js';

export interface ContainerAgentConfig<TDb> extends AgentRuntimeConfig<TDb> {
  /** The port to listen on. `0` picks a free one. Required. */
  port: number;
  /** The key the host's API sends as `x-api-key`. Required: the endpoint runs turns as any user. */
  workerApiKey: string;
  /** Turns run at once; more are refused with 503. Default 8. */
  maxConcurrentTurns?: number;
  /** Largest request body, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Called with each turn's outcome, after it ends. */
  onTurnEnd?: (outcome: TurnOutcome) => void;
}

export interface ContainerAgentWorker {
  /** The port the server listens on (the one picked, when configured with 0). */
  port: number;
  /** Turns running now. */
  running(): number;
  /** Stops taking turns, waits for the running ones to end, then closes. */
  close(): Promise<void>;
}

export async function startContainerAgentWorker<TDb>(config: ContainerAgentConfig<TDb>): Promise<ContainerAgentWorker> {
  const missing = [
    !(Number.isInteger(config?.port) && config.port >= 0) && 'port (the port to listen on, 0 for any free port)',
    !(typeof config?.workerApiKey === 'string' && config.workerApiKey.length > 0) && 'workerApiKey (the key the host sends as x-api-key)',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`[agent-sdk] Missing required configuration: ${missing.join('; ')}`);

  const runner = createAgentTurnRunner(config);
  const capacity = config.maxConcurrentTurns ?? 8;
  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;
  const expectedKey = crypto.createHash('sha256').update(config.workerApiKey).digest();
  const isKey = (presented: unknown) =>
    typeof presented === 'string' &&
    presented.length > 0 &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), expectedKey);

  const inFlight = new Map<string, Promise<void>>();
  let closing = false;

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      send(res, closing ? 503 : 200, { status: closing ? 'closing' : 'ok', running: inFlight.size, capacity, model: runner.model });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/turns') {
      send(res, 404, { error: 'not found' });
      return;
    }
    if (!isKey(req.headers['x-api-key'])) {
      send(res, 401, { error: 'Invalid or missing API key' });
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        send(res, 413, { error: `body larger than ${maxBodyBytes} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let payload: AgentTurnPayload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AgentTurnPayload;
      } catch {
        send(res, 400, { error: 'body is not JSON' });
        return;
      }
      const refusal = payloadRefusal(payload);
      if (refusal) {
        send(res, 400, { error: refusal });
        return;
      }
      if (inFlight.has(payload.turnId)) {
        send(res, 409, { error: `turn ${payload.turnId} is already running` });
        return;
      }
      if (closing || inFlight.size >= capacity) {
        send(res, 503, { error: closing ? 'shutting down' : 'at capacity' });
        return;
      }

      const run = runner
        .run(payload)
        .then((outcome) => config.onTurnEnd?.(outcome))
        .catch((err: unknown) => {
          // A turn's own failure is an outcome, not a throw; this is the
          // runtime failing around it (getDb, say). Nothing retries a
          // container turn, so it is logged where the host will see it.
          runner.logger.error('[agent-sdk] Turn could not run', {
            turnId: payload.turnId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => inFlight.delete(payload.turnId));
      inFlight.set(payload.turnId, run);
      send(res, 202, { turnId: payload.turnId });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    running: () => inFlight.size,
    async close() {
      closing = true;
      await Promise.allSettled([...inFlight.values()]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
