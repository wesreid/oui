import type { ApprovalReceiptClaims } from '@ouispec/contract';
import { APPROVAL_CHANNELS } from './types.js';

/**
 * The approval receipt: what the tool's own API checks to know that the call
 * it received is one a person approved.
 *
 * When the realtime server redeems an approval token it signs a receipt, a
 * compact JWS over Ed25519 with a key only it holds, and the worker carries it
 * on the approved call (`OUI-Approval-Receipt`). The tool holds only the
 * public keys, published at `<iss>/.well-known/oui-approval-jwks.json`, so it
 * can verify a receipt and never make one. The receipt names the one API it is
 * for (`aud`), the call's args hash, and lasts 120 seconds; its `jti` is the
 * call's idempotency key, which the tool acts on at most once.
 *
 * `verifyApprovalReceipt` is the same in Node and in the browser build: it
 * runs on WebCrypto. `@ouispec/agent-core/receipt-vectors.json` holds every
 * other implementation, in any language, to the results it gives.
 */

/** The receipt's JWS `typ`. A verifier accepts no other. */
export const APPROVAL_RECEIPT_TYP = 'oui-approval-receipt+jwt';
/** The receipt's JWS `alg`: EdDSA over Ed25519. A verifier accepts no other, and never `none`. */
export const APPROVAL_RECEIPT_ALG = 'EdDSA';
/** The request header an approved call carries its receipt in. */
export const APPROVAL_RECEIPT_HEADER = 'OUI-Approval-Receipt';
/** Where, under the realtime server's public base URL (`iss`), its receipt keys are published. */
export const APPROVAL_RECEIPT_JWKS_PATH = '/.well-known/oui-approval-jwks.json';
/** How long a receipt lasts: the request that runs right after redemption, and one retry. */
export const APPROVAL_RECEIPT_TTL_SEC = 120;
/** The clock skew a verifier allows on `iat` and `exp`. */
export const APPROVAL_RECEIPT_CLOCK_SKEW_SEC = 60;
/** How long the published keys may be cached (`Cache-Control: public, max-age=3600`). */
export const APPROVAL_RECEIPT_JWKS_MAX_AGE_SEC = 3600;
/** A verifier that meets a key id it does not know fetches the keys again, at most this often. */
export const APPROVAL_RECEIPT_JWKS_REFETCH_MS = 60_000;

/**
 * Why a receipt was refused, in the order the verifier checks:
 *
 * - `malformed`: not a compact JWS; a header that is not exactly EdDSA with
 *   this `typ` and a `kid`, or that names `crit`; or claims that are not a
 *   receipt's.
 * - `key`: no published key has its `kid` (a removed key, or another
 *   environment's), or the keys could not be read.
 * - `signature`: the signature is not that key's over this header and these claims.
 * - `expired`: past `exp`, or issued in the future, beyond the clock skew.
 * - `audience`: issued for another API.
 * - `args`: issued for other arguments than the request carries.
 */
export type ApprovalReceiptRefusalReason = 'malformed' | 'key' | 'signature' | 'expired' | 'audience' | 'args';

export const APPROVAL_RECEIPT_REFUSAL_REASONS: readonly ApprovalReceiptRefusalReason[] = [
  'malformed',
  'key',
  'signature',
  'expired',
  'audience',
  'args',
];

/** One published receipt key: an Ed25519 public key as a JWK. */
export interface ApprovalReceiptPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  /** The public key, base64url. */
  x: string;
  kid: string;
  alg?: 'EdDSA';
  use?: 'sig';
}

/** The realtime server's published receipt keys. */
export interface ApprovalReceiptJwks {
  keys: ApprovalReceiptPublicJwk[];
}

export type ApprovalReceiptVerification =
  | { ok: true; claims: ApprovalReceiptClaims }
  | { ok: false; reason: ApprovalReceiptRefusalReason; error: string };

