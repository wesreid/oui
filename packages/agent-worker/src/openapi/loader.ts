/**
 * loadOpenApiTools — a product's OpenAPI 3 document becomes its agent tools
 * (ADR-0181 §2). No second manifest format: the document is read directly.
 *
 * - An operation is a tool only when its `x-agent` says `expose: true`.
 * - Its name is its `operationId`; its description its `summary` and `description`;
 *   its input its parameters and JSON request body, validated by the worker before
 *   every call.
 * - Its effect and `destructive` come from `x-agent`, and are on the tool for
 *   approvals to key on (ADR-0228).
 * - Its required permissions are its standard `security` requirement.
 * - A call runs as the caller the required `actAs` seam names, and the API decides
 *   what that caller may do.
 * - The product's own assistant (`audience: 'pa'`) gets only the operations flagged
 *   `pa: true`, and the flag is refused on anything but a read (ADR-0227 §2.1).
 * - An operation that starts a job names its declared completion event in
 *   `x-async-binding` (W9). It is checked against the product's declarations at
 *   load, and with a waiter the tool waits for the job to settle.
 *
 * Anything that cannot become a safe, callable tool is refused at load, naming the
 * operation.
 */
import { effectAccess, effectKind, type ActionEffect } from '@ouispec/bindings';
import type { EventCatalog, EventWaiter } from '@ouispec/agent-events';
import { asyncToolResult, awaitAsyncTool, bindAsyncTool, parseWaitTimeout, type BoundAsyncTool } from '../tools/async-binding.js';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import {
  HTTP_METHODS,
  OpenApiToolError,
  createResolver,
  toInputSchema,
  type HttpMethod,
  type JsonSchema,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiRequestBody,
  type Resolver,
  type SecurityRequirement,
} from './document.js';
import { executeOperation, type ActAs, type ExecutorPlan, type InputPlacement } from './executor.js';
import { readAgentExposure, type AgentExposure } from './x-agent.js';

/** `agents`: every exposed operation, for backend, MCP and external agents. `pa`: only those flagged `pa: true`. */
export type OpenApiToolAudience = 'agents' | 'pa';

export interface OpenApiToolsOptions {
  /** Where the API is served. Each operation's path is appended to it. */
  baseUrl: string;
  /** Who a call acts as. Required; there is no default. */
  actAs: ActAs;
  /** Which operations become tools. */
  audience: OpenApiToolAudience;
  /** The fetch to call the API with. Default: the global fetch. */
  fetch?: typeof fetch;
  /**
   * The product's event declarations. Required when an exposed operation has an
   * `x-async-binding`: its completion must be declared there.
   */
  events?: EventCatalog;
  /**
   * How an async operation's tool waits for its job to settle (for example
   * `createHttpEventWaiter`). Without one, the tool returns the dispatch.
   */
  waiter?: EventWaiter;
}

export interface OpenApiTool extends RegisteredTool {
  kind: 'backend';
  effect: ActionEffect;
  destructive: boolean;
  /** The operation's `summary`, else its id. */
  title: string;
  /** What happens when it runs, from `x-agent.consequence`. */
  consequence?: string;
  operation: {
    operationId: string;
    method: HttpMethod;
    path: string;
    /** The operation's `summary`, else its id: a short title for previews. */
    title: string;
    /** Its standard security requirement: any one entry, each scheme with the permissions it needs. */
    security: SecurityRequirement[];
    /** For an operation that starts a job: the declared events it settles on, and how long it is waited for. */
    async?: { completion: string; failure?: string; correlation: string; idField: string; timeoutMs: number };
  };
}

/** Model providers accept tool names of this shape. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const QUERY_STYLES = new Set(['form', 'spaceDelimited', 'pipeDelimited', 'deepObject']);

function describeOperation(method: HttpMethod, path: string, operationId?: string): string {
  return `${method.toUpperCase()} ${path}${operationId ? ` (${operationId})` : ''}`;
}

function jsonMediaType(content: Record<string, unknown> | undefined): string | undefined {
  return Object.keys(content ?? {}).find((type) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i.test(type));
}

/** The operation's parameters: the path item's, overridden by the operation's own of the same name and place. */
function mergedParameters(
  pathParams: Array<OpenApiParameter | { $ref: string }> | undefined,
  opParams: Array<OpenApiParameter | { $ref: string }> | undefined,
  resolver: Resolver,
  where: string,
): OpenApiParameter[] {
  const byKey = new Map<string, OpenApiParameter>();
  for (const raw of [...(pathParams ?? []), ...(opParams ?? [])]) {
    const param = resolver.deref<OpenApiParameter>(raw, where);
    if (!param || typeof param.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(param.in)) {
      throw new OpenApiToolError(`${where}: a parameter has no name or no valid "in"`);
    }
    byKey.set(`${param.in}:${param.name}`, param);
  }
  return [...byKey.values()];
}

