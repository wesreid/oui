#!/usr/bin/env node
/**
 * Writes receipt-vectors.json: approval receipts, the keys they were signed
 * with, and the result every verifier must give for each.
 *
 *   node scripts/receipt-vectors.mjs           write the file
 *   node scripts/receipt-vectors.mjs --check   exit 1 if the file is not what this writes
 *
 * Independent of the package's own code: it signs with `node:crypto` directly
 * (Ed25519 signatures are deterministic, so the output is the same on every
 * run), hashes the arguments from a canonical form written out by hand, and
 * fixes every time. The keys are derived from published seeds: they are test
 * keys, and signing anything real with them proves nothing.
 */
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'receipt-vectors.json');

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json = (value) => b64url(Buffer.from(JSON.stringify(value), 'utf8'));
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** An Ed25519 key from a published seed: PKCS#8 is a fixed prefix followed by the 32-byte seed. */
function testKey(kid) {
  const seed = crypto.createHash('sha256').update(`oui approval receipt test vector key: ${kid}`).digest();
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, d: jwk.d } };
}

const active = testKey('receipt-2026-10');
const previous = testKey('receipt-2026-07');
const removed = testKey('receipt-2026-04');
const stranger = testKey('another-environment');

const NOW = 1_793_145_600; // 2026-10-27T00:00:00Z, epoch seconds
const ISS = 'https://realtime.example.com';
const AUD = 'https://api.example.com';

// The approved call's arguments, and their RFC 8785 canonical form written out by hand.
const ARGS = { vehicleId: 'VIN-1HGCM82633A004352', slot: '2026-10-28T15:30:00-04:00', customer: { phone: '+15555550142', name: 'Ana Souza' } };
const CANONICAL = '{"customer":{"name":"Ana Souza","phone":"+15555550142"},"slot":"2026-10-28T15:30:00-04:00","vehicleId":"VIN-1HGCM82633A004352"}';
const ARGS_HASH = sha256Hex(CANONICAL);
const OTHER_ARGS_HASH = sha256Hex('{"customer":{"name":"Ana Souza","phone":"+15555550142"},"slot":"2026-10-29T09:00:00-04:00","vehicleId":"VIN-1HGCM82633A004352"}');

const header = (kid, extra = {}) => ({ alg: 'EdDSA', typ: 'oui-approval-receipt+jwt', kid, ...extra });

/** Claims in the order the realtime server writes them. */
function claims(overrides = {}) {
  const iat = overrides.iat ?? NOW - 5;
  const base = {
    iss: ISS,
    aud: AUD,
    approvalId: 'toolu_01JBK7Q4R8M2V6X9',
    argsHash: ARGS_HASH,
    tool: 'bookings_create',
    operationId: 'bookings_create',
    conversationId: 'conv_7f3a9c',
    userId: 'user_42',
    accountId: 'acct_dealer_17',
    channel: 'voice',
    iat,
    exp: iat + 120,
    jti: 'f5b8e7c2-4d1a-4e9b-9c3f-2a6d8e0b1c47',
  };
  const out = {};
  for (const key of Object.keys(base)) {
    if (key in overrides && overrides[key] === undefined) continue;
    out[key] = key in overrides ? overrides[key] : base[key];
  }
  if (overrides.iat !== undefined && !('exp' in overrides)) out.exp = overrides.iat + 120;
  for (const key of Object.keys(overrides)) if (!(key in base)) out[key] = overrides[key];
  return out;
}

function sign(key, h, payloadSegment) {
  const input = `${json(h)}.${payloadSegment}`;
  return `${input}.${b64url(crypto.sign(null, Buffer.from(input), key.privateKey))}`;
}
const signed = (key, c, h = header(key.kid)) => sign(key, h, json(c));

const valid = claims();
const validToken = signed(active, valid);
const [vh, vp, vs] = validToken.split('.');
const minimal = claims({ operationId: undefined, accountId: undefined, channel: 'ui', tool: 'confirm_booking', jti: '0b6c3c1e-8f0a-4d5e-a2b7-9e1f4c6d8a20' });
const edge = claims({ iat: NOW - 179, jti: '3e9d2f4a-6b1c-4a8e-b5d7-1c0f9e2a4b68' });
const late = claims({ iat: NOW - 180, jti: '9a1c7e5b-2d4f-4b6a-8e0c-5f3d1b7a9c24' });
const early = claims({ iat: NOW + 61, jti: '6d4b2a8e-1f7c-4e3a-9b5d-0c8e2f6a4d19' });

const hs256Input = `${json({ alg: 'HS256', typ: 'oui-approval-receipt+jwt', kid: active.kid })}.${json(valid)}`;
const hs256 = `${hs256Input}.${b64url(crypto.createHmac('sha256', Buffer.from(active.jwk.x, 'base64url')).update(hs256Input).digest())}`;