export interface VerifyApprovalReceiptOptions {
  /**
   * The realtime server's published keys: the JWKS document, or its URL
   * (`<iss>/.well-known/oui-approval-jwks.json`). Given a URL, the keys are
   * fetched, cached for the response's `max-age`, and fetched again when a
   * receipt names a key id they lack, at most once a minute.
   */
  jwks: ApprovalReceiptJwks | string | URL;
  /**
   * `argsHash` of the call as the tool received it. For a generated API tool:
   * one object holding every path, query and body parameter by its declared
   * name; for an operation whose input is its body, that body.
   */
  expectedArgsHash: string;
  /** The tool's own origin (scheme, host and port), which the receipt must name as `aud`. */
  audience: string;
  /** The time to check against, epoch ms. Default: now. */
  now?: number;
  /** The fetch the keys are read with, when `jwks` is a URL. Default: the global fetch. */
  fetch?: typeof fetch;
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const ARGS_HASH = /^[0-9a-f]{64}$/;

/** base64url → bytes, without padding, on any runtime. */
export function base64UrlToBytes(value: string): Uint8Array {
  if (!B64URL.test(value) || value.length % 4 === 1) throw new TypeError('not base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** bytes → base64url, without padding, on any runtime. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The origin an audience names: scheme, host and port, as `URL.origin` writes
 * it. One rule for the worker that names an API's audience, the store that
 * fixes it, and the verifier that compares it. Null when it is not an
 * absolute http(s) URL with nothing past its origin but a `/`.
 */
export function approvalReceiptAudience(value: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return url.origin;
}

const REQUIRED_STRINGS = ['iss', 'aud', 'approvalId', 'tool', 'conversationId', 'userId', 'jti'] as const;
const OPTIONAL_STRINGS = ['operationId', 'accountId'] as const;
const KNOWN_CLAIMS = new Set<string>([...REQUIRED_STRINGS, ...OPTIONAL_STRINGS, 'argsHash', 'channel', 'iat', 'exp']);

/**
 * What is wrong with a receipt's claims, or null: every required claim of the
 * right type, no claim it does not define. The signer and the verifier hold a
 * receipt to this one rule.
 */
export function approvalReceiptClaimsProblem(claims: unknown): string | null {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return 'the claims are not an object';
  const c = claims as Record<string, unknown>;
  for (const k of REQUIRED_STRINGS) if (typeof c[k] !== 'string' || !c[k]) return `claim ${k} is missing`;
  for (const k of OPTIONAL_STRINGS) if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k])) return `claim ${k} is not a string`;
  if (typeof c.argsHash !== 'string' || !ARGS_HASH.test(c.argsHash)) return 'claim argsHash is not an args hash';
  if (!APPROVAL_CHANNELS.includes(c.channel as never)) return 'claim channel is not a channel';
  for (const k of ['iat', 'exp'] as const) if (!Number.isSafeInteger(c[k])) return `claim ${k} is not a time`;
  if ((c.exp as number) <= (c.iat as number)) return 'claim exp is not after iat';
  for (const k of Object.keys(c)) if (!KNOWN_CLAIMS.has(k)) return `claim ${k} is not a receipt's`;
  return null;
}

/** The members of a JWK a receipt key is published with: never `d`. */
export function publicReceiptJwk(jwk: { kty?: unknown; crv?: unknown; x?: unknown; kid?: unknown }): ApprovalReceiptPublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', x: String(jwk.x), kid: String(jwk.kid), alg: 'EdDSA', use: 'sig' };
}

/** Whether a JWK is a receipt verification key: Ed25519, a 32-byte public key, a key id, and no other algorithm or use. */
function isReceiptKey(jwk: unknown): jwk is ApprovalReceiptPublicJwk {
  if (!jwk || typeof jwk !== 'object') return false;
  const k = jwk as Record<string, unknown>;
  if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.kid !== 'string' || !k.kid || typeof k.x !== 'string') return false;
  if (k.alg !== undefined && k.alg !== APPROVAL_RECEIPT_ALG) return false;
  if (k.use !== undefined && k.use !== 'sig') return false;
  try {
    return base64UrlToBytes(k.x).length === 32;
  } catch {
    return false;
  }
}

/**
 * WebCrypto: global in browsers and Node 19+; Node 18 has it only on
 * `node:crypto`, imported here by a specifier bundlers leave alone.
 */
async function subtleCrypto(): Promise<SubtleCrypto> {
  const global = globalThis.crypto?.subtle;
  if (global) return global;
  const nodeCrypto = 'node:crypto';
  try {
    const mod = (await import(/* @vite-ignore */ nodeCrypto)) as { webcrypto?: { subtle?: SubtleCrypto } };
    if (mod.webcrypto?.subtle) return mod.webcrypto.subtle;
  } catch {
    // Not Node: fall through to the error below.
  }
  throw new Error('[agent-sdk] verifyApprovalReceipt needs WebCrypto (crypto.subtle), which this runtime does not provide');
}

/** A JWKS document's receipt keys by key id. Keys of any other kind are ignored, and a kid published twice is refused. */
function keysById(document: unknown): Map<string, ApprovalReceiptPublicJwk> {
  const keys = (document as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new Error('the key set has no "keys" list');
  const byId = new Map<string, ApprovalReceiptPublicJwk>();
  const doubled = new Set<string>();
  for (const k of keys) {
    if (!isReceiptKey(k)) continue;
    if (byId.has(k.kid)) doubled.add(k.kid);
    byId.set(k.kid, k);
  }
  // Two keys under one id: neither can be told from the other, so neither is used.
  for (const kid of doubled) byId.delete(kid);
  return byId;
}

interface RemoteKeySet {
  keys: Map<string, ApprovalReceiptPublicJwk>;
  /** Epoch ms after which the keys are read again before use. */
  freshUntil: number;
  /** Epoch ms of the last read, for the once-a-minute limit on reading again for an unknown kid. */
  fetchedAt: number;
}

const remoteKeySets = new Map<string, RemoteKeySet>();
const inflight = new Map<string, Promise<RemoteKeySet>>();

function maxAgeSeconds(cacheControl: string | null): number {
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(cacheControl ?? '')) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cacheControl ?? '');
  return match ? Number(match[1]) : APPROVAL_RECEIPT_JWKS_MAX_AGE_SEC;
}

