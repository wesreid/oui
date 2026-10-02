import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createRoomTokenSigner } from '../rooms/room-token.js';
import { joinRefusal } from '../rooms/join.js';
import { fixtureRoomPolicy, TEST_TOKEN_SECRET } from './fixtures.js';

/** Ported from studio-realtime `src/__tests__/room-token.test.ts`, on the configured signer. */

const signer = createRoomTokenSigner({ secret: TEST_TOKEN_SECRET });
const { sign: signRoomToken, verify: verifyRoomToken } = signer;

describe('room tokens', () => {
  const userId = 'user-abc-123';
  const turnRoom = 'agent:turn:turn-def-456';
  const convoRoom = 'agent:conversation:conv-ghi-789';

  describe('sign + verify round-trip', () => {
    it('signs and verifies a token for an agent:turn room', () => {
      const result = verifyRoomToken(signRoomToken(userId, turnRoom));
      expect(result).not.toBeNull();
      expect(result!.userId).toBe(userId);
      expect(result!.room).toBe(turnRoom);
      expect(result!.exp).toBeGreaterThan(Date.now());
    });

    it('signs and verifies a token for an agent:conversation room', () => {
      const result = verifyRoomToken(signRoomToken(userId, convoRoom));
      expect(result!.userId).toBe(userId);
      expect(result!.room).toBe(convoRoom);
    });

    it('produces a base64url-encoded string', () => {
      expect(signRoomToken(userId, turnRoom)).toMatch(/^[A-Za-z0-9_=-]+$/);
    });
  });

  describe('rejection cases', () => {
    it('rejects a completely invalid token', () => {
      expect(verifyRoomToken('garbage')).toBeNull();
      expect(verifyRoomToken('')).toBeNull();
      expect(verifyRoomToken('   ')).toBeNull();
    });

    it('rejects a tampered token (flipped last chars)', () => {
      const token = signRoomToken(userId, turnRoom);
      expect(verifyRoomToken(token.slice(0, -4) + 'ZZZZ')).toBeNull();
    });

    function reforge(token: string, change: (p: Record<string, unknown>) => void): string {
      const decoded = Buffer.from(token, 'base64url').toString('utf-8');
      const dot = decoded.lastIndexOf('.');
      const payload = JSON.parse(decoded.slice(0, dot));
      change(payload);
      return Buffer.from(`${JSON.stringify(payload)}.${decoded.slice(dot + 1)}`).toString('base64url');
    }

    it('rejects a token with a modified payload (different room)', () => {
      const forged = reforge(signRoomToken(userId, turnRoom), (p) => (p.room = 'agent:turn:different-room'));
      expect(verifyRoomToken(forged)).toBeNull();
    });

    it('rejects a token with a modified payload (different user)', () => {
      const forged = reforge(signRoomToken(userId, turnRoom), (p) => (p.userId = 'attacker-user'));
      expect(verifyRoomToken(forged)).toBeNull();
    });

    it('rejects a token with a modified payload (later expiry)', () => {
      const forged = reforge(signRoomToken(userId, turnRoom), (p) => (p.exp = Date.now() + 10 * 365 * 86_400_000));
      expect(verifyRoomToken(forged)).toBeNull();
    });

    it('rejects a token with no dot separator', () => {
      const noDot = Buffer.from('{"userId":"u","room":"r","exp":9999999999999}nosig').toString('base64url');
      expect(verifyRoomToken(noDot)).toBeNull();
    });

    it('rejects a token where payload is not valid JSON', () => {
      expect(verifyRoomToken(Buffer.from('not-json.abcdef1234').toString('base64url'))).toBeNull();
    });

    it('rejects a token signed with another secret', () => {
      const other = createRoomTokenSigner({ secret: 'a-different-secret-that-is-32-chars-long' });
      expect(verifyRoomToken(other.sign(userId, turnRoom))).toBeNull();
    });
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('token is valid immediately after signing, for 15 minutes by default', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const result = verifyRoomToken(signRoomToken(userId, turnRoom));
      expect(result!.exp).toBe(now + 15 * 60 * 1000);
    });

    it('token is valid 14 minutes after signing', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const token = signRoomToken(userId, turnRoom);
      vi.setSystemTime(now + 14 * 60 * 1000);
      expect(verifyRoomToken(token)).not.toBeNull();
    });

    it('token is rejected after 15 minutes (expired)', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const token = signRoomToken(userId, turnRoom);
      vi.setSystemTime(now + 15 * 60 * 1000 + 1);
      expect(verifyRoomToken(token)).toBeNull();
    });

    it('honours a configured lifetime', () => {
      const short = createRoomTokenSigner({ secret: TEST_TOKEN_SECRET, ttlMs: 1000 });
      const now = Date.now();
      vi.setSystemTime(now);
      const token = short.sign(userId, turnRoom);
      vi.setSystemTime(now + 1001);
      expect(short.verify(token)).toBeNull();
    });
  });

  describe('binding to user and room, as the join check applies it', () => {
    it('different users get different tokens for the same room', () => {
      const t1 = signRoomToken('user-1', turnRoom);
      const t2 = signRoomToken('user-2', turnRoom);
      expect(t1).not.toBe(t2);
      expect(verifyRoomToken(t1)!.userId).toBe('user-1');
      expect(verifyRoomToken(t2)!.userId).toBe('user-2');
    });

    it("a valid token for user-1 does not admit user-2", () => {
      const token = signRoomToken('user-1', turnRoom);
      expect(joinRefusal(fixtureRoomPolicy, signer, turnRoom, { userId: 'user-1' }, token)).toBeNull();
      expect(joinRefusal(fixtureRoomPolicy, signer, turnRoom, { userId: 'user-2' }, token)).toMatch(/another user/);
    });

    it('a token for room A does not admit room B, nor agent:conversation:X for agent:turn:X', () => {
      const token = signRoomToken(userId, 'agent:turn:same-id');
      expect(joinRefusal(fixtureRoomPolicy, signer, 'agent:turn:other', { userId }, token)).toMatch(/another room/);
      expect(joinRefusal(fixtureRoomPolicy, signer, 'agent:conversation:same-id', { userId }, token)).toMatch(/another room/);
    });
  });

  describe('HMAC integrity', () => {
    it('uses HMAC-SHA256, and the signature matches one computed independently', () => {
      const token = signRoomToken(userId, turnRoom);
      const decoded = Buffer.from(token, 'base64url').toString('utf-8');
      const dot = decoded.lastIndexOf('.');
      const sig = decoded.slice(dot + 1);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
      expect(sig).toBe(crypto.createHmac('sha256', TEST_TOKEN_SECRET).update(decoded.slice(0, dot)).digest('hex'));
    });
  });

  describe('configuration', () => {
    it('refuses a missing or short secret', () => {
      expect(() => createRoomTokenSigner({ secret: '' })).toThrow(/at least 32 characters/);
      expect(() => createRoomTokenSigner({ secret: 'short' })).toThrow(/at least 32 characters/);
    });
  });
});