function effectSentences(effect: ActionEffect, destructive: boolean, consequence: string | undefined): string[] {
  const sentences: string[] = [];
  switch (effectKind(effect)) {
    case 'job':
      sentences.push('It starts a job: the call returns once the job has started, and the job is done only when its status says complete.');
      break;
    case 'transaction':
      sentences.push('It is irreversible: it runs only on the person’s approval of this exact call.');
      break;
    default:
      break;
  }
  if (destructive) sentences.push('It removes or replaces something the person made.');
  if (consequence) sentences.push(consequence);
  return sentences;
}

interface BuiltInput {
  schema: JsonSchema;
  placements: Map<string, InputPlacement>;
  requiredHeaders: string[];
}

function buildInput(
  path: string,
  parameters: OpenApiParameter[],
  requestBody: OpenApiRequestBody | undefined,
  resolver: Resolver,
  where: string,
): BuiltInput {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const placements = new Map<string, InputPlacement>();
  const requiredHeaders: string[] = [];

  const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  for (const name of templateNames) {
    if (!parameters.some((p) => p.in === 'path' && p.name === name)) {
      throw new OpenApiToolError(`${where}: the path names {${name}}, which no path parameter declares`);
    }
  }

  for (const param of parameters) {
    if (param.in === 'header' || param.in === 'cookie') {
      // The caller's identity and context headers come only from actAs, never from the model.
      if (param.required) {
        if (param.in === 'cookie') throw new OpenApiToolError(`${where}: it requires the cookie ${param.name}, which a tool cannot send`);
        requiredHeaders.push(param.name);
      }
      continue;
    }
    if (param.in === 'path' && !templateNames.includes(param.name)) {
      throw new OpenApiToolError(`${where}: path parameter ${param.name} is not in the path`);
    }
    if (!param.schema) {
      throw new OpenApiToolError(`${where}: parameter ${param.name} declares no schema (content-typed parameters are not supported)`);
    }
    if (properties[param.name]) {
      throw new OpenApiToolError(`${where}: parameter ${param.name} is both a path and a query parameter`);
    }
    const schema = toInputSchema(param.schema, resolver, where);
    if (param.description && schema.description === undefined) schema.description = param.description;
    properties[param.name] = schema;
    if (param.in === 'path' || param.required) required.push(param.name);

    if (param.in === 'path') {
      if (param.style !== undefined && param.style !== 'simple') {
        throw new OpenApiToolError(`${where}: path parameter ${param.name} uses style ${param.style}; only simple is supported`);
      }
      placements.set(param.name, { in: 'path', name: param.name });
    } else {
      const style = (param.style ?? 'form') as Extract<InputPlacement, { in: 'query' }>['style'];
      if (!QUERY_STYLES.has(style)) throw new OpenApiToolError(`${where}: query parameter ${param.name} uses style ${style}, which is not supported`);
      placements.set(param.name, { in: 'query', name: param.name, style, explode: param.explode ?? style === 'form' });
    }
  }

  if (requestBody) {
    const mediaType = jsonMediaType(requestBody.content);
    if (!mediaType) {
      const types = Object.keys(requestBody.content ?? {});
      throw new OpenApiToolError(`${where}: its request body is ${types.join(', ') || 'undeclared'}; a tool sends JSON only`);
    }
    const bodySchema = toInputSchema(requestBody.content![mediaType]!.schema ?? {}, resolver, where);
    const fields = bodySchema.properties as Record<string, JsonSchema> | undefined;
    const closedObject =
      bodySchema.type === 'object' &&
      fields !== undefined &&
      (bodySchema.additionalProperties === undefined || bodySchema.additionalProperties === false) &&
      !['allOf', 'anyOf', 'oneOf', 'not', 'if', 'patternProperties', 'dependentSchemas'].some((k) => k in bodySchema);
    const collides = closedObject && Object.keys(fields).some((name) => name in properties || name === 'body');

    if (closedObject && !collides) {
      // A closed object body's fields sit beside the parameters.
      for (const [name, schema] of Object.entries(fields)) {
        properties[name] = schema;
        placements.set(name, { in: 'bodyField', name });
      }
      for (const name of (bodySchema.required as string[] | undefined) ?? []) if (!required.includes(name)) required.push(name);
    } else {
      if (properties.body) throw new OpenApiToolError(`${where}: a parameter is named "body", which its request body needs`);
      if (requestBody.description && bodySchema.description === undefined) bodySchema.description = requestBody.description;
      properties.body = bodySchema;
      placements.set('body', { in: 'body' });
      if (requestBody.required) required.push('body');
    }
  }

  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      // A tool accepts exactly what its operation declares (ADR-0182 §5).
      additionalProperties: false,
    },
    placements,
    requiredHeaders,
  };
}

