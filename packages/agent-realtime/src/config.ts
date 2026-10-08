import { UndeclaredEventError } from '@ouispec/agent-events';
import type { RealtimeServerConfig } from './types.js';
import { MIN_ROOM_TOKEN_SECRET_LENGTH } from './rooms/room-token.js';
import { MIN_APPROVAL_KEY_LENGTH } from './approvals/token.js';

/**
 * Every seam the server cannot run without, and what it is for. A missing
 * one fails start-up with this text: a default here would silently run some
 * other product's value (ADR-0227 §2.2).
 */
const REQUIRED: ReadonlyArray<[string, (c: Partial<RealtimeServerConfig>) => boolean, string]> = [
  ['auth', (c) => typeof c.auth?.verify === 'function', "an AuthAdapter that verifies your users' tokens"],
  [
    'roomPolicy',
    (c) =>
      !!c.roomPolicy &&
      (['isValidRoom', 'identityRooms', 'requiresToken', 'canJoin'] as const).every((m) => typeof c.roomPolicy?.[m] === 'function'),
    'a RoomPolicy (isValidRoom, identityRooms, requiresToken, canJoin)',
  ],
  ['internalApiKey', (c) => typeof c.internalApiKey === 'string' && c.internalApiKey.length > 0, 'the key that guards the internal endpoints'],
  [
    'roomTokens.secret',
    (c) => typeof c.roomTokens?.secret === 'string' && c.roomTokens.secret.length >= MIN_ROOM_TOKEN_SECRET_LENGTH,
    `the room-token signing secret, at least ${MIN_ROOM_TOKEN_SECRET_LENGTH} characters`,
  ],
  [
    'approvals.signingKey',
    (c) => typeof c.approvals?.signingKey === 'string' && c.approvals.signingKey.length >= MIN_APPROVAL_KEY_LENGTH,
    `the approval-token signing key, at least ${MIN_APPROVAL_KEY_LENGTH} characters`,
  ],
  ['redis.host', (c) => typeof c.redis?.host === 'string' && c.redis.host.length > 0, 'where UI action results and room fan-out meet'],
  ['redis.port', (c) => Number.isInteger(c.redis?.port) && (c.redis?.port ?? 0) > 0, 'the Redis port'],
  ['redis.tls', (c) => typeof c.redis?.tls === 'boolean', 'whether Redis is reached over TLS'],
  [
    'corsOrigins',
    (c) => Array.isArray(c.corsOrigins) && c.corsOrigins.length > 0 && c.corsOrigins.every((o) => typeof o === 'string' && o),
    "the browser origins allowed to connect (['*'] only deliberately)",
  ],
  ['port', (c) => Number.isInteger(c.port) && (c.port ?? -1) >= 0, 'the port to listen on (0 for any free port)'],
];

/** Throws, naming every missing or malformed seam, unless the configuration is complete. */
export function assertRealtimeServerConfig(config: Partial<RealtimeServerConfig>): asserts config is RealtimeServerConfig {
  const missing = REQUIRED.filter(([, ok]) => !ok(config ?? {})).map(([name, , what]) => `${name} (${what})`);
  if (missing.length > 0) {
    throw new Error(`[agent-sdk-realtime] Missing required configuration: ${missing.join('; ')}`);
  }
  if (config.internalApiKey === config.roomTokens?.secret) {
    throw new Error('[agent-sdk-realtime] roomTokens.secret must not be the internalApiKey: they are separate secrets');
  }
  const { approvals, roomTokens, internalApiKey } = config as RealtimeServerConfig;
  if (approvals.signingKey === internalApiKey || approvals.signingKey === roomTokens.secret) {
    throw new Error(
      '[agent-sdk-realtime] approvals.signingKey must be neither the internalApiKey nor roomTokens.secret: they are separate secrets',
    );
  }
  for (const [event, rule] of Object.entries(config.relay ?? {})) {
    if (config.events) {
      assertRelayable(config.events, event);
      if (rule?.data !== undefined && typeof rule.data.validate !== 'function') {
        throw new Error(`[agent-sdk-realtime] relay["${event}"].data must be a schema with validate()`);
      }
    } else if (!rule?.roomPrefix || typeof rule.data?.validate !== 'function') {
      throw new Error(`[agent-sdk-realtime] relay["${event}"] needs a roomPrefix and a data schema`);
    }
  }
}

/**
 * A client may relay only a declared notice that goes to the product's own
 * rooms. A completion or failure relayed by a tab would forge a job's end, a
 * progress event its state, and a turn's events belong to the worker.
 */
function assertRelayable(events: NonNullable<RealtimeServerConfig['events']>, name: string): void {
  let declared;
  try {
    declared = events.require(name, `relay["${name}"]`);
  } catch (err) {
    if (err instanceof UndeclaredEventError) throw new Error(err.message.replace('[agent-sdk-events]', '[agent-sdk-realtime]'), { cause: err });
    throw err;
  }
  if (declared.role !== 'notice') {
    throw new Error(
      `[agent-sdk-realtime] relay["${name}"]: a ${declared.role} event is sent only by the server; a client may relay only a notice`,
    );
  }
  const hostNamed = declared.rooms.find((r) => r.pattern === null);
  if (hostNamed) {
    throw new Error(`[agent-sdk-realtime] relay["${name}"]: it goes to a ${hostNamed.name}'s room, which only the server sends to`);
  }
}
