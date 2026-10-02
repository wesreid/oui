/**
 * The app's job tracker, built from the product's event declarations (W9,
 * ADR-0227 §2.4): the `JobTracker` that `connectBindings({ jobs })` reads a
 * `{ kind: 'job' }` action's outcome from.
 *
 * A job of the declared kind is followed in the room its completion declares
 * for one job (`generation:{jobId}`), and ends on its declared completion,
 * with the declared result fields, or its declared failure, with the declared
 * reason. Work a declared kind cannot describe (work the tab does itself, a
 * job made of several) plugs in as a `JobTrackerExtension`, which reads
 * declared events only.
 *
 * It records outcomes only for jobs something asked it to track, so traffic
 * for other jobs cannot grow it. It listens once per event name.
 */
import type { EventCatalog } from '@ouispec/agent-events';
import type { JobOutcome, JobTracker } from './oui.js';

/** What the tracker needs of a socket: rooms to join and events to hear. */
export interface JobEventSource {
  subscribe(rooms: string[]): void;
  unsubscribe(rooms: string[]): void;
  on(event: string, handler: (data: unknown) => void): void;
}

/**
 * Jobs the declared kind cannot describe, followed by the product's own code.
 * The tracker hands it only the declared events it names, and answers for its
 * jobs only while they are tracked.
 */
export interface JobTrackerExtension {
  /** For errors. */
  readonly name: string;
  /** The declared events it reads; each must be declared. */
  readonly events: readonly string[];
  /** Whether this extension follows `jobId`. */
  owns(jobId: string): boolean;
  /** Start following `jobId`; the rooms to join (none for the tab's own work). */
  track(jobId: string): readonly string[];
  /** One of its events arrived. */
  receive(event: string, payload: unknown): void;
  /** The job's outcome once it has one. */
  outcome(jobId: string): JobOutcome | null;
  /** Stop following `jobId`; the rooms to leave. */
  forget(jobId: string): readonly string[];
}

export interface DeclaredJobTrackerOptions {
  /** The product's event declarations. */
  events: EventCatalog;
  source: JobEventSource;
  /** The declared job kind a job id names, unless an extension owns it. */
  kind: string;
  extensions?: readonly JobTrackerExtension[];
}

export function createDeclaredJobTracker({ events, source, kind, extensions = [] }: DeclaredJobTrackerOptions): JobTracker {
  const declared = events.jobKind(kind);
  if (!declared) {
    const kinds = events.jobKinds().map((k) => k.kind);
    throw new Error(
      `[oui-bindings] the job tracker follows jobs of kind '${kind}', which no declared event settles (declared: ${kinds.join(', ') || 'none'})`,
    );
  }
  // Refuses, naming the kind, when no room is keyed by its id alone.
  events.followRoom(kind, 'probe');
  for (const extension of extensions) {
    for (const event of extension.events) events.require(event, `job tracker extension '${extension.name}'`);
  }

  const tracked = new Set<string>();
  const outcomes = new Map<string, JobOutcome>();
  const owner = (jobId: string) => extensions.find((e) => e.owns(jobId));
  const followRoom = (jobId: string): string[] => {
    try {
      return [events.followRoom(kind, jobId)];
    } catch {
      // An id no room can hold cannot be followed; its action reports it unfinished.
      return [];
    }
  };

  const settle = (event: string, payload: unknown) => {
    const settlement = events.settlement(event, payload);
    if (!settlement || !tracked.has(settlement.id)) return;
    const outcome = events.outcome(settlement);
    outcomes.set(
      settlement.id,
      outcome.status === 'complete'
        ? { status: 'complete', jobId: settlement.id, ...outcome.result }
        : { status: 'failed', jobId: settlement.id, error: outcome.reason },
    );
  };

  const readers = new Map<string, Array<(payload: unknown) => void>>();
  const listen = (event: string, reader: (payload: unknown) => void) => readers.set(event, [...(readers.get(event) ?? []), reader]);
  listen(declared.completion.name, (payload) => settle(declared.completion.name, payload));
  if (declared.failure) listen(declared.failure.name, (payload) => settle(declared.failure!.name, payload));
  for (const extension of extensions) {
    for (const event of extension.events) listen(event, (payload) => extension.receive(event, payload));
  }
  for (const [event, eventReaders] of readers) {
    source.on(event, (payload) => eventReaders.forEach((read) => read(payload)));
  }

  return {
    track(jobId) {
      if (!jobId || tracked.has(jobId)) return;
      tracked.add(jobId);
      const extension = owner(jobId);
      const rooms = extension ? [...extension.track(jobId)] : followRoom(jobId);
      if (rooms.length > 0) source.subscribe(rooms);
    },
    outcome(jobId) {
      if (!tracked.has(jobId)) return null;
      const extension = owner(jobId);
      return extension ? extension.outcome(jobId) : (outcomes.get(jobId) ?? null);
    },
    forget(jobId) {
      if (!tracked.delete(jobId)) return;
      const extension = owner(jobId);
      if (!extension) outcomes.delete(jobId);
      const rooms = extension ? [...extension.forget(jobId)] : followRoom(jobId);
      if (rooms.length > 0) source.unsubscribe(rooms);
    },
  };
}

