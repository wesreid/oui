/**
 * How a job ends, as the platform sees it: the one completion or failure
 * event that settles it. The worker's async tools wait for a settlement, the
 * realtime server keeps one for each job, and the UI's job tracker records one
 * as the job's outcome, so all three read an event the same way.
 */
import type { AsyncBinding } from './catalog.js';

export interface Settlement {
  /** The kind of job settled, as the declarations name it. */
  kind: string;
  role: 'completion' | 'failure';
  /** The event that settled it. */
  event: string;
  /** The job: the value of the kind's correlation field. */
  id: string;
  payload: Readonly<Record<string, unknown>>;
}

/** What a settlement means: the job's result, or why there is none. */
export type SettlementOutcome =
  | { status: 'complete'; result: Readonly<Record<string, unknown>> }
  | { status: 'failed'; reason: string };

export interface SettlementRequest {
  /** What is waited on: the binding's completion or failure event, for this job. */
  binding: AsyncBinding;
  /** The job's correlation value (its `jobId`, say), from the dispatch. */
  id: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * How the worker waits for a job to settle. `createHttpEventWaiter` (in
 * `@ouispec/agent-worker`) asks the SDK realtime server, which keeps
 * every declared settlement; a host may supply its own.
 */
export interface EventWaiter {
  /** The job's settlement once it has one, or null when none arrives by `timeoutMs`. */
  waitForSettlement(request: SettlementRequest): Promise<Settlement | null>;
}
