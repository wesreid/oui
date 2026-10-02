/**
 * loadToolsFromSchema — generates a RegisteredTool[] from declarative intent
 * schemas (intents/*.yaml). This is the schema-driven replacement for
 * hand-authored tool definitions.
 *
 * Each generated tool's `execute` calls the host's AgentApiSurface binding
 * (`ctx.apiSurface.executeIntent(intentId, params)`) — the host never writes
 * a tool body. An async intent's `subscribe:` block names the declared events
 * that settle its job (W9): they are checked against the product's event
 * declarations when the tools load, and with a waiter the tool waits for the
 * job to complete or fail.
 *
 * @see docs/reference/integration-contract.md §1b, §4
 */
import { loadSchemas } from '@ouispec/agent-core';
import type {
  RawSchemaDocument,
  RawIntentSchema,
  RawParameterSchema,
  RawIntentExecutionSchema,
} from '@ouispec/agent-core';
import type {
  RegisteredTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types.js';
import type { AgentApiSurface, IntentResult } from '@ouispec/agent-core';
import type { EventCatalog, EventWaiter } from '@ouispec/agent-events';
import { asyncToolResult, awaitAsyncTool, bindAsyncTool, parseWaitTimeout, type BoundAsyncTool } from './async-binding.js';

export interface LoadToolsOptions {
  /**
   * The product's event declarations. Required when any intent waits
   * (`execution.subscribe`): each names declared events, or the tools fail to
   * load, naming the intent and the event.
   */
  events?: EventCatalog;
  /**
   * How an async intent waits for its job to settle
   * (`createHttpEventWaiter`, or the host's own). Without it an async intent
   * returns its dispatch at once, with the job id.
   */
  waiter?: EventWaiter;
}

/** An intent's async binding, checked at load, with how it waits when it runs. */
interface AsyncIntent {
  bound: BoundAsyncTool;
  /** The dispatch field its job id is read from. */
  idFrom: unknown;
  events: EventCatalog;
  waiter: EventWaiter | undefined;
}

/**
 * Load intent schemas from a directory and compile them into RegisteredTool[].
 *
 * @param schemasDir Path to the schema directory (e.g. './schemas/my-app/')
 * @param options Optional subscription adapter for async intent resolution
 */
export async function loadToolsFromSchema(
  schemasDir: string,
  options?: LoadToolsOptions,
): Promise<RegisteredTool[]> {
  const documents = await loadSchemas(schemasDir);
  const intents = extractIntents(documents);

  return intents.map((intent) => compileIntentToTool(intent, bindIntent(intent, options ?? {}), options?.waiter));
}

/**
 * Bind an intent's `subscribe` block to the declarations, or throw naming the
 * intent and what is wrong. Null for an intent that does not wait.
 */
function bindIntent(intent: RawIntentSchema, options: LoadToolsOptions): AsyncIntent | null {
  const sub = (intent.execution as RawIntentExecutionSchema | undefined)?.subscribe;
  if (!sub) return null;
  const usedBy = `intent '${intent.id}'`;
  if (!options.events) {
    throw new Error(`[agent-sdk] ${usedBy} waits on '${sub.event}', but no event declarations were given (LoadToolsOptions.events)`);
  }
  const filter = Object.entries(sub.filter ?? {});
  if (filter.length !== 1) {
    throw new Error(
      `[agent-sdk] ${usedBy}: subscribe.filter must name exactly one field, the job id of '${sub.event}' (it names ${filter.length})`,
    );
  }
  const [[correlation, idFrom]] = filter;
  const bound = bindAsyncTool(options.events, {
    usedBy,
    completion: sub.event,
    ...(sub.failure !== undefined ? { failure: sub.failure } : {}),
    correlation,
    timeoutMs: parseWaitTimeout(usedBy, 'subscribe.timeout', sub.timeout),
    ...(sub.resultMapping ? { resultMapping: sub.resultMapping } : {}),
    mappingLabel: 'subscribe.resultMapping',
  });
  return { bound, idFrom, events: options.events, waiter: options.waiter };
}

/**
 * Flatten all intent definitions from loaded schema documents.
 * Intents appear either as top-level `doc.intent` or nested in
 * `doc.domain.intents[]` (after $ref resolution).
 */
function extractIntents(documents: RawSchemaDocument[]): RawIntentSchema[] {
  const intents: RawIntentSchema[] = [];
  for (const doc of documents) {
    if (doc.intent) {
      intents.push(doc.intent);
    }
    if (doc.domain?.intents) {
      for (const i of doc.domain.intents) {
        if (typeof i === 'object' && i !== null && 'id' in i) {
          intents.push(i as unknown as RawIntentSchema);
        }
      }
    }
  }
  // Deduplicate by id (domain $ref + standalone file may overlap)
  const seen = new Set<string>();
  return intents.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
}

/**
 * Compile a single intent schema into a RegisteredTool.
 */
function compileIntentToTool(intent: RawIntentSchema, asyncIntent: AsyncIntent | null, waiter: EventWaiter | undefined): RegisteredTool {
  const inputSchema = convertParameters(intent.parameters);

  // Thread the sideEffects flag into the inputSchema so the orchestrator's
  // quota check (`inputSchema.sideEffects !== false`) reads a real value
  // instead of always getting `undefined` (which fail-closed to side-effecting).
  if (intent.sideEffects === false) {
    inputSchema.sideEffects = false;
  }

  return {
    name: intent.id,
    description: buildDescription(intent, !!(asyncIntent && waiter)),
    inputSchema,
    async execute(
      input: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      return executeIntent(intent, input, ctx, asyncIntent);
    },
  };
}

/**
 * Build the tool description from the intent, enriching with async/duration
 * hints so the LLM knows what to expect.
 */
function buildDescription(intent: RawIntentSchema, waits: boolean): string {
  let desc = intent.description;
  if (intent.outcome?.async) {
    desc += `\n\nAsync: returns a jobId. Estimated duration: ${intent.outcome.estimatedDuration ?? 'unknown'}.`;
    // Promise the event only when the tool will actually wait for it.
    if (waits && intent.execution?.subscribe) {
      desc += ` The result arrives via the ${intent.execution.subscribe.event} realtime event.`;
    }
  }
  if (intent.outcome?.produces) {
    desc += `\nProduces: ${intent.outcome.produces}.`;
  }
  return desc;
}

/**
 * Convert RawParameterSchema (YAML) into a JSON Schema object for the LLM.
 * Entity-typed parameters become string references (the LLM passes an entity ID).
 */
function convertParameters(
  parameters: Record<string, RawParameterSchema>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(parameters)) {
    properties[name] = convertProperty(param);
    if (param.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    // An intent accepts exactly the parameters it declares. The orchestrator
    // validates calls against this, so an undeclared argument never reaches the host.
    additionalProperties: false,
  };
}

function convertProperty(param: RawParameterSchema): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  // Entity-typed params are string IDs at the LLM layer
  if (param.type === 'entity') {
    schema.type = 'string';
    if (param.entity) {
      schema.description = param.description
        ? `${param.description} (entity: ${param.entity} — pass the ID)`
        : `Entity reference (${param.entity}) — pass the ID`;
    }
  } else if (param.type === 'enum') {
    schema.type = 'string';
    if (param.values) schema.enum = param.values;
  } else if (param.type === 'array') {
    schema.type = 'array';
    if (param.items) schema.items = convertProperty(param.items);
  } else {
    schema.type = param.type;
  }

  if (param.description && param.type !== 'entity') {
    schema.description = param.description;
  }
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength;
  if (param.minLength !== undefined) schema.minLength = param.minLength;
  if (param.default !== undefined) schema.default = param.default;

  return schema;
}

