/**
 * Recorded model responses: kept as they arrived from a live model, then
 * replayed through the product's real provider package, so the provider builds
 * its real requests and parses the recorded wire format. The worker's fixture
 * turn and the eval harness (`@ouispec/agent-evals`) record and
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
 * A fetch that calls the live API and keeps each response in `exchanges`,
 * handing the caller an identical one.
 *
 * The caller reads the body as it arrives: each chunk is passed on the moment
 * the API sends it and kept on the way. So a caller's clock (the time to the
 * first token) measures the API, not this fetch. Reading the whole body first,
 * as this fetch did before agent-worker 0.45.0, made every recorded first-token
 * time equal to the call's whole time (ADR-0348 §1.1).
 *
 * An exchange takes its place in `exchanges` when its request is sent, so the
 * recording keeps the order of the requests, which is the order a replay
 * answers them in. Its body is what has arrived when it is read: all of it
 * once the caller has read the body to its end.
 */
export function recordingFetch(exchanges: RecordedExchange[], live: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const chunks: Uint8Array[] = [];
    const exchange = { path: pathOf(input), status: 0, contentType: 'application/octet-stream' } as RecordedExchange;
    Object.defineProperty(exchange, 'bodyBase64', {
      enumerable: true,
      get: () => Buffer.concat(chunks).toString('base64'),
    });
    exchanges.push(exchange);
    let res: Response;
    try {
      res = await live(input, init);
    } catch (err) {
      // No response, so nothing to keep or to replay.
      exchanges.splice(exchanges.indexOf(exchange), 1);
      throw err;
    }
    exchange.status = res.status;
    exchange.contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const headers = { 'content-type': exchange.contentType };
    if (!res.body) return new Response(null, { status: res.status, headers });
    const kept = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(kept, { status: res.status, headers });
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
