/**
 * Async tools bound to declared events (W9, ADR-0227 §2.4).
 *
 * A tool whose work outlives its call (a GPU job, an export) names the
 * declared completion it waits on, and optionally its failure and the field
 * its dispatch returns the job's id in. `bindAsyncTool` checks all of it
 * against the product's declarations when the tools load; `awaitAsyncTool`
 * waits for the job to settle when the tool runs. Intent tools use both
 * (schema-loader.ts), and so do tools generated from any other source, such
 * as an OpenAPI operation's async binding.
 */
import type { ToolExecutionResult } from './types.js';
import {
  payloadShape,
  type AsyncBinding,
  type EventCatalog,
  type EventWaiter,
} from '@ouispec/agent-events';

export interface AsyncToolSpec {
  /** Who is binding, for errors: `intent 'generate-image'`, `operation POST /reports/export`. */
  usedBy: string;
  /** The declared completion the tool waits on. */
  completion: string;
  /** Its declared failure. Default: the one the declarations pair with the completion. */
  failure?: string;
  /** The field the dispatch returns the job's id in. Default: the completion's correlation field. */
  correlation?: string;
  timeoutMs: number;
  /**
   * Fields for the model, each read from the completion's payload with a
   * `${ event.path }` expression. Default: the completion's declared result.
   */
  resultMapping?: Readonly<Record<string, string>>;
  /** What the mapping is called where it is written, for errors. Default `resultMapping`. */
  mappingLabel?: string;
}

export interface BoundAsyncTool {
  binding: AsyncBinding;
  timeoutMs: number;
  /** Target field → path in the completion's payload; null for the declared result. */
  fields: Readonly<Record<string, string>> | null;
}

/** How the job the tool started ended, as the model is told. */
export type AsyncToolSettlement =
  | { status: 'complete'; fields: Record<string, unknown> }
  | { status: 'failed'; reason: string }
  | { status: 'dispatched'; warning: string };

const TEMPLATE = /^\$\{\s*(\w+)\.([^}]+?)\s*\}$/;

/** Check an async tool against the declarations, or throw naming the tool and what is wrong. */
export function bindAsyncTool(events: EventCatalog, spec: AsyncToolSpec): BoundAsyncTool {
  const binding = events.asyncBinding({
    usedBy: spec.usedBy,
    completion: spec.completion,
    ...(spec.failure !== undefined ? { failure: spec.failure } : {}),
    ...(spec.correlation !== undefined ? { correlation: spec.correlation } : {}),
  });
  const label = spec.mappingLabel ?? 'resultMapping';
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error(`[agent-sdk] ${spec.usedBy}: its wait needs a positive timeout, got ${spec.timeoutMs}`);
  }
  if (!spec.resultMapping) return { binding, timeoutMs: spec.timeoutMs, fields: null };

  const completion = events.require(spec.completion, spec.usedBy);
  const carried = [...payloadShape(completion.payload, completion.defs).properties.keys()];
  const fields: Record<string, string> = {};
  for (const [target, expression] of Object.entries(spec.resultMapping)) {
    if (target === 'status') {
      throw new Error(`[agent-sdk] ${spec.usedBy}: ${label} maps 'status', which the SDK sets to how the job ended`);
    }
    const template = TEMPLATE.exec(String(expression));
    if (!template || template[1] !== 'event') {
      throw new Error(
        `[agent-sdk] ${spec.usedBy}: ${label}.${target} reads '${expression}'; a subscribe mapping reads the completion, so it must be \${ event.… }`,
      );
    }
    const path = template[2];
    if (!carried.includes(path.split('.')[0])) {
      throw new Error(
        `[agent-sdk] ${spec.usedBy}: ${label}.${target} reads '${expression}', and ${completion.name} carries no '${path.split('.')[0]}' (it carries: ${carried.join(', ')})`,
      );
    }
    fields[target] = path;
  }
  return { binding, timeoutMs: spec.timeoutMs, fields };
}

function getByPath(obj: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

/**
 * Wait for the job `id` names to settle, and say how it ended. Never throws:
 * a wait that could not happen, or did not end in time, is `dispatched` with
 * the reason, so the model keeps the job id and knows the job may still run.
 */
export async function awaitAsyncTool(
  events: EventCatalog,
  waiter: EventWaiter,
  bound: BoundAsyncTool,
  id: unknown,
  signal?: AbortSignal,
): Promise<AsyncToolSettlement> {
  const { binding, timeoutMs } = bound;
  if (typeof id !== 'string' || id.length === 0) {
    return { status: 'dispatched', warning: `The dispatch returned no '${binding.correlation}', so its ${binding.completion} cannot be waited on.` };
  }
  let settlement;
  try {
    settlement = await waiter.waitForSettlement({ binding, id, timeoutMs, ...(signal ? { signal } : {}) });
  } catch (err) {
    return { status: 'dispatched', warning: `Waiting for ${binding.completion} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!settlement || settlement.kind !== binding.kind || settlement.id !== id) {
    const missing = binding.failure ? `Neither ${binding.completion} nor ${binding.failure} arrived` : `${binding.completion} did not arrive`;
    return {
      status: 'dispatched',
      warning: `${missing} for ${binding.correlation} ${id} within ${Math.round(timeoutMs / 1000)}s: the job is still running.`,
    };
  }
  const outcome = events.outcome(settlement);
  if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason };
  if (!bound.fields) return { status: 'complete', fields: { ...outcome.result } };
  const fields: Record<string, unknown> = {};
  for (const [target, path] of Object.entries(bound.fields)) fields[target] = getByPath(settlement.payload, path);
  return { status: 'complete', fields };
}

/**
 * A wait's timeout as written in a declaration: `60s`, `2m`. Absent: `fallbackMs`
 * (60 s). Anything else fails the load, naming who wrote it and where.
 */
export function parseWaitTimeout(usedBy: string, where: string, timeout: unknown, fallbackMs = 60_000): number {
  if (timeout === undefined) return fallbackMs;
  const match = typeof timeout === 'string' ? /^(\d+)(s|m)$/.exec(timeout) : null;
  if (!match) throw new Error(`[agent-sdk] ${usedBy}: ${where} '${String(timeout)}' is not a duration like 60s or 2m`);
  const [, num, unit] = match;
  return unit === 'm' ? parseInt(num, 10) * 60_000 : parseInt(num, 10) * 1_000;
}

/**
 * What an async tool returns once its wait ends, for every kind of async tool:
 * - complete: the dispatch with the completion's fields, `status: 'complete'`;
 * - failed: a failed call with the declared reason, and the dispatch with `status: 'failed'`;
 * - dispatched: the job may still be running, so the model keeps the dispatch
 *   (`onDispatched`, default the dispatch) and is told why the wait ended. The
 *   call itself did not fail, so it is not retried.
 */
export function asyncToolResult(
  dispatch: Readonly<Record<string, unknown>>,
  settled: AsyncToolSettlement,
  onDispatched: Readonly<Record<string, unknown>> = dispatch,
): ToolExecutionResult {
  switch (settled.status) {
    case 'complete':
      return { success: true, data: { ...dispatch, ...settled.fields, status: 'complete' } };
    case 'failed':
      return { success: false, error: settled.reason, data: { ...dispatch, status: 'failed' } };
    case 'dispatched':
      return { success: true, data: { ...onDispatched, status: 'dispatched', warning: settled.warning } };
  }
}
