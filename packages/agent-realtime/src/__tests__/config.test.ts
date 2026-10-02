import { describe, it, expect } from 'vitest';
import { createRealtimeServer } from '../server.js';
import type { RealtimeServerConfig } from '../types.js';
import { fixtureRoomPolicy, fixtureRelay, recordingLogger, TEST_APPROVAL_KEY, TEST_TOKEN_SECRET } from './fixtures.js';

/**
 * Every seam is required, and a missing one fails start-up naming it
 * (ADR-0227 §2.2). Nothing here reaches Redis: the check runs first.
 */

const complete: RealtimeServerConfig = {
  auth: { verify: async () => ({ userId: 'u' }) },
  roomPolicy: fixtureRoomPolicy,
  internalApiKey: 'internal-key',
  roomTokens: { secret: TEST_TOKEN_SECRET },
  approvals: { signingKey: TEST_APPROVAL_KEY },
  redis: { host: '127.0.0.1', port: 1, tls: false },
  corsOrigins: ['https://app.example'],
  port: 0,
  relay: fixtureRelay,
  logger: recordingLogger(),
};

function without(path: string): Partial<RealtimeServerConfig> {
  const copy = structuredClone({ ...complete, auth: undefined, roomPolicy: undefined, relay: undefined, logger: undefined }) as Record<
    string,
    unknown
  >;
  Object.assign(copy, { auth: complete.auth, roomPolicy: complete.roomPolicy, relay: complete.relay, logger: complete.logger });
  const [head, tail] = path.split('.');
  if (tail) delete (copy[head] as Record<string, unknown>)[tail];
  else delete copy[head];
  return copy as Partial<RealtimeServerConfig>;
}

describe('required configuration', () => {
  for (const seam of [
    'auth',
    'roomPolicy',
    'internalApiKey',
    'roomTokens',
    'roomTokens.secret',
    'approvals',
    'approvals.signingKey',
    'redis',
    'redis.host',
    'redis.port',
    'redis.tls',
    'corsOrigins',
    'port',
  ]) {
    it(`refuses to start without ${seam}, naming it`, async () => {
      const named = { roomTokens: 'roomTokens.secret', approvals: 'approvals.signingKey', redis: 'redis.host' }[seam] ?? seam;
      await expect(createRealtimeServer(without(seam) as RealtimeServerConfig)).rejects.toThrow(
        new RegExp(`Missing required configuration: .*${named.replace('.', '\\.')}`),
      );
    });
  }

  it('names every missing seam at once', async () => {
    await expect(createRealtimeServer({} as RealtimeServerConfig)).rejects.toThrow(
      /auth .*roomPolicy .*internalApiKey .*roomTokens\.secret .*approvals\.signingKey .*redis\.host .*corsOrigins .*port/,
    );
  });

  it('refuses a room policy missing a method, a short token secret, and the internal key reused as the token secret', async () => {
    const { requiresToken: _omit, ...partialPolicy } = fixtureRoomPolicy;
    await expect(createRealtimeServer({ ...complete, roomPolicy: partialPolicy as never })).rejects.toThrow(/roomPolicy/);
    await expect(createRealtimeServer({ ...complete, roomTokens: { secret: 'short' } })).rejects.toThrow(/roomTokens\.secret/);
    await expect(
      createRealtimeServer({ ...complete, internalApiKey: TEST_TOKEN_SECRET, roomTokens: { secret: TEST_TOKEN_SECRET } }),
    ).rejects.toThrow(/separate secrets/);
  });

  it('refuses a short approval key, and one that is the internal key or the room-token secret', async () => {
    await expect(createRealtimeServer({ ...complete, approvals: { signingKey: 'short' } })).rejects.toThrow(/approvals\.signingKey/);
    for (const reused of [complete.internalApiKey.padEnd(40, '!'), TEST_TOKEN_SECRET]) {
      const config = { ...complete, internalApiKey: reused === TEST_TOKEN_SECRET ? complete.internalApiKey : reused, approvals: { signingKey: reused } };
      await expect(createRealtimeServer(config)).rejects.toThrow(/approvals\.signingKey must be neither/);
    }
  });

  it('refuses a relay rule without a room prefix or data schema', async () => {
    await expect(
      createRealtimeServer({ ...complete, relay: { 'x:y': { roomPrefix: '', data: fixtureRelay['avatar:frame-reselect'].data } } }),
    ).rejects.toThrow(/relay\["x:y"\]/);
  });

  it('fails start-up, naming Redis, when Redis is unreachable', async () => {
    await expect(createRealtimeServer(complete)).rejects.toThrow(/Redis at 127\.0\.0\.1:1 is unreachable/);
  });
});
