/**
 * Room tokens: a signed statement that one user may join one room, until a
 * time. HMAC-SHA256 over the JSON payload, `base64url(payload + "." + hexsig)`.
 *
 * The server signs a token only when the product's API asks for it
 * (`POST /internal/room-token`, internal key), and the product asks only after
 * its own authorization accepted the user for that resource. The server
 * checks the token on join, against the joining socket's verified identity.
 */
import crypto from 'node:crypto';

export interface RoomTokenPayload {
  userId: string;
  room: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export interface RoomTokenSigner {
  sign(userId: string, room: string): string;
  /** The payload of a valid, unexpired token, or null for anything else. */
  verify(token: string): RoomTokenPayload | null;
  readonly ttlMs: number;
}

export const DEFAULT_ROOM_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MIN_ROOM_TOKEN_SECRET_LENGTH = 32;

export function createRoomTokenSigner(options: { secret: string; ttlMs?: number }): RoomTokenSigner {
  const { secret } = options;
  if (typeof secret !== 'string' || secret.length < MIN_ROOM_TOKEN_SECRET_LENGTH) {
    throw new Error(
      `[agent-sdk-realtime] roomTokens.secret must be at least ${MIN_ROOM_TOKEN_SECRET_LENGTH} characters: it signs every room token`,
    );
  }
  const ttlMs = options.ttlMs ?? DEFAULT_ROOM_TOKEN_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('[agent-sdk-realtime] roomTokens.ttlMs must be a positive number');

  const hmac = (payload: string) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return {
    ttlMs,

    sign(userId, room) {
      const payload = JSON.stringify({ userId, room, exp: Date.now() + ttlMs } satisfies RoomTokenPayload);
      return Buffer.from(`${payload}.${hmac(payload)}`).toString('base64url');
    },

    verify(token) {
      try {
        const decoded = Buffer.from(token, 'base64url').toString('utf-8');
        const dot = decoded.lastIndexOf('.');
        if (dot === -1) return null;
        const payloadStr = decoded.slice(0, dot);
        const sig = decoded.slice(dot + 1);
        const expected = hmac(payloadStr);
        // Constant-time: both are hex strings of one length when valid.
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return null;
        }
        const payload = JSON.parse(payloadStr) as RoomTokenPayload;
        if (typeof payload.userId !== 'string' || typeof payload.room !== 'string' || typeof payload.exp !== 'number') {
          return null;
        }
        if (Date.now() > payload.exp) return null;
        return payload;
      } catch {
        return null;
      }
    },
  };
}