const ok = (c) => ({ ok: true, claims: c });
const no = (reason) => ({ ok: false, reason });

const vectors = [
  { name: 'valid: signed by the active key, every claim', receipt: validToken, result: ok(valid) },
  { name: 'valid: no optional claims (no operationId, no accountId), approved in a UI', receipt: signed(active, minimal), result: ok(minimal) },
  { name: 'valid: signed by the previous key, which is still published', receipt: signed(previous, claims({ jti: '7c2e9b4d-5a1f-4c8e-b3d6-2e0a9f7c1b85' })), result: ok(claims({ jti: '7c2e9b4d-5a1f-4c8e-b3d6-2e0a9f7c1b85' })) },
  { name: 'valid: expired 59 s ago, within the clock skew', receipt: signed(active, edge), result: ok(edge) },
  { name: 'expired: 60 s past exp, beyond the clock skew', receipt: signed(active, late), result: no('expired') },
  { name: 'expired: issued 61 s in the future, beyond the clock skew', receipt: signed(active, early), result: no('expired') },
  { name: 'key: signed by a key that has been removed', receipt: signed(removed, valid), result: no('key') },
  { name: 'signature: names the active key, signed by another', receipt: signed(stranger, valid, header(active.kid)), result: no('signature') },
  { name: 'signature: claims changed under the real signature', receipt: `${vh}.${json({ ...valid, argsHash: OTHER_ARGS_HASH })}.${vs}`, result: no('signature') },
  { name: 'signature: signature truncated', receipt: `${vh}.${vp}.${vs.slice(0, 43)}`, result: no('signature') },
  { name: 'malformed: typ is JWT', receipt: signed(active, valid, { alg: 'EdDSA', typ: 'JWT', kid: active.kid }), result: no('malformed') },
  { name: 'malformed: alg is HS256, keyed with the public key', receipt: hs256, result: no('malformed') },
  { name: 'malformed: alg is none, with no signature', receipt: `${json({ alg: 'none', typ: 'oui-approval-receipt+jwt', kid: active.kid })}.${json(valid)}.`, result: no('malformed') },
  { name: 'malformed: no kid', receipt: signed(active, valid, { alg: 'EdDSA', typ: 'oui-approval-receipt+jwt' }), result: no('malformed') },
  { name: 'malformed: the header names critical extensions', receipt: signed(active, valid, header(active.kid, { crit: ['exp'] })), result: no('malformed') },
  { name: 'malformed: not three segments', receipt: `${vh}.${vp}`, result: no('malformed') },
  { name: 'malformed: validly signed, claims not JSON', receipt: sign(active, header(active.kid), b64url(Buffer.from('not json'))), result: no('malformed') },
  { name: 'malformed: validly signed, approvalId missing', receipt: signed(active, claims({ approvalId: undefined })), result: no('malformed') },
  { name: 'malformed: validly signed, a claim a receipt does not define', receipt: signed(active, claims({ scope: 'bookings:write' })), result: no('malformed') },
  { name: 'audience: issued for another API', receipt: signed(active, claims({ aud: 'https://api.other.example' })), result: no('audience') },
  { name: 'args: issued for other arguments', receipt: signed(active, claims({ argsHash: OTHER_ARGS_HASH })), result: no('args') },
];

const file = {
  version: 1,
  description:
    'Approval receipts and the result every verifier must give for each. Verify each `receipt` against `jwks`, with `audience` as the tool\'s audience, `expectedArgsHash` as the hash of the request it received, and `now` (epoch seconds) as the time. A refusal must give `result.reason`; a receipt that verifies must give exactly `result.claims`. `signingKeys` holds every key the receipts were signed with, private parts included: a signer that writes the header and claims in the order shown must reproduce each valid receipt byte for byte.',
  provenance:
    'Written by packages/agent-core/scripts/receipt-vectors.mjs with node:crypto alone: Ed25519 signatures are deterministic, the arguments are hashed from their canonical form as written below, and every time is fixed. The keys come from published seeds and sign nothing real.',
  now: NOW,
  audience: AUD,
  args: ARGS,
  canonicalArgs: CANONICAL,
  expectedArgsHash: ARGS_HASH,
  jwks: {
    keys: [active, previous].map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.jwk.x, kid: k.kid, alg: 'EdDSA', use: 'sig' })),
  },
  signingKeys: [active, previous, removed, stranger].map((k) => k.jwk),
  vectors,
};

const text = `${JSON.stringify(file, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    // Missing is as stale as wrong.
  }
  if (current !== text) {
    console.error('receipt-vectors.json is not what scripts/receipt-vectors.mjs writes. Run: node scripts/receipt-vectors.mjs');
    process.exit(1);
  }
  console.log('receipt-vectors.json is current');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
