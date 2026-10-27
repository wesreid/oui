/**
 * Approval receipts: what the realtime server signs when it redeems an
 * approval token, for the approved call to carry to the tool's own API.
 *
 * A receipt is a compact JWS over Ed25519 (`alg: EdDSA`, `typ:
 * oui-approval-receipt+jwt`). Only this server holds the private keys; it
 * publishes the public ones at `/.well-known/oui-approval-jwks.json`, so a
 * tool can verify a receipt (`verifyApprovalReceipt` in agent-core) and never
 * make one. The keys are a list: one is `active` and signs, the others are
 * only published, which is how a key is rotated without a receipt ever naming
 * a key its verifier cannot find:
 *
 *   1. add the new key, published and not active;
 *   2. after one cache period (an hour), make it the active one;
 *   3. keep the old key published for one more cache period and the receipt
 *      lifetime, then remove it.
 */
import crypto from 'node:crypto';
import {
  APPROVAL_RECEIPT_ALG,
  APPROVAL_RECEIPT_TTL_SEC,
  APPROVAL_RECEIPT_TYP,
  approvalReceiptAudience,
  approvalReceiptClaimsProblem,
  publicReceiptJwk,
  type ApprovalReceiptClaims,
  type ApprovalReceiptJwks,
} from '@ouispec/agent-core';

/**
 * One receipt signing key: an Ed25519 private key as a JWK, with its key id,
 * and `active: true` on the one key that signs. Other members (a product's
 * own bookkeeping, such as when the key was made) are kept and never
 * published.
 */
export interface ApprovalReceiptKey {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  /** The public key, base64url. */
  x: string;
  /** The private key, base64url. Never published. */
  d: string;
  /** The one key that signs. Every other key is only published. */
  active?: boolean;
  alg?: 'EdDSA';
  use?: 'sig';
  [member: string]: unknown;
}

/** What a receipt is issued for: the redeemed call. The signer adds `iss`, `iat`, `exp` and `jti`. */
export type ApprovalReceiptSubject = Omit<ApprovalReceiptClaims, 'iss' | 'iat' | 'exp' | 'jti'>;

export interface IssuedApprovalReceipt {
  receipt: string;
  kid: string;
  jti: string;
  /** Epoch seconds. */
  exp: number;
}

export interface ApprovalReceiptSigner {
  /** The realtime server's public base URL, every receipt's `iss`. */
  readonly issuer: string;
  /** A receipt for a redeemed call, issued now, lasting `APPROVAL_RECEIPT_TTL_SEC`. */
  issue(subject: ApprovalReceiptSubject, nowMs?: number): IssuedApprovalReceipt;
  /** A receipt with exactly these claims, signed by the active key. Refuses claims that are not a receipt's, or another issuer's. */
  signClaims(claims: ApprovalReceiptClaims): string;
  /** The published key set: every key's public part. */
  jwks(): ApprovalReceiptJwks;
  /** The active key's id. */
  activeKid(): string;
  /** Replaces the keys (a rotation step), after checking them as at start-up. Throws, keeping the old keys, if they are not a key set. */
  setKeys(keys: readonly ApprovalReceiptKey[]): void;
}

/** The longest key id accepted. */
export const MAX_RECEIPT_KID_LENGTH = 200;

const B64URL = /^[A-Za-z0-9_-]+$/;
const CLAIM_ORDER = [
  'iss',
  'aud',
  'approvalId',
  'argsHash',
  'tool',
  'operationId',
  'conversationId',
  'userId',
  'accountId',
  'channel',
  'iat',
  'exp',
  'jti',
] as const satisfies ReadonlyArray<keyof ApprovalReceiptClaims>;

const bytes32 = (value: unknown) => typeof value === 'string' && B64URL.test(value) && Buffer.from(value, 'base64url').length === 32;

/**
 * What is wrong with a receipt key list, or null. Every key Ed25519 with its
 * private and public parts, the public part the private key's own, a unique
 * key id, and exactly one active.
 */
