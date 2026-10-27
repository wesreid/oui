/**
 * The receipt signer: it reproduces every valid published vector byte for
 * byte from its keys and claims, publishes only public key parts, and refuses
 * a key set or claims that are not a receipt's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { verifyApprovalReceipt, type ApprovalReceiptClaims } from '@ouispec/agent-core';
import {
  approvalReceiptKeysProblem,
  createApprovalReceiptSigner,
  generateApprovalReceiptKey,
  receiptIssuer,
  type ApprovalReceiptKey,
} from '../approvals/receipt.js';

interface VectorFile {
  now: number;
  audience: string;
  expectedArgsHash: string;
  signingKeys: ApprovalReceiptKey[];
  vectors: Array<{ name: string; receipt: string; result: { ok: true; claims: ApprovalReceiptClaims } | { ok: false; reason: string } }>;
}
const file = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@ouispec/agent-core/receipt-vectors.json'), 'utf8')) as VectorFile;
const kidOf = (jws: string) => (JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString()) as { kid: string }).kid;

describe('the published receipt vectors', () => {
  const valid = file.vectors.filter((v) => v.result.ok);
  it('include valid receipts of more than one key', () => {
    expect(new Set(valid.map((v) => kidOf(v.receipt))).size).toBeGreaterThan(1);
  });

  it.each(valid.map((v) => [v.name, v] as const))('%s: reproduced byte for byte', (_name, vector) => {
    const claims = (vector.result as { claims: ApprovalReceiptClaims }).claims;
    const kid = kidOf(vector.receipt);
    const signer = createApprovalReceiptSigner({
      keys: file.signingKeys.map((k) => ({ ...k, active: k.kid === kid })),
      issuer: claims.iss,
    });
    expect(signer.signClaims(claims)).toBe(vector.receipt);
  });
});

describe('a signer', () => {
  const active = generateApprovalReceiptKey({ kid: 'k-active', active: true });
  const other = generateApprovalReceiptKey({ kid: 'k-other' });
  const signer = createApprovalReceiptSigner({ keys: [other, active], issuer: 'https://realtime.example.com/' });
  const subject = {
    aud: 'https://api.example.com',
    approvalId: 'toolu_1',
    argsHash: file.expectedArgsHash,
    tool: 'bookings_create',
    conversationId: 'conv-1',
    userId: 'u1',
    channel: 'phone' as const,
  };

  it('issues a receipt for 120 s, signed by the active key, under its issuer without a trailing slash', async () => {
    const now = Date.UTC(2026, 9, 27, 12);
    const issued = signer.issue(subject, now);
    expect(issued.kid).toBe('k-active');
    expect(issued.exp).toBe(now / 1000 + 120);
    const verified = await verifyApprovalReceipt(issued.receipt, { jwks: signer.jwks(), audience: subject.aud, expectedArgsHash: subject.argsHash, now });
    expect(verified).toEqual({ ok: true, claims: { iss: 'https://realtime.example.com', ...subject, iat: now / 1000, exp: now / 1000 + 120, jti: issued.jti } });
  });

  it('publishes the active key first and nothing private', () => {
    expect(signer.jwks()).toEqual({
      keys: [
        { kty: 'OKP', crv: 'Ed25519', x: active.x, kid: 'k-active', alg: 'EdDSA', use: 'sig' },
        { kty: 'OKP', crv: 'Ed25519', x: other.x, kid: 'k-other', alg: 'EdDSA', use: 'sig' },
      ],
    });
  });

  it('refuses claims that are not a receipt’s, another issuer’s, or an audience that is not an origin', () => {
    expect(() => signer.issue({ ...subject, aud: 'https://api.example.com/v1' })).toThrow(/not an origin/);
    expect(() => signer.issue({ ...subject, channel: 'fax' as never })).toThrow(/channel/);
    expect(() => signer.signClaims({ ...subject, iss: 'https://elsewhere.example', iat: 1, exp: 121, jti: 'j' })).toThrow(/another issuer/);
  });

  it('refuses an issuer that is not a base URL', () => {
    expect(() => createApprovalReceiptSigner({ keys: [active], issuer: 'realtime.example.com' })).toThrow(/receiptIssuer/);
  });
});

describe('the receipt issuer', () => {
  it('is an absolute http(s) base URL, path kept, trailing slash dropped', () => {
    expect(receiptIssuer('https://realtime.example.com')).toBe('https://realtime.example.com');
    expect(receiptIssuer('https://realtime.example.com/')).toBe('https://realtime.example.com');
    expect(receiptIssuer('https://example.com/realtime/')).toBe('https://example.com/realtime');
    for (const bad of ['', 'realtime.example.com', 'wss://realtime.example.com', 'https://realtime.example.com/?x=1', 'https://u:p@realtime.example.com', 42]) {
      expect(receiptIssuer(bad), String(bad)).toBeNull();
    }
  });
});

describe('a receipt key set', () => {
  const a = generateApprovalReceiptKey({ kid: 'a', active: true });
  const b = generateApprovalReceiptKey({ kid: 'b' });
  it('is a non-empty list of Ed25519 keys with their own public parts, unique ids, and exactly one active', () => {
    expect(approvalReceiptKeysProblem([a, b])).toBeNull();
    expect(approvalReceiptKeysProblem([a, { ...b, team: 'platform', createdAt: '2026-10-27T00:00:00Z' }])).toBeNull();
    const cases: Array<[unknown, RegExp]> = [
      [[], /non-empty list/],
      [{ keys: [a] }, /non-empty list/],
      [[b], /exactly one key must be active, and 0 are/],
      [[a, { ...b, active: true }], /exactly one key must be active, and 2 are/],
      [[a, { ...b, kid: 'a' }], /listed twice/],
      [[{ ...a, kid: '' }], /no kid/],
      [[{ ...a, crv: 'X25519' }], /not an Ed25519 key/],
      [[{ ...a, kty: 'EC' }], /not an Ed25519 key/],
      [[{ ...a, alg: 'ES256' }], /alg ES256/],
      [[{ ...a, use: 'enc' }], /not for signing/],
      [[{ ...a, d: undefined }], /no private key/],
      [[{ ...a, x: 'abc' }], /no public key/],
      [[{ ...a, x: b.x }], /not its private key/],
      [[{ ...a, active: 'yes' }], /active must be true or false/],
    ];
    for (const [keys, problem] of cases) expect(approvalReceiptKeysProblem(keys), String(problem)).toMatch(problem);
  });

  it('generated with a random id unless one is given, and active only when asked', () => {
    const k = generateApprovalReceiptKey();
    expect(k.kid).toMatch(/^[0-9a-f-]{36}$/);
    expect(k).not.toHaveProperty('active');
    expect(approvalReceiptKeysProblem([{ ...k, active: true }])).toBeNull();
  });
});
