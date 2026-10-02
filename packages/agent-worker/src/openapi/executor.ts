/**
 * Calls one OpenAPI operation as the caller the auth seam names.
 *
 * The API decides what the caller may do: a permission they lack comes back as the
 * route's own refusal (a 403), which is returned as the tool's error, with the
 * status and body, for the model to read. Nothing here widens or checks access.
 */
import type { ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import type { HttpMethod } from './document.js';

/** Where each input property goes in the request. */
export type InputPlacement =
  | { in: 'path'; name: string }
  | { in: 'query'; name: string; style: 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject'; explode: boolean }
  /** One field of a JSON object body, flattened beside the parameters. */
  | { in: 'bodyField'; name: string }
  /** The whole JSON body, under the input property `body`. */
  | { in: 'body' };

export interface OperationRef {
  operationId: string;
  method: HttpMethod;
  path: string;
}

/**
 * Who a call acts as: the headers that make the API treat it as that caller.
 *
 * It is required and has no default. A product passes its own mechanism, such as a
 * signed assertion naming the user (Closure's is ADR-0182's), or the credential an
 * MCP client authenticated with.
 */
export type ActAs = (
  ctx: ToolExecutionContext,
  operation: OperationRef,
) => Record<string, string> | Promise<Record<string, string>>;

export interface ExecutorPlan extends OperationRef {
  baseUrl: string;
  placements: Map<string, InputPlacement>;
  /** Header parameters the operation requires; only actAs can supply them. */
  requiredHeaders: string[];
  actAs: ActAs;
  fetch: typeof fetch;
}

function serialiseQuery(search: URLSearchParams, placement: Extract<InputPlacement, { in: 'query' }>, value: unknown): void {
  const { name, style, explode } = placement;
  if (Array.isArray(value)) {
    const items = value.map(String);
    if (style === 'form' && explode) for (const item of items) search.append(name, item);
    else search.append(name, items.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (style === 'deepObject') for (const [key, v] of entries) search.append(`${name}[${key}]`, String(v));
    else if (explode) for (const [key, v] of entries) search.append(key, String(v));
    else search.append(name, entries.flatMap(([key, v]) => [key, String(v)]).join(','));
    return;
  }
  search.append(name, String(value));
}

function serialisePath(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => encodeURIComponent(String(v))).join(',');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, v]) => [encodeURIComponent(key), encodeURIComponent(String(v))])
      .join(',');
  }
  return encodeURIComponent(String(value));
}

/** The API's own words for a refusal, from the common error shapes. */
function refusalMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const error = b.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, string>).message;
  }
  if (typeof b.message === 'string') return b.message;
  if (typeof b.detail === 'string') return b.detail;
  if (typeof b.title === 'string') return b.title;
  return undefined;
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  if (/\bjson\b|\+json/i.test(response.headers.get('content-type') ?? '')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export async function executeOperation(
  plan: ExecutorPlan,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const ref: OperationRef = { operationId: plan.operationId, method: plan.method, path: plan.path };

  let identity: Record<string, string>;
  try {
    identity = await plan.actAs(ctx, ref);
  } catch (err) {
    return { success: false, error: `${plan.operationId} could not act as the user: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!identity || typeof identity !== 'object' || Object.values(identity).some((v) => typeof v !== 'string')) {
    return { success: false, error: `${plan.operationId} could not act as the user: actAs returned no headers` };
  }
  const suppliedHeaders = new Set(Object.keys(identity).map((h) => h.toLowerCase()));
  for (const header of plan.requiredHeaders) {
    if (!suppliedHeaders.has(header.toLowerCase())) {
      return { success: false, error: `${plan.operationId} needs the header ${header}, which actAs did not supply` };
    }
  }

  let path = plan.path;
  const search = new URLSearchParams();
  let body: unknown;
  const fields: Record<string, unknown> = {};
  let hasFields = false;
  for (const [key, value] of Object.entries(input)) {
    const placement = plan.placements.get(key);
    if (!placement || value === undefined) continue;
    if (placement.in === 'path') path = path.split(`{${placement.name}}`).join(serialisePath(value));
    else if (placement.in === 'query') serialiseQuery(search, placement, value);
    else if (placement.in === 'bodyField') {
      fields[placement.name] = value;
      hasFields = true;
    } else body = value;
  }
  if (hasFields) body = fields;

  const query = search.toString();
  const url = `${plan.baseUrl}${path}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, identity);

  let response: Response;
  try {
    response = await plan.fetch(url, {
      method: plan.method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
  } catch (err) {
    return { success: false, error: `${plan.operationId} could not reach the API: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await readResponse(response);
  if (response.ok) return { success: true, data: payload === undefined ? { status: response.status } : payload };

  const message = refusalMessage(payload);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return {
    success: false,
    error: `${plan.operationId} was refused: ${status}${message ? `: ${message}` : ''}`,
    data: { status: response.status, ...(payload !== undefined ? { body: payload } : {}) },
  };
}
