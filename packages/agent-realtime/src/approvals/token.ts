/**
 * The approval token (ADR-0228 §2.3): a compact JWS, HS256, signed with the
 * environment's approval key. It is ADR-0210's `commit_token`: an engine in
 * another language verifies it with the same key.
 *
 * Only the approval store signs one, and only when the approval's own user
 * decided it. A token proves that decision; the store's record (single use,
 * the stored call) is what redemption checks it against.
 */
import crypto from 'node:crypto';
import { APPROVAL_CHANNELS, ARGS_HASH_PATTERN, type ApprovalTokenClaims } from '@ouispec/agent-core';

export const MIN_APPROVAL_KEY_LENGTH = 32;

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export type ApprovalTokenCheck = { ok: true; claims: ApprovalTokenClaims } | { ok: false; reason: 'invalid' | 'expired'; error: string };

export interface ApprovalTokenSigner {
  sign(claims: ApprovalTokenClaims): string;
  /** The claims of a token this key signed, still unexpired; otherwise why not. */
  verify(token: string, nowMs?: number): ApprovalTokenCheck;
}

const STRING_CLAIMS = ['aid', 'sub', 'cid', 'tool', 'eff', 'jti'] as const;

function claimsProblem(c: Record<string, unknown>): string | null {
  for (const k of STRING_CLAIMS) if (typeof c[k] !== 'string' || !c[k]) return `claim ${k} is missing`;
  if (typeof c.ah !== 'string' || !ARGS_HASH_PATTERN.test(c.ah)) return 'claim ah is not an args hash';
  if (!APPROVAL_CHANNELS.includes(c.ch as never)) return 'claim ch is not a channel';
  for (const k of ['iat', 'exp'] as const) if (!Number.isInteger(c[k])) return `claim ${k} is not a time`;
  return null;
}

export function createApprovalTokenSigner(options: { signingKey: string }): ApprovalTokenSigner {
  const { signingKey } = options;
  if (typeof signingKey !== 'string' || signingKey.length < MIN_APPROVAL_KEY_LENGTH) {
    throw new Error(
      `[agent-sdk-realtime] approvals.signingKey must be at least ${MIN_APPROVAL_KEY_LENGTH} characters: it signs every approval token`,
    );
  }
  const mac = (input: string) => crypto.createHmac('sha256', signingKey).update(input).digest();

  return {
    sign(claims) {
      const problem = claimsProblem(claims as unknown as Record<string, unknown>);
      if (problem) throw new Error(`[agent-sdk-realtime] Cannot sign an approval token: ${problem}`);
      const signingInput = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      return `${signingInput}.${mac(signingInput).toString('base64url')}`;
    },

    verify(token, nowMs = Date.now()) {
      const invalid = (error: string) => ({ ok: false as const, reason: 'invalid' as const, error });
      if (typeof token !== 'string') return invalid('not a token');
      const parts = token.split('.');
      if (parts.length !== 3) return invalid('not a compact JWS');
      const [header, payload, signature] = parts;
      // Only this header: no `alg` a token could choose for itself, `none` included.
      if (header !== HEADER) return invalid('not an HS256 approval token');
      const presented = Buffer.from(signature, 'base64url');
      const expected = mac(`${header}.${payload}`);
      if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return invalid('bad signature');
      let claims: Record<string, unknown>;
      try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      } catch {
        return invalid('unreadable claims');
      }
      const problem = claimsProblem(claims);
      if (problem) return invalid(problem);
      if (nowMs >= (claims.exp as number) * 1000) return { ok: false, reason: 'expired', error: 'the approval has expired' };
      return { ok: true, claims: claims as unknown as ApprovalTokenClaims };
    },
  };
}