function checkSecurity(
  security: unknown,
  schemes: Record<string, unknown> | undefined,
  where: string,
): SecurityRequirement[] {
  if (security === undefined) {
    throw new OpenApiToolError(
      `${where}: an exposed operation declares its security requirement (operation or document \`security\`; [] for a public one)`,
    );
  }
  if (!Array.isArray(security)) throw new OpenApiToolError(`${where}: security is a list of requirement objects`);
  return security.map((requirement) => {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new OpenApiToolError(`${where}: security is a list of requirement objects`);
    }
    const out: SecurityRequirement = {};
    for (const [scheme, scopes] of Object.entries(requirement as Record<string, unknown>)) {
      if (!schemes || !Object.prototype.hasOwnProperty.call(schemes, scheme)) {
        throw new OpenApiToolError(`${where}: security names scheme "${scheme}", which components.securitySchemes does not declare`);
      }
      if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string')) {
        throw new OpenApiToolError(`${where}: security scheme "${scheme}" lists its scopes as strings`);
      }
      out[scheme] = [...(scopes as string[])];
    }
    return out;
  });
}

/**
 * Bind an exposed operation's `x-async-binding` to the declared events, or throw
 * naming the operation. Null when it has none.
 *
 * The binding names the completion (`event`), and optionally its `failure`, the
 * event's id field (`correlation`), the response field the dispatch returns the
 * job's id in (`idField`, when it is not named like the event's) and how long to
 * wait (`timeout`); each defaults to what the declarations say. Its `room`, `payload` and
 * `lifecycleEvents` are documentation: the declarations are the authority.
 */
interface BoundOperation {
  bound: BoundAsyncTool;
  /** The response field the dispatch returns the job's id in. */
  idField: string;
}

function bindOperation(raw: unknown, effect: ActionEffect, options: OpenApiToolsOptions, where: string): BoundOperation | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpenApiToolError(`${where}: x-async-binding is an object`);
  const binding = raw as Record<string, unknown>;
  if (typeof binding.event !== 'string' || binding.event.trim() === '') {
    throw new OpenApiToolError(`${where}: x-async-binding.event names the declared completion the job ends with`);
  }
  const kind = effectKind(effect);
  if (kind !== 'job' && kind !== 'transaction') {
    throw new OpenApiToolError(`${where}: x-async-binding waits on a job, but its effect is ${kind}; declare effect job`);
  }
  if (!options.events) {
    throw new OpenApiToolError(`${where} waits on '${binding.event}', but no event declarations were given (OpenApiToolsOptions.events)`);
  }
  for (const key of ['failure', 'correlation', 'idField'] as const) {
    if (binding[key] !== undefined && typeof binding[key] !== 'string') {
      throw new OpenApiToolError(`${where}: x-async-binding.${key} is ${key === 'failure' ? 'an event' : 'a field'} name`);
    }
  }
  const effectTimeout = typeof effect === 'object' && 'timeoutMs' in effect ? effect.timeoutMs : undefined;
  let bound: BoundAsyncTool;
  try {
    bound = bindAsyncTool(options.events, {
      usedBy: where,
      completion: binding.event,
      ...(typeof binding.failure === 'string' ? { failure: binding.failure } : {}),
      ...(typeof binding.correlation === 'string' ? { correlation: binding.correlation } : {}),
      timeoutMs: parseWaitTimeout(where, 'x-async-binding.timeout', binding.timeout, effectTimeout ?? 60_000),
    });
  } catch (err) {
    throw new OpenApiToolError(err instanceof Error ? err.message.replace(/^\[agent-sdk\] /, '') : String(err));
  }
  return { bound, idField: typeof binding.idField === 'string' ? binding.idField : bound.binding.correlation };
}

