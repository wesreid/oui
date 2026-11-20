/**
 * The realtime server's internal key, as the worker's HTTP clients present it.
 *
 * A host gives the key one of three ways:
 *
 * - **a fixed string**, as before: presented as it is, for the life of the process;
 * - **a getter**, `() => string | Promise<string>`, that reads it from the host's secret store.
 *   The SDK calls it on the first request, keeps its answer, and calls it again on the first
 *   request after `maxAgeMs` (default 30 s), so a rotated key reaches a warm process with no
 *   restart and the secret store is not read on every request;
 * - **a `RealtimeKeySource`** from `createRealtimeKeySource`, shared by several clients so they
 *   read through one cache. The runtime builds one for its own clients from `realtime.apiKey`.
 *
 * When the realtime server refuses the key (401 or 403), the source reads it again at once and,
 * if that gives a different key, the request is sent once more with it: a host whose key was
 * rotated before its cache expired does not wait out the cache. A fixed key is never re-read.
 *
 * A getter that fails, or answers no key, while a key is held leaves the held key in use and is
 * asked again on the next request: a secret store that cannot be reached for a moment never takes
 * away a key that worked a moment ago. With no key held, the request fails with an error that
 * names `realtime.apiKey` and never carries a key.
 */

/** Reads the realtime server's internal key from the host's secret store. */
export type RealtimeApiKeyGetter = () => string | Promise<string>;

/** The realtime server's internal key: fixed, read by a getter, or a source shared by several clients. */
export type RealtimeApiKey = string | RealtimeApiKeyGetter | RealtimeKeySource;

/** The realtime key, cached and refreshed (see the module's comment). */
export interface RealtimeKeySource {
  /** The key to present on the next request. Rejects only when no key is held and none can be read. */
  get(): Promise<string>;
  /**
   * The realtime server refused `key`. Reads the key again now, unless it is fixed or a newer one
   * is already held, and resolves whether the key held afterwards differs from `key` (a request
   * worth sending again).
   */
  refused(key: string): Promise<boolean>;
}

/** How long a key read by a getter is used before the getter is asked again, by default. */
export const DEFAULT_REALTIME_KEY_MAX_AGE_MS = 30_000;

export interface RealtimeKeySourceOptions {
  /** Ask the getter again once the key held is this old (ms). Default 30 s. Ignored for a fixed key. */
  maxAgeMs?: number;
  /** Told when a getter fails or answers no key while a key is held (the held key stays in use). Never given the key. */
  onRefreshError?: (error: unknown) => void;
  /** The clock, for tests. */
  now?: () => number;
}

const SOURCE = Symbol.for('@ouispec/agent-worker/realtime-key-source');

/** Whether `value` is a source made by `createRealtimeKeySource`. */
export function isRealtimeKeySource(value: unknown): value is RealtimeKeySource {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SOURCE] === true;
}

/** Whether `value` is a usable `realtime.apiKey`: a non-empty string, a getter, or a source. */
export function isRealtimeApiKey(value: unknown): value is RealtimeApiKey {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'function' || isRealtimeKeySource(value);
}

function noKey(): Error {
  return new Error('[agent-sdk] realtime.apiKey: the getter answered no key (an empty string)');
}

/**
 * The source for `apiKey`. A source is returned as it is (its own cache and age apply); a string
 * or a getter gets a new one.
 */
export function createRealtimeKeySource(apiKey: RealtimeApiKey, options: RealtimeKeySourceOptions = {}): RealtimeKeySource {
  if (isRealtimeKeySource(apiKey)) return apiKey;
  if (typeof apiKey === 'string') {
    if (!apiKey) throw new Error('[agent-sdk] Missing required configuration: realtime.apiKey');
    const fixed = Promise.resolve(apiKey);
    return { [SOURCE]: true, get: () => fixed, refused: async () => false } as RealtimeKeySource;
  }
  if (typeof apiKey !== 'function') {
    throw new Error('[agent-sdk] realtime.apiKey must be a string, a getter or a RealtimeKeySource');
  }

  const getter = apiKey;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_REALTIME_KEY_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('[agent-sdk] realtime.apiKeyMaxAgeMs must be a number of milliseconds, 0 or more');
  }
  const now = options.now ?? Date.now;
  let held: string | undefined;
  let readAt = 0;
  let pending: Promise<string> | undefined;

  /** Asks the getter, once at a time: every caller meanwhile shares its answer. */
  const read = (): Promise<string> => {
    pending ??= (async () => {
      try {
        const key = await getter();
        if (typeof key !== 'string' || key.length === 0) throw noKey();
        held = key;
        readAt = now();
        return key;
      } catch (error) {
        if (held === undefined) throw error;
        // Keep the key that worked; the next request asks again.
        options.onRefreshError?.(error);
        return held;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };

  return {
    [SOURCE]: true,
    get() {
      if (pending) return pending;
      if (held !== undefined && now() - readAt < maxAgeMs) return Promise.resolve(held);
      return read();
    },
    async refused(key) {
      if (pending) await pending.catch(() => undefined);
      // A newer key than the refused one is already held: send again with it, without asking.
      else if (held === key) await read().catch(() => undefined);
      return held !== undefined && held !== key;
    },
  } as RealtimeKeySource;
}

/** A refusal of the key itself. */
export const isKeyRefusal = (status: number): boolean => status === 401 || status === 403;

/**
 * Sends a request with the current key, and once more with a newer key when the realtime server
 * refuses the first (401 or 403) and the source then holds a different one. A refused request did
 * nothing on the server, so sending it again is safe whatever it asks.
 */
export async function fetchWithRealtimeKey(source: RealtimeKeySource, send: (key: string) => Promise<Response>): Promise<Response> {
  const key = await source.get();
  const res = await send(key);
  if (!isKeyRefusal(res.status) || !(await source.refused(key))) return res;
  await res.body?.cancel().catch(() => undefined);
  return send(await source.get());
}
