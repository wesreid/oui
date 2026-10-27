/**
 * The approval receipt verifier, held to the published vectors in the
 * server and browser builds, and its reading of the realtime server's key set
 * from a URL: cached for the response's max-age, read again for an unknown key
 * id at most once a minute, and refused with `key` when it cannot be read.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  APPROVAL_RECEIPT_JWKS_REFETCH_MS,
  APPROVAL_RECEIPT_REFUSAL_REASONS,
  approvalReceiptAudience,
  approvalReceiptClaimsProblem,
  verifyApprovalReceipt,
  type ApprovalReceiptJwks,
  type ApprovalReceiptVerification,
} from '../receipt.js';
import { argsHash, canonicalJson } from '../args-hash.js';
import * as browserEntry from '../../browser.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface VectorFile {
  version: number;
  now: number;
  audience: string;
  args: Record<string, unknown>;
  canonicalArgs: string;
  expectedArgsHash: string;
  jwks: ApprovalReceiptJwks;
  signingKeys: Array<{ kty: 'OKP'; crv: 'Ed25519'; kid: string; x: string; d: string }>;
  vectors: Array<{ name: string; receipt: string; result: { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string } }>;
}

const file = JSON.parse(readFileSync(join(PKG, 'receipt-vectors.json'), 'utf8')) as VectorFile;
const at = file.now * 1000;
const options = { jwks: file.jwks, audience: file.audience, expectedArgsHash: file.expectedArgsHash, now: at };
const byName = (name: string) => {
  const v = file.vectors.find((x) => x.name.startsWith(name));
  if (!v) throw new Error(`no vector ${name}`);
  return v;
};
const reasonOf = (r: ApprovalReceiptVerification) => (r.ok ? 'ok' : r.reason);

describe('the published receipt vectors', () => {
  it('are exactly what their generator writes', () => {
    expect(() => execFileSync(process.execPath, [join(PKG, 'scripts', 'receipt-vectors.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('bind the arguments the published args hash is over', async () => {
    expect(canonicalJson(file.args)).toBe(file.canonicalArgs);
    expect(await argsHash(file.args)).toBe(file.expectedArgsHash);
  });

  it('cover every reason, rotation, the clock skew and the algorithms a verifier must refuse', () => {
    const reasons = new Set(file.vectors.map((v) => (v.result.ok ? 'ok' : v.result.reason)));
    for (const reason of ['ok', ...APPROVAL_RECEIPT_REFUSAL_REASONS]) expect(reasons, reason).toContain(reason);
    const names = file.vectors.map((v) => v.name).join(' | ');
    for (const topic of ['previous key', 'removed', 'clock skew', 'HS256', 'none', 'typ', 'critical']) expect(names).toContain(topic);
  });

  describe.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    it('gives the published result, on the server and in the browser build', async () => {
      for (const verify of [verifyApprovalReceipt, browserEntry.verifyApprovalReceipt]) {
        const result = await verify(vector.receipt, options);
        if (vector.result.ok) {
          expect(result).toEqual({ ok: true, claims: vector.result.claims });
        } else {
          expect(result.ok).toBe(false);
          expect(reasonOf(result)).toBe(vector.result.reason);
          if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
        }
      }
    });
  });
});

describe('the audience', () => {
  it('is the origin a URL names, with nothing past it', () => {
    expect(approvalReceiptAudience('https://api.example.com')).toBe('https://api.example.com');
    expect(approvalReceiptAudience('https://api.example.com/')).toBe('https://api.example.com');
    expect(approvalReceiptAudience('https://API.Example.com:443')).toBe('https://api.example.com');
    expect(approvalReceiptAudience('http://localhost:8080')).toBe('http://localhost:8080');
    for (const bad of ['https://api.example.com/v1', 'https://api.example.com?x=1', 'ftp://api.example.com', 'api.example.com', '', 'https://u:p@api.example.com']) {
      expect(approvalReceiptAudience(bad), bad).toBeNull();
    }
  });

  it('is compared as an origin: the tool may name its own with a trailing slash', async () => {
    const valid = byName('valid: signed by the active key');
    expect((await verifyApprovalReceipt(valid.receipt, { ...options, audience: `${file.audience}/` })).ok).toBe(true);
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...options, audience: 'https://api.example.com:8443' }))).toBe('audience');
  });
});

describe('the claims rule the signer and the verifier share', () => {
  const claims = (byName('valid: signed by the active key').result as { claims: Record<string, unknown> }).claims;
  it('accepts a receipt’s claims and names what is wrong with anything else', () => {
    expect(approvalReceiptClaimsProblem(claims)).toBeNull();
    expect(approvalReceiptClaimsProblem({ ...claims, channel: 'fax' })).toMatch(/channel/);
    expect(approvalReceiptClaimsProblem({ ...claims, exp: claims.iat })).toMatch(/exp/);
    expect(approvalReceiptClaimsProblem({ ...claims, accountId: '' })).toMatch(/accountId/);
    expect(approvalReceiptClaimsProblem({ ...claims, argsHash: 'abc' })).toMatch(/argsHash/);
    expect(approvalReceiptClaimsProblem([])).toMatch(/not an object/);
  });
});

describe('a key set the verifier is given', () => {
  const valid = byName('valid: signed by the active key');
  it('ignores keys of another kind, and uses neither of two keys published under one id', async () => {
    const [activeKey] = file.jwks.keys;
    const withRsa = { keys: [{ kty: 'RSA', kid: activeKey.kid, n: 'AQAB', e: 'AQAB' }, activeKey] } as unknown as ApprovalReceiptJwks;
    expect((await verifyApprovalReceipt(valid.receipt, { ...options, jwks: withRsa })).ok).toBe(true);
    const doubled = { keys: [activeKey, { ...file.jwks.keys[1], kid: activeKey.kid }] };
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...options, jwks: doubled }))).toBe('key');
    const forEncryption = { keys: [{ ...activeKey, use: 'enc' }] } as unknown as ApprovalReceiptJwks;
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...options, jwks: forEncryption }))).toBe('key');
  });

  it('is refused as a key set when it is not one', async () => {
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...options, jwks: {} as ApprovalReceiptJwks }))).toBe('key');
  });
});

describe('a key set read from the realtime server’s URL', () => {
  const valid = byName('valid: signed by the active key');
  const previous = byName('valid: signed by the previous key');
  const activeOnly: ApprovalReceiptJwks = { keys: [file.jwks.keys[0]] };

  /** A fake realtime server: serves whatever key set it holds now, and counts its reads. */
  function server(initial: ApprovalReceiptJwks, cacheControl = 'public, max-age=3600') {
    const state = { jwks: initial, reads: 0, fail: false as false | 'network' | 500 };
    const fetchImpl = (async () => {
      state.reads++;
      if (state.fail === 'network') throw new TypeError('fetch failed');
      if (state.fail === 500) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(state.jwks), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': cacheControl } });
    }) as typeof fetch;
    // Each test its own URL: the cache is keyed by it.
    const url = `https://realtime-${crypto.randomUUID()}.example.com/.well-known/oui-approval-jwks.json`;
    return { state, url, fetchImpl };
  }

  it('reads it once and serves later receipts from the cache until its max-age', async () => {
    const s = server(file.jwks);
    const opts = { ...options, jwks: s.url, fetch: s.fetchImpl };
    expect((await verifyApprovalReceipt(valid.receipt, opts)).ok).toBe(true);
    expect((await verifyApprovalReceipt(previous.receipt, { ...opts, now: at + 1_000 })).ok).toBe(true);
    expect(s.state.reads).toBe(1);
    // Past max-age it reads again (the receipt itself has long expired by then).
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...opts, now: at + 3_600_000 }))).toBe('expired');
    expect(s.state.reads).toBe(2);
  });

  it('reads concurrent first uses once', async () => {
    const s = server(file.jwks);
    const opts = { ...options, jwks: new URL(s.url), fetch: s.fetchImpl };
    const results = await Promise.all([valid, previous, valid].map((v) => verifyApprovalReceipt(v.receipt, opts)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(s.state.reads).toBe(1);
  });

  it('reads it again for a key id it lacks, at most once a minute (rotation: a key published after the last read)', async () => {
    const s = server(activeOnly);
    const opts = { ...options, jwks: s.url, fetch: s.fetchImpl };
    expect((await verifyApprovalReceipt(valid.receipt, opts)).ok).toBe(true);
    // The server now publishes the other key too; within the minute the cache is kept.
    s.state.jwks = file.jwks;
    expect(reasonOf(await verifyApprovalReceipt(previous.receipt, { ...opts, now: at + 30_000 }))).toBe('key');
    expect(s.state.reads).toBe(1);
    expect((await verifyApprovalReceipt(previous.receipt, { ...opts, now: at + APPROVAL_RECEIPT_JWKS_REFETCH_MS }))).toMatchObject({ ok: true });
    expect(s.state.reads).toBe(2);
    // An id nobody publishes reads at most once a minute too.
    const removed = byName('key: signed by a key that has been removed');
    for (const dt of [61_000, 70_000, 90_000]) await verifyApprovalReceipt(removed.receipt, { ...opts, now: at + APPROVAL_RECEIPT_JWKS_REFETCH_MS + dt });
    expect(s.state.reads).toBe(3);
  });

  it('refuses a receipt of a key once the server stops publishing it (rotation: the old key removed)', async () => {
    const s = server(file.jwks, 'public, max-age=60');
    const opts = { ...options, jwks: s.url, fetch: s.fetchImpl };
    expect((await verifyApprovalReceipt(previous.receipt, opts)).ok).toBe(true);
    s.state.jwks = activeOnly;
    const later = { ...opts, now: at + 61_000 };
    expect(reasonOf(await verifyApprovalReceipt(previous.receipt, later))).toBe('key');
    expect((await verifyApprovalReceipt(valid.receipt, later)).ok).toBe(true);
  });

  it('refuses with key when the key set cannot be read, and never uses keys past their max-age', async () => {
    const down = server(file.jwks);
    down.state.fail = 'network';
    expect(await verifyApprovalReceipt(valid.receipt, { ...options, jwks: down.url, fetch: down.fetchImpl })).toMatchObject({ ok: false, reason: 'key' });

    const erroring = server(file.jwks);
    erroring.state.fail = 500;
    expect(await verifyApprovalReceipt(valid.receipt, { ...options, jwks: erroring.url, fetch: erroring.fetchImpl })).toMatchObject({
      ok: false,
      reason: 'key',
      error: expect.stringContaining('HTTP 500'),
    });

    const stale = server(file.jwks);
    const opts = { ...options, jwks: stale.url, fetch: stale.fetchImpl };
    expect((await verifyApprovalReceipt(valid.receipt, opts)).ok).toBe(true);
    stale.state.fail = 'network';
    expect(reasonOf(await verifyApprovalReceipt(valid.receipt, { ...opts, now: at + 3_600_000 }))).toBe('key');
  });

  it('reads again every time when the server says not to cache', async () => {
    const s = server(file.jwks, 'no-store');
    const opts = { ...options, jwks: s.url, fetch: s.fetchImpl };
    await verifyApprovalReceipt(valid.receipt, opts);
    await verifyApprovalReceipt(valid.receipt, opts);
    expect(s.state.reads).toBe(2);
  });

  it('checks the header before it reads any key', async () => {
    const s = server(file.jwks);
    const hs = byName('malformed: alg is HS256');
    expect(reasonOf(await verifyApprovalReceipt(hs.receipt, { ...options, jwks: s.url, fetch: s.fetchImpl }))).toBe('malformed');
    expect(s.state.reads).toBe(0);
  });
});
