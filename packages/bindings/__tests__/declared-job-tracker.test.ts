/**
 * The job tracker built from the product's event declarations (W9, ADR-0227
 * §2.4): what `connectBindings({ jobs })` reads a `{ kind: 'job' }` action's
 * outcome from.
 *
 * It follows a job of a declared kind in the room its completion declares for
 * one job, records the completion's declared result or the failure's declared
 * reason, and leaves the room when the job is forgotten. Work a declared kind
 * cannot describe (the tab's own work, a job made of several) plugs in as an
 * extension that reads declared events only. A name the declarations do not
 * hold fails when the tracker is made.
 */
import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_EVENTS, createEventCatalog, type EventDeclarationDocument } from '@ouispec/agent-events';
import { createDeclaredJobTracker, type JobEventSource, type JobOutcome, type JobTrackerExtension } from '../src/oui.js';

const deskEvents: EventDeclarationDocument = {
  version: 1,
  product: 'desk',
  rooms: { member: { pattern: 'member:{userId}' }, export: { pattern: 'export:{exportId}' }, batch: { pattern: 'batch:{batchId}' } },
  events: {
    'report:ready': {
      description: 'An export finished.',
      payload: {
        type: 'object',
        properties: { exportId: { type: 'string' }, url: { type: ['string', 'null'] }, pages: { type: 'integer' }, internal: { type: 'string' } },
        required: ['exportId'],
      },
      rooms: ['export', 'member'],
      correlation: ['exportId'],
      role: 'completion',
      completes: 'export',
      result: ['url', 'pages'],
    },
    'report:failed': {
      description: 'An export failed.',
      payload: { type: 'object', properties: { exportId: { type: 'string' }, error: { type: ['string', 'null'] } }, required: ['exportId'] },
      rooms: ['export', 'member'],
      correlation: ['exportId'],
      role: 'failure',
      completes: 'export',
      reason: { field: 'error', fallback: 'The export failed' },
    },
    'page:rendered': {
      description: 'One page of a batch rendered.',
      payload: { type: 'object', properties: { pageId: { type: 'string' }, batchId: { type: 'string' } }, required: ['pageId', 'batchId'] },
      rooms: ['batch'],
      correlation: ['pageId'],
      role: 'completion',
      completes: 'page',
    },
    'page:failed': {
      description: 'A page failed.',
      payload: { type: 'object', properties: { pageId: { type: 'string' }, batchId: { type: 'string' } }, required: ['pageId', 'batchId'] },
      rooms: ['batch'],
      correlation: ['pageId'],
      role: 'failure',
      completes: 'page',
      reason: { field: 'pageId', fallback: 'A page failed' },
    },
  },
};
const events = createEventCatalog(PLATFORM_EVENTS, deskEvents);

/** A socket that keeps ONE handler per event, as a map would: registering twice would lose the first. */
function source() {
  const handlers = new Map<string, (data: unknown) => void>();
  const on = vi.fn((event: string, handler: (data: unknown) => void) => void handlers.set(event, handler));
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on,
    emit: (event: string, data: unknown) => handlers.get(event)?.(data),
  } satisfies JobEventSource & { emit: unknown };
}

describe('a job of a declared kind', () => {
  it('is followed in the room its completion declares for one job, and completes with the declared result', () => {
    const s = source();
    const tracker = createDeclaredJobTracker({ events, source: s, kind: 'export' });
    tracker.track('exp-1');
    tracker.track('exp-1');
    expect(s.subscribe).toHaveBeenCalledTimes(1);
    expect(s.subscribe).toHaveBeenCalledWith(['export:exp-1']);
    expect(tracker.outcome('exp-1')).toBeNull();

    s.emit('report:ready', { exportId: 'exp-1', url: 'https://files/exp-1.pdf', pages: 3, internal: 'not a result' });
    expect(tracker.outcome('exp-1')).toEqual({ status: 'complete', jobId: 'exp-1', url: 'https://files/exp-1.pdf', pages: 3 });
  });

  it('fails with the declared reason, or its fallback', () => {
    const s = source();
    const tracker = createDeclaredJobTracker({ events, source: s, kind: 'export' });
    tracker.track('exp-2');
    tracker.track('exp-3');
    s.emit('report:failed', { exportId: 'exp-2', error: 'Renderer crashed' });
    s.emit('report:failed', { exportId: 'exp-3', error: null });
    expect(tracker.outcome('exp-2')).toEqual({ status: 'failed', jobId: 'exp-2', error: 'Renderer crashed' });
    expect(tracker.outcome('exp-3')).toEqual({ status: 'failed', jobId: 'exp-3', error: 'The export failed' });
  });

  it('ignores jobs it does not follow, and leaves the room when one is forgotten', () => {
    const s = source();
    const tracker = createDeclaredJobTracker({ events, source: s, kind: 'export' });
    s.emit('report:ready', { exportId: 'exp-4', url: 'u' });
    tracker.track('exp-4');
    expect(tracker.outcome('exp-4')).toBeNull();
    s.emit('report:ready', { exportId: 'exp-4', url: 'u' });
    tracker.forget('exp-4');
    tracker.forget('exp-4');
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.unsubscribe).toHaveBeenCalledWith(['export:exp-4']);
    expect(tracker.outcome('exp-4')).toBeNull();
  });

  it('listens once per event, whatever reads it', () => {
    const s = source();
    const pages = pageBatches();
    createDeclaredJobTracker({ events, source: s, kind: 'export', extensions: [pages] });
    expect(s.on.mock.calls.map(([event]) => event)).toEqual(['report:ready', 'report:failed', 'page:rendered', 'page:failed']);
  });
});