export function approvalReceiptKeysProblem(keys: unknown): string | null {
  if (!Array.isArray(keys) || keys.length === 0) return 'it must be a non-empty list of Ed25519 private keys as JWKs';
  const kids = new Set<string>();
  let active = 0;
  for (const [i, key] of keys.entries()) {
    const where = `key ${i}`;
    if (!key || typeof key !== 'object') return `${where} is not a JWK`;
    const k = key as Record<string, unknown>;
    if (typeof k.kid !== 'string' || !k.kid || k.kid.length > MAX_RECEIPT_KID_LENGTH) return `${where} has no kid`;
    const named = `key "${k.kid}"`;
    if (kids.has(k.kid)) return `${named} is listed twice`;
    kids.add(k.kid);
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519') return `${named} is not an Ed25519 key (kty OKP, crv Ed25519)`;
    if (k.alg !== undefined && k.alg !== APPROVAL_RECEIPT_ALG) return `${named} names alg ${String(k.alg)}, not ${APPROVAL_RECEIPT_ALG}`;
    if (k.use !== undefined && k.use !== 'sig') return `${named} is not for signing`;
    if (!bytes32(k.d)) return `${named} has no private key (d, 32 bytes base64url)`;
    if (!bytes32(k.x)) return `${named} has no public key (x, 32 bytes base64url)`;
    if (k.active !== undefined && typeof k.active !== 'boolean') return `${named}: active must be true or false`;
    if (k.active === true) active++;
    let derived: string | undefined;
    try {
      derived = crypto.createPublicKey(crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: k.d, x: k.x } as crypto.JsonWebKey, format: 'jwk' })).export({ format: 'jwk' }).x;
    } catch {
      return `${named} is not a usable Ed25519 private key`;
    }
    if (derived !== k.x) return `${named}: its public key (x) is not its private key's`;
  }
  if (active !== 1) return `exactly one key must be active, and ${active} ${active === 1 ? 'is' : 'are'}`;
  return null;
}

/**
 * The realtime server's public base URL, as receipts name it: an absolute
 * http(s) URL, with no query or fragment and no trailing slash. Null when it
 * is not one.
 */
export function receiptIssuer(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

interface LoadedKeys {
  active: { kid: string; privateKey: crypto.KeyObject };
  jwks: ApprovalReceiptJwks;
}

function load(keys: readonly ApprovalReceiptKey[]): LoadedKeys {
  const problem = approvalReceiptKeysProblem(keys);
  if (problem) throw new Error(`[agent-sdk-realtime] approvals.receiptKeys: ${problem}`);
  const activeKey = keys.find((k) => k.active === true)!;
  return {
    active: {
      kid: activeKey.kid,
      privateKey: crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: activeKey.d, x: activeKey.x } as crypto.JsonWebKey, format: 'jwk' }),
    },
    // The active key first, then the rest as listed: only public members, never `d` or a product's own.
    jwks: { keys: [activeKey, ...keys.filter((k) => k !== activeKey)].map(publicReceiptJwk) },
  };
}

export function createApprovalReceiptSigner(options: { keys: readonly ApprovalReceiptKey[]; issuer: string }): ApprovalReceiptSigner {
  const issuer = receiptIssuer(options.issuer);
  if (!issuer) throw new Error('[agent-sdk-realtime] approvals.receiptIssuer must be the realtime server’s public base URL (absolute http(s), no query)');
  let loaded = load(options.keys);

  const signClaims = (claims: ApprovalReceiptClaims): string => {
    const problem = approvalReceiptClaimsProblem(claims);
    if (problem) throw new Error(`[agent-sdk-realtime] Cannot sign an approval receipt: ${problem}`);
    if (claims.iss !== issuer) throw new Error(`[agent-sdk-realtime] Cannot sign an approval receipt for another issuer (${claims.iss})`);
    // One order for every receipt, so a receipt is the same bytes wherever it is signed (receipt-vectors.json).
    const ordered: Record<string, unknown> = {};
    for (const k of CLAIM_ORDER) if (claims[k] !== undefined) ordered[k] = claims[k];
    const { kid, privateKey } = loaded.active;
    const header = Buffer.from(JSON.stringify({ alg: APPROVAL_RECEIPT_ALG, typ: APPROVAL_RECEIPT_TYP, kid })).toString('base64url');
    const input = `${header}.${Buffer.from(JSON.stringify(ordered)).toString('base64url')}`;
    return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  };

  return {
    issuer,
    signClaims,
    issue(subject, nowMs = Date.now()) {
      const aud = approvalReceiptAudience(subject.aud);
      if (aud !== subject.aud) throw new Error(`[agent-sdk-realtime] Cannot sign an approval receipt for audience "${subject.aud}": not an origin`);
      const iat = Math.floor(nowMs / 1000);
      const jti = crypto.randomUUID();
      const exp = iat + APPROVAL_RECEIPT_TTL_SEC;
      const receipt = signClaims({ ...subject, iss: issuer, iat, exp, jti });
      return { receipt, kid: loaded.active.kid, jti, exp };
    },
    jwks: () => structuredClone(loaded.jwks),
    activeKid: () => loaded.active.kid,
    setKeys(keys) {
      loaded = load(keys);
    },
  };
}

/** A new receipt signing key, for a product's tests or its own key tooling. Its id defaults to a random one. */
export function generateApprovalReceiptKey(options: { kid?: string; active?: boolean } = {}): ApprovalReceiptKey {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    kid: options.kid ?? crypto.randomUUID(),
    x: jwk.x as string,
    d: jwk.d as string,
    ...(options.active === undefined ? {} : { active: options.active }),
  };
}
