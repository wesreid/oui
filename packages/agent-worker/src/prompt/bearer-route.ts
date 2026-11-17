/**
 * A route a turn hands the model's tools, with the bearer token that opens it:
 * `{ url, token, expiresAt }`. The look route (`client.vision.look`) and the
 * capture control (`client.capture.control`) are both one, read by one rule.
 *
 * - The url is absolute, https (or this machine, for a host's own tests), and
 *   carries no credentials: the token goes with every call.
 * - The token is a bearer token (RFC 6750 `b64token`). No refusal repeats it.
 * - `expiresAt` is ISO 8601 with a zone, as sent.
 */

/** A route and the token for it. The token is never logged or emitted. */
export interface BearerRoute {
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token: string;
  /** When the token stops working: ISO 8601, as sent. */
  expiresAt: string;
}

/** How long each part of a route may be. */
export interface BearerRouteLimits {
  urlChars: number;
  tokenChars: number;
  expiresAtChars: number;
}

/** An ISO 8601 date and time, with a zone. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
/** What a bearer token is made of (RFC 6750 `b64token`). */
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
/** Hosts a token may be sent to without TLS: this machine only. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a route, or says why it is not one, naming the field. Null when it is
 * absent. With `base`, the url is one other paths are added to, so it carries
 * no query or fragment.
 */
export function readBearerRoute(
  value: unknown,
  field: string,
  limits: BearerRouteLimits,
  options: { base?: boolean } = {},
): BearerRoute | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  const url = value.url;
  if (typeof url !== 'string' || url.length > limits.urlChars || !URL.canParse(url)) {
    return `${field}.url must be an absolute URL of at most ${limits.urlChars} characters`;
  }
  const parsed = new URL(url);
  // The token goes with every call: never in the clear, except to this machine.
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)))) {
    return `${field}.url must be https`;
  }
  if (parsed.username || parsed.password) return `${field}.url must carry no credentials`;
  if (options.base && (parsed.search || parsed.hash || url.includes('?') || url.includes('#'))) {
    return `${field}.url must carry no query or fragment`;
  }
  const token = value.token;
  if (typeof token !== 'string' || !token || token.length > limits.tokenChars || !TOKEN.test(token)) {
    return `${field}.token must be a bearer token of 1–${limits.tokenChars} characters`;
  }
  const expiresAt = value.expiresAt;
  if (
    typeof expiresAt !== 'string' ||
    expiresAt.length > limits.expiresAtChars ||
    !ISO_DATE_TIME.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return `${field}.expiresAt must be an ISO 8601 date and time`;
  }
  return { url, token, expiresAt };
}