/**
 * Execute an intent via the host's AgentApiSurface binding.
 *
 * This is the heart of the schema-driven model: the tool body is generated,
 * not hand-authored. It calls `ctx.apiSurface.executeIntent(intentId, params)`
 * — the host's binding decides whether that hits a REST route, a gateway
 * inference endpoint, or anything else.
 */
async function executeIntent(
  intent: RawIntentSchema,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
  asyncIntent: AsyncIntent | null,
): Promise<ToolExecutionResult> {
  const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
  if (!apiSurface) {
    return {
      success: false,
      error: `Intent '${intent.id}' requires an AgentApiSurface binding in the tool execution context. Provide apiSurface in the worker config.`,
    };
  }

  let result: IntentResult;
  try {
    result = await apiSurface.executeIntent(intent.id, input);
  } catch (err) {
    return {
      success: false,
      error: `Intent '${intent.id}' threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!result.success) {
    return {
      success: false,
      error: result.error?.message ?? `Intent '${intent.id}' failed`,
      data: result,
    };
  }

  const exec = intent.execution as RawIntentExecutionSchema | undefined;
  const mapped = applyResultMapping(exec, result);
  if (!result.async?.jobId || !asyncIntent?.waiter) {
    // Sync intent, or async without a waiter: the dispatch, with clean field names.
    return { success: true, data: mapped };
  }

  // Wait for the job to settle: its declared completion or failure.
  const dispatchData = (result.data as Record<string, unknown> | undefined) ?? {};
  const id = resolveTemplateString(String(asyncIntent.idFrom), { response: dispatchData });
  const settled = await awaitAsyncTool(asyncIntent.events, asyncIntent.waiter, asyncIntent.bound, id, ctx.abortSignal);
  return asyncToolResult(mapped, settled, { ...dispatchData, jobId: result.async.jobId });
}

/**
 * Apply execution.resultMapping to the dispatch response so the LLM sees
 * clean field names (jobId, imageId, status) rather than raw response shapes.
 */
function applyResultMapping(
  exec: RawIntentExecutionSchema | undefined,
  result: IntentResult,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...((result.data as Record<string, unknown> | undefined) ?? {}),
  };
  if (result.async) {
    base.jobId = result.async.jobId;
    base.status = result.async.jobId ? ((result.data as Record<string, unknown> | undefined)?.status ?? 'dispatched') : base.status;
  }
  if (exec?.resultMapping) {
    const mapped: Record<string, unknown> = {};
    const rMapping = exec.resultMapping as Record<string, string>;
    for (const [target, sourceExpr] of Object.entries(rMapping)) {
      const sourcePath = sourceExpr.replace(/\$\{\s*response\./, '').replace(/\s*\}/, '').trim();
      mapped[target] = getByPath(base, sourcePath);
    }
    // Merge mapped fields over base so both raw + mapped are available
    return { ...base, ...mapped };
  }
  return base;
}

// ─── template helpers ──────────────────────────────────────────────────────

function resolveTemplateString(
  str: string,
  ctx: Record<string, unknown>,
): unknown {
  const match = str.match(/^\$\{\s*(\w+)\.([^}]+?)\s*\}$/);
  if (!match) return str;
  const [, ns, path] = match;
  const root = (ctx as Record<string, unknown>)[ns];
  if (root === undefined) return undefined;
  return getByPath(root as Record<string, unknown>, path);
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