function checkOptions(options: OpenApiToolsOptions): string {
  if (!options || typeof options.actAs !== 'function') {
    throw new OpenApiToolError('loadOpenApiTools: actAs is required: it names who each call acts as, and has no default');
  }
  if (options.audience !== 'agents' && options.audience !== 'pa') {
    throw new OpenApiToolError('loadOpenApiTools: audience is "agents" or "pa"');
  }
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new OpenApiToolError(`loadOpenApiTools: baseUrl "${String(options.baseUrl)}" is not an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenApiToolError(`loadOpenApiTools: baseUrl "${options.baseUrl}" is not an absolute http(s) URL`);
  }
  return options.baseUrl.replace(/\/+$/, '');
}

/**
 * Turn an OpenAPI 3 document into tools. Throws `OpenApiToolError`, naming the
 * operation, for anything it refuses.
 */
export function loadOpenApiTools(document: OpenApiDocument, options: OpenApiToolsOptions): OpenApiTool[] {
  const baseUrl = checkOptions(options);
  if (!document || typeof document.openapi !== 'string' || !/^3\.\d+(\.\d+)?/.test(document.openapi)) {
    throw new OpenApiToolError('loadOpenApiTools: this is not an OpenAPI 3 document (its `openapi` field is not 3.x)');
  }
  const resolver = createResolver(document);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { events, waiter } = options;
  const schemes = document.components?.securitySchemes;
  const tools: OpenApiTool[] = [];
  const names = new Map<string, string>();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation: OpenApiOperation | undefined = pathItem?.[method];
      if (!operation) continue;
      const where = describeOperation(method, path, operation.operationId);
      const exposure: AgentExposure | null = readAgentExposure(operation['x-agent'], { method, operationId: operation.operationId }, where);
      if (!exposure?.expose) continue;

      const operationId = operation.operationId;
      if (!operationId) throw new OpenApiToolError(`${where}: an exposed operation needs an operationId, its tool name`);
      if (!TOOL_NAME.test(operationId)) {
        throw new OpenApiToolError(`${where}: operationId "${operationId}" is not a tool name (letters, digits, _ and -, at most 64)`);
      }
      const clash = names.get(operationId);
      if (clash) throw new OpenApiToolError(`${where}: operationId "${operationId}" is also ${clash}`);
      names.set(operationId, describeOperation(method, path));

      const security = checkSecurity(operation.security ?? document.security, schemes, where);
      const parameters = mergedParameters(pathItem.parameters, operation.parameters, resolver, where);
      const requestBody = operation.requestBody ? resolver.deref<OpenApiRequestBody>(operation.requestBody, where) : undefined;
      const input = buildInput(path, parameters, requestBody, resolver, where);

      const effect = exposure.effect!;
      const asyncOperation = bindOperation(operation['x-async-binding'], effect, options, where);
      const bound = asyncOperation?.bound;

      if (options.audience === 'pa' && !exposure.pa) continue;

      const isRead = effectAccess(effect) === 'read';
      // The worker's quota reads this flag: a read is side-effect free.
      if (isRead) input.schema.sideEffects = false;

      const summary = operation.summary?.trim();
      const detail = operation.description?.trim();
      const description = [
        [summary, detail && detail !== summary ? detail : undefined].filter(Boolean).join('\n\n') || operationId,
        ...effectSentences(effect, exposure.destructive, exposure.consequence),
        // Promise the event only when the tool will actually wait for it.
        ...(bound && options.waiter
          ? [`It waits for ${bound.binding.completion}, and returns the finished result, or why the job failed.`]
          : []),
      ].join(' ');

      const plan: ExecutorPlan = {
        operationId,
        method,
        path,
        baseUrl,
        placements: input.placements,
        requiredHeaders: input.requiredHeaders,
        actAs: options.actAs,
        fetch: fetchImpl,
      };
      const irreversible = effectKind(effect) === 'transaction';

      tools.push({
        name: operationId,
        kind: 'backend',
        description,
        inputSchema: input.schema,
        effect,
        destructive: exposure.destructive,
        // The approval card's title and consequence come from the operation (ADR-0228 §2.2.2).
        title: summary || operationId,
        ...(exposure.consequence ? { consequence: exposure.consequence } : {}),
        operation: {
          operationId,
          method,
          path,
          title: summary || operationId,
          security,
          ...(bound
            ? {
                async: {
                  completion: bound.binding.completion,
                  ...(bound.binding.failure ? { failure: bound.binding.failure } : {}),
                  correlation: bound.binding.correlation,
                  idField: asyncOperation!.idField,
                  timeoutMs: bound.timeoutMs,
                },
              }
            : {}),
        },
        async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
          // An irreversible act runs only on the person's approval of this exact call
          // (ADR-0228). The worker runs it with that approval once the person gave it;
          // any other runner (an MCP server, a host calling the tool itself) has none.
          if (irreversible && !ctx.approval) {
            return {
              success: false,
              error: `"${operationId}" is irreversible: it runs only on the person’s approval of this exact call, and this call has none`,
              data: { code: 'APPROVAL_REQUIRED' },
            };
          }
          const result = await executeOperation(plan, args, ctx);
          if (!bound || !waiter || !result.success) return result;
          // The job started: wait for its declared completion or failure.
          const dispatch =
            result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? (result.data as Record<string, unknown>) : {};
          const settled = await awaitAsyncTool(events!, waiter, bound, dispatch[asyncOperation!.idField], ctx.abortSignal);
          return asyncToolResult(dispatch, settled);
        },
      });
    }
  }
  return tools;
}
