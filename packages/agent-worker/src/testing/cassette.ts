/**
 * Recorded model responses: kept as they arrived from a live model, then
 * replayed through the product's real provider package, so the provider builds
 * its real requests and parses the recorded wire format. The worker's fixture
 * turn and the eval harness (`@ouispec/agent-evals`, ADR-0260 §3.5) record and
 * replay with these, and nothing else.
 *
 * Only responses are kept: status, content type and body bytes. Requests, and
 * so the credentials that signed them, never are.
 */

/** One response a model's API gave, as it arrived. */
export interface RecordedExchange {
  /** The request path the provider called (`/model/{id}/converse-stream`, `/v1/chat/completions`). */
  path: string;
  status: number;
  contentType: string;
  bodyBase64: string;
}

const pathOf = (input: Parameters<typeof fetch>[0]): string =>
  decodeURIComponent(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname);

/**
 * A fetch that calls the live API and keeps each response in `exchanges` as it
 * arrives, handing the caller an identical one.
 */
export function recordingFetch(exchanges: RecordedExchange[], live: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await live(input, init);
    const body = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    exchanges.push({ path: pathOf(input), status: res.status, contentType, bodyBase64: body.toString('base64') });
    return new Response(body, { status: res.status, headers: { 'content-type': contentType } });
  };
}

/** Why a replay could not answer a request: the recording does not hold it. */
export class ReplayExhaustedError extends Error {
  constructor(
    readonly requestNumber: number,
    readonly path: string,
    readonly recorded: number,
  ) {
    super(`replay: request ${requestNumber} (${path}) has no recorded response; the recording holds ${recorded}`);
    this.name = 'ReplayExhaustedError';
  }
}

/** Why a replay refused a request: it went somewhere the recording's did not. */
export class ReplayMismatchError extends Error {
  constructor(
    readonly requestNumber: number,
    readonly path: string,
    readonly recordedPath: string,
  ) {
    super(`replay: request ${requestNumber} went to ${path}, the recording's to ${recordedPath}`);
    this.name = 'ReplayMismatchError';
  }
}

/**
 * A fetch that answers each request with the next recorded response, in order,
 * and refuses one more. Nothing leaves the process. The request bodies the
 * provider sent are kept in `requests`, parsed, when given.
 */
export function replayingFetch(exchanges: readonly RecordedExchange[], requests?: unknown[]): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const exchange = exchanges[next++];
    const path = pathOf(input);
    if (!exchange) throw new ReplayExhaustedError(next, path, exchanges.length);
    if (path !== exchange.path) throw new ReplayMismatchError(next, path, exchange.path);
    requests?.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    return new Response(Buffer.from(exchange.bodyBase64, 'base64'), {
      status: exchange.status,
      headers: { 'content-type': exchange.contentType },
    });
  };
}
