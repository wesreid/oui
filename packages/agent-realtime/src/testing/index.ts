/**
 * @ouispec/agent-realtime/testing — what a product's tests need to
 * run the real server: a Redis to meet in.
 *
 * `REDIS_URL` names one (CI runs a Redis service); otherwise a private
 * `redis-server` is started on a free port and stopped afterwards. Neither
 * available is an error, never a skipped test: the server cannot run without
 * Redis, so neither can a test of it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { RedisConfig } from '../types.js';

export interface TestRedis {
  config: RedisConfig;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function startTestRedis(): Promise<TestRedis> {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    const config: RedisConfig = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      tls: parsed.protocol === 'rediss:',
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
    if (!(await reachable(config.host, config.port, 2_000))) {
      throw new Error(`REDIS_URL names ${config.host}:${config.port}, which is not reachable`);
    }
    return { config, stop: async () => {} };
  }

  const port = await freePort();
  let child: ChildProcess;
  try {
    child = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore',
    });
  } catch (err) {
    throw new Error(`No REDIS_URL, and redis-server could not be started: ${String(err)}`, { cause: err });
  }
  const spawnError = new Promise<never>((_, reject) =>
    child.once('error', (err) => reject(new Error(`No REDIS_URL, and redis-server could not be started: ${err.message}`))),
  );
  const deadline = Date.now() + 5_000;
  const ready = (async () => {
    while (Date.now() < deadline) {
      if (await reachable('127.0.0.1', port, 200)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`redis-server on port ${port} did not accept connections within 5 s`);
  })();
  try {
    await Promise.race([ready, spawnError]);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  return {
    config: { host: '127.0.0.1', port, tls: false },
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
