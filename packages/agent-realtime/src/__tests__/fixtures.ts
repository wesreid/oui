/**
 * A fixture product's seams: the room scheme studio-realtime uses, expressed
 * through the neutral `RoomPolicy`, so the ported studio-realtime tests assert
 * the same behaviour on the SDK server.
 */
import Joi from 'joi';
import { PLATFORM_EVENTS, createEventCatalog, type EventDeclarationDocument } from '@ouispec/agent-events';
import type { AuthResult, RelayRule, RoomPolicy } from '../types.js';
import type { RealtimeLogger } from '../logger.js';

const ROOM = /^(account|user|generation|avatar|session|project):[a-zA-Z0-9_-]+$|^agent:(turn|conversation):[a-zA-Z0-9_-]+$|^(fleet|global)$/;
const TOKEN_ROOM = /^(generation|avatar|session|project):|^agent:/;

export const fixtureRoomPolicy: RoomPolicy = {
  isValidRoom: (room) => ROOM.test(room),
  identityRooms: (user) => [`user:${user.userId}`, ...(user.accountId ? [`account:${user.accountId}`] : [])],
  requiresToken: (room) => TOKEN_ROOM.test(room),
  canJoin(room, user: AuthResult) {
    if (room === 'global') return true;
    if (room === 'fleet') return !!user.platformAdmin;
    if (room.startsWith('user:')) return room === `user:${user.userId}`;
    if (room.startsWith('account:')) return !!user.accountId && room === `account:${user.accountId}`;
    return false;
  },
};

export const fixtureRelay: Record<string, RelayRule> = {
  'avatar:frame-reselect': {
    roomPrefix: 'avatar',
    data: Joi.object({
      event: Joi.string().valid('started', 'uploading', 'uploaded', 'updating-db', 'prewarming', 'completed', 'error').required(),
      message: Joi.string().max(500),
    }),
  },
};

export const TEST_TOKEN_SECRET = 'test-secret-for-room-tokens-32chars!!';
export const TEST_APPROVAL_KEY = 'test-key-for-approval-tokens-32chars!!';

export interface LoggedRecord {
  level: string;
  data: Record<string, unknown>;
  msg: string;
}

/** A logger that keeps what it is given, for assertions on refusals. */
export function recordingLogger(): RealtimeLogger & { records: LoggedRecord[] } {
  const records: LoggedRecord[] = [];
  const at = (level: string) => (data: Record<string, unknown>, msg: string) => {
    records.push({ level, data, msg });
  };
  return { records, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * Redis with SET NX/EX, GET and pub/sub, shared by every "instance" created
 * from it — as two realtime tasks share one Redis.
 */
export function createMemoryRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const subscribers: Array<{ channels: Set<string>; listeners: Array<(c: string, m: string) => void> }> = [];

  const client = {
    async set(key: string, value: string, _ex: 'EX', ttl: number, _nx: 'NX'): Promise<'OK' | null> {
      if (data.has(key)) return null;
      data.set(key, value);
      ttls.set(key, ttl);
      return 'OK';
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async publish(channel: string, message: string) {
      let n = 0;
      for (const s of subscribers) {
        if (!s.channels.has(channel)) continue;
        n++;
        // Delivery is asynchronous in Redis too.
        queueMicrotask(() => s.listeners.forEach((l) => l(channel, message)));
      }
      return n;
    },
  };

  function subscriber() {
    const s = { channels: new Set<string>(), listeners: [] as Array<(c: string, m: string) => void> };
    subscribers.push(s);
    return {
      async subscribe(channel: string) {
        s.channels.add(channel);
      },
      on(_event: 'message', listener: (c: string, m: string) => void) {
        s.listeners.push(listener);
      },
    };
  }

  return { client, subscriber, data, ttls };
}

/**
 * The fixture product's event declarations (W9): a render job that completes
 * or fails, its progress, and the one event a tab may relay.
 */
export const fixtureEvents: EventDeclarationDocument = {
  version: 1,
  product: 'fixture-studio',
  rooms: {
    user: { pattern: 'user:{userId}' },
    account: { pattern: 'account:{accountId}' },
    generation: { pattern: 'generation:{jobId}' },
    avatar: { pattern: 'avatar:{avatarId}' },
  },
  events: {
    'render:done': {
      description: 'A render finished.',
      payload: {
        type: 'object',
        properties: { jobId: { type: 'string' }, url: { type: ['string', 'null'] } },
        required: ['jobId', 'url'],
      },
      rooms: ['generation', 'user'],
      correlation: ['jobId'],
      role: 'completion',
      completes: 'render',
      result: ['url'],
    },
    'render:failed': {
      description: 'A render failed.',
      payload: { type: 'object', properties: { jobId: { type: 'string' }, error: { type: 'string' } }, required: ['jobId'] },
      rooms: ['generation', 'user'],
      correlation: ['jobId'],
      role: 'failure',
      completes: 'render',
      reason: { field: 'error', fallback: 'Render failed' },
    },
    'render:progress': {
      description: 'A render is running.',
      payload: { type: 'object', properties: { jobId: { type: 'string' }, progress: { type: 'number' } }, required: ['jobId'] },
      rooms: ['generation'],
      correlation: ['jobId'],
      role: 'progress',
    },
    'avatar:frame-reselect': {
      description: 'Frame-reselection progress, relayed between tabs on one character.',
      payload: {
        type: 'object',
        properties: {
          event: { enum: ['started', 'uploading', 'uploaded', 'updating-db', 'prewarming', 'completed', 'error'] },
          message: { type: 'string', maxLength: 500 },
        },
        required: ['event'],
        additionalProperties: false,
      },
      rooms: ['avatar'],
      correlation: [],
      role: 'notice',
    },
  },
};

export const fixtureCatalog = createEventCatalog(PLATFORM_EVENTS, fixtureEvents);