async function fetchKeySet(url: string, fetchImpl: typeof fetch, now: number): Promise<RemoteKeySet> {
  const running = inflight.get(url);
  if (running) return running;
  const reading = (async () => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`the key set at ${url} answered HTTP ${res.status}`);
    const document = (await res.json()) as unknown;
    const set: RemoteKeySet = { keys: keysById(document), freshUntil: now + maxAgeSeconds(res.headers.get('cache-control')) * 1000, fetchedAt: now };
    remoteKeySets.set(url, set);
    return set;
  })();
  inflight.set(url, reading);
  try {
    return await reading;
  } finally {
    inflight.delete(url);
  }
}

/** The key a receipt names, from a document or a cached, refreshed URL; null when no published key has that id. */
async function receiptKey(jwks: VerifyApprovalReceiptOptions['jwks'], kid: string, fetchImpl: typeof fetch | undefined, now: number) {
  if (typeof jwks !== 'string' && !(jwks instanceof URL)) return keysById(jwks).get(kid) ?? null;
  const url = jwks.toString();
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch to read the key set with');
  let set = remoteKeySets.get(url);
  if (!set || now >= set.freshUntil) set = await fetchKeySet(url, doFetch, now);
  else if (!set.keys.has(kid) && now - set.fetchedAt >= APPROVAL_RECEIPT_JWKS_REFETCH_MS) set = await fetchKeySet(url, doFetch, now);
  return set.keys.get(kid) ?? null;
}

const refuse = (reason: ApprovalReceiptRefusalReason, error: string): ApprovalReceiptVerification => ({ ok: false, reason, error });

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(segment)));
}

/**
 * Verifies an approval receipt. It checks, in this order: the header (EdDSA,
 * the receipt `typ`, a key id, no `crit`), that a published key has that id,
 * the signature, the claims' shape, `exp` and `iat` (60 s of clock skew),
 * `aud`, then `argsHash`; each failure has its own `reason`. It never throws
 * for a bad receipt; a JWKS URL that cannot be read refuses with `key`.
 *
 * A receipt that verifies is still the tool's to use once: record its `jti`
 * for at least the receipt's lifetime, and never act twice on one.
 */
export async function verifyApprovalReceipt(jws: string, options: VerifyApprovalReceiptOptions): Promise<ApprovalReceiptVerification> {
  const now = options.now ?? Date.now();
  if (typeof jws !== 'string') return refuse('malformed', 'not a compact JWS');
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !B64URL.test(p)) || !parts[0] || !parts[1] || !parts[2]) {
    return refuse('malformed', 'not a compact JWS');
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: Record<string, unknown>;
  try {
    header = decodeJson(headerPart) as Record<string, unknown>;
  } catch {
    return refuse('malformed', 'the header is not JSON');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return refuse('malformed', 'the header is not an object');
  if (header.alg !== APPROVAL_RECEIPT_ALG) return refuse('malformed', `the header's alg is not ${APPROVAL_RECEIPT_ALG}`);
  if (header.typ !== APPROVAL_RECEIPT_TYP) return refuse('malformed', `the header's typ is not ${APPROVAL_RECEIPT_TYP}`);
  if (typeof header.kid !== 'string' || !header.kid) return refuse('malformed', 'the header names no kid');
  if (header.crit !== undefined) return refuse('malformed', 'the header names critical extensions, which a receipt has none of');

  let jwk: ApprovalReceiptPublicJwk | null;
  try {
    jwk = await receiptKey(options.jwks, header.kid, options.fetch, now);
  } catch (err) {
    return refuse('key', `the receipt keys could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!jwk) return refuse('key', `no published receipt key has kid "${header.kid}"`);

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signaturePart);
  } catch {
    return refuse('malformed', 'the signature is not base64url');
  }
  const subtle = await subtleCrypto();
  let valid: boolean;
  try {
    const key = await subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
    valid =
      signature.length === 64 &&
      (await subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, new TextEncoder().encode(`${headerPart}.${payloadPart}`)));
  } catch {
    valid = false;
  }
  if (!valid) return refuse('signature', `the signature is not key "${header.kid}"'s over this receipt`);

  let claims: unknown;
  try {
    claims = decodeJson(payloadPart);
  } catch {
    return refuse('malformed', 'the claims are not JSON');
  }
  const problem = approvalReceiptClaimsProblem(claims);
  if (problem) return refuse('malformed', problem);
  const c = claims as ApprovalReceiptClaims;

  const nowSec = Math.floor(now / 1000);
  if (nowSec >= c.exp + APPROVAL_RECEIPT_CLOCK_SKEW_SEC) return refuse('expired', 'the receipt has expired');
  if (c.iat > nowSec + APPROVAL_RECEIPT_CLOCK_SKEW_SEC) return refuse('expired', 'the receipt was issued in the future');

  const audience = approvalReceiptAudience(options.audience) ?? options.audience;
  if (c.aud !== audience) return refuse('audience', `the receipt is for ${c.aud}, not ${audience}`);
  if (c.argsHash !== options.expectedArgsHash) return refuse('args', 'the receipt is for other arguments than this request carries');
  return { ok: true, claims: c };
}