/** A batch of pages followed as one job: the extension point for work a declared kind cannot describe. */
function pageBatches(): JobTrackerExtension {
  const batches = new Map<string, { pages: Map<string, boolean | null>; outcome: JobOutcome | null }>();
  const parse = (jobId: string) => {
    const [, batchId, ids] = jobId.split(':');
    return { batchId, pageIds: ids.split(',') };
  };
  return {
    name: 'page batches',
    events: ['page:rendered', 'page:failed'],
    owns: (jobId) => jobId.startsWith('batch:'),
    track(jobId) {
      const { batchId, pageIds } = parse(jobId);
      batches.set(jobId, { pages: new Map(pageIds.map((id) => [id, null])), outcome: null });
      return [`batch:${batchId}`];
    },
    receive(event, payload) {
      const { pageId } = payload as { pageId: string };
      for (const [jobId, batch] of batches) {
        if (!batch.pages.has(pageId) || batch.outcome) continue;
        if (event === 'page:failed') batch.outcome = { status: 'failed', jobId, error: `Page ${pageId} failed` };
        else {
          batch.pages.set(pageId, true);
          if ([...batch.pages.values()].every(Boolean)) batch.outcome = { status: 'complete', jobId, pages: [...batch.pages.keys()] };
        }
      }
    },
    outcome: (jobId) => batches.get(jobId)?.outcome ?? null,
    forget(jobId) {
      batches.delete(jobId);
      return [`batch:${parse(jobId).batchId}`];
    },
  };
}

describe('an extension', () => {
  it('follows the jobs it owns, with the declared events it reads, in the rooms it names', () => {
    const s = source();
    const tracker = createDeclaredJobTracker({ events, source: s, kind: 'export', extensions: [pageBatches()] });
    tracker.track('batch:b1:p1,p2');
    expect(s.subscribe).toHaveBeenCalledWith(['batch:b1']);
    s.emit('page:rendered', { pageId: 'p1', batchId: 'b1' });
    expect(tracker.outcome('batch:b1:p1,p2')).toBeNull();
    s.emit('page:rendered', { pageId: 'p2', batchId: 'b1' });
    expect(tracker.outcome('batch:b1:p1,p2')).toEqual({ status: 'complete', jobId: 'batch:b1:p1,p2', pages: ['p1', 'p2'] });
    tracker.forget('batch:b1:p1,p2');
    expect(s.unsubscribe).toHaveBeenCalledWith(['batch:b1']);
    expect(tracker.outcome('batch:b1:p1,p2')).toBeNull();
  });

  it('answers only for jobs something asked the tracker to follow', () => {
    const s = source();
    const tab = { ...pageBatches(), outcome: () => ({ status: 'complete', jobId: 'batch:x:y' }) as JobOutcome };
    const tracker = createDeclaredJobTracker({ events, source: s, kind: 'export', extensions: [tab] });
    expect(tracker.outcome('batch:x:y')).toBeNull();
  });
});

describe('an undeclared name fails when the tracker is made', () => {
  it('an undeclared kind, or one no room follows', () => {
    expect(() => createDeclaredJobTracker({ events, source: source(), kind: 'invoice' })).toThrow(
      "[oui-bindings] the job tracker follows jobs of kind 'invoice', which no declared event settles (declared: export, page)",
    );
    expect(() => createDeclaredJobTracker({ events, source: source(), kind: 'page' })).toThrow(
      "no room of page:rendered is keyed by 'pageId' alone, so one job cannot be followed by joining a room",
    );
  });

  it('an extension reading an event that is not declared', () => {
    const ext = { ...pageBatches(), events: ['page:rendered', 'page:done'] };
    expect(() => createDeclaredJobTracker({ events, source: source(), kind: 'export', extensions: [ext] })).toThrow(
      "[agent-sdk-events] job tracker extension 'page batches' names the event 'page:done', which is not declared.",
    );
  });
});
