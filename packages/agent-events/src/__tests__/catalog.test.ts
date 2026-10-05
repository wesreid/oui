/**
 * The catalog: a product's declarations, checked against the published schema
 * and the rules a schema cannot state, then looked up by everything that names
 * an event. The acceptance is at the bottom: a declared job binds, settles and
 * reads back as its outcome; an undeclared name fails, naming who used it.
 */
import { describe, expect, it } from 'vitest';
import {
  AsyncBindingError,
  EventDeclarationError,
  OUI_WIRE,
  PLATFORM_EVENTS,
  UndeclaredEventError,
  createEventCatalog,
  validateEventDeclarations,
  type EventDeclarationDocument,
} from '../index.js';
import { createPayloadValidator } from '../validate.js';
import { deskEvents } from './support/desk-events.js';

function problemsOf(build: () => unknown): string[] {
  try {
    build();
  } catch (err) {
    if (err instanceof EventDeclarationError) return [...err.problems];
    throw err;
  }
  return [];
}

describe('a valid document', () => {
  it('passes, alone and with the platform events', () => {
    expect(validateEventDeclarations(deskEvents())).toEqual([]);
    expect(validateEventDeclarations(PLATFORM_EVENTS)).toEqual([]);
    const catalog = createEventCatalog(PLATFORM_EVENTS, deskEvents());
    expect(catalog.products).toEqual(['agent-sdk', 'desk']);
    expect(catalog.names()).toEqual([...Object.keys(PLATFORM_EVENTS.events), 'report:ready', 'report:failed', 'report:progress']);
  });

  it('derives the job kind: its completion, failure, id field and the room that follows one job', () => {
    const kind = createEventCatalog(deskEvents()).jobKind('export')!;
    expect(kind.completion.name).toBe('report:ready');
    expect(kind.failure?.name).toBe('report:failed');
    expect(kind.correlation).toBe('exportId');
    expect(kind.followRoom).toEqual({ name: 'export', pattern: 'export:{exportId}' });
    expect(createEventCatalog(deskEvents()).followRoom('export', 'x-1')).toBe('export:x-1');
  });
});

describe('an invalid document fails, naming every problem', () => {
  it('breaks the published schema', () => {
    const doc = deskEvents() as unknown as { events: Record<string, Record<string, unknown>> };
    doc.events['report:ready'].role = 'done';
    delete doc.events['report:failed'].description;
    doc.events['Bad Name'] = doc.events['report:progress'];
    const problems = problemsOf(() => createEventCatalog(doc as unknown as EventDeclarationDocument));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("desk: /events/report:ready/role: must be one of"),
        expect.stringContaining("desk: /events/report:failed: 'description' is required"),
        expect.stringContaining("the name 'Bad Name' is not allowed"),
      ]),
    );
  });

  it('names a room, a $ref, or a field that is not there', () => {
    const doc = deskEvents();
    const events = doc.events as Record<string, (typeof doc.events)[string] & Record<string, unknown>>;
    events['report:ready'] = { ...events['report:ready'], rooms: ['exports'], result: ['url', 'size'] };
    events['report:failed'] = { ...events['report:failed'], reason: { field: 'why', fallback: 'failed' } };
    events['report:progress'] = { ...events['report:progress'], payload: { $ref: '#/$defs/Missing' } };
    expect(problemsOf(() => createEventCatalog(doc))).toEqual([
      "desk: events/report:ready: room 'exports' is not declared in rooms (declared: member, export)",
      "desk: events/report:ready: result field 'size' is not a property of its payload",
      "desk: events/report:failed: reason field 'why' is not a property of its payload",
      "desk: events/report:progress: payload $ref '#/$defs/Missing' does not name an entry of $defs",
    ]);
  });

  it('refuses a correlation field an event might not carry', () => {
    const doc = deskEvents();
    (doc.$defs as Record<string, { required: string[] }>).ReportRef.required = [];
    expect(problemsOf(() => createEventCatalog(doc))).toContain(
      "desk: events/report:ready: correlation field 'exportId' must be required: an event without it correlates to nothing",
    );
  });

  it('refuses a job kind that cannot finish, or finishes two ways', () => {
    const noCompletion = deskEvents();
    delete (noCompletion.events as Record<string, unknown>)['report:ready'];
    expect(problemsOf(() => createEventCatalog(noCompletion))).toEqual([
      "job kind 'export': settled by report:failed but no completion: a job of it could never finish",
    ]);

    const twoCompletions = deskEvents();
    (twoCompletions.events as Record<string, unknown>)['report:done'] = { ...twoCompletions.events['report:ready'] };
    expect(problemsOf(() => createEventCatalog(twoCompletions))).toEqual([
      "job kind 'export': has 2 completions (report:ready, report:done); a job completes one way",
    ]);
  });

  it('refuses settling fields on events that settle nothing, and a settling event without them', () => {
    const doc = deskEvents() as unknown as { events: Record<string, Record<string, unknown>> };
    doc.events['report:progress'].completes = 'export';
    delete doc.events['report:failed'].reason;
    expect(problemsOf(() => createEventCatalog(doc as unknown as EventDeclarationDocument))).toEqual(
      expect.arrayContaining([
        "desk: /events/report:progress: 'completes' is not allowed here",
        "desk: /events/report:failed: 'reason' is required",
      ]),
    );
  });

  it('refuses the same event from two products, and the reserved turn room', () => {
    const other = { ...deskEvents(), product: 'desk-2', rooms: { ...deskEvents().rooms, turn: { pattern: 'turn:{id}' } } };
    const problems = problemsOf(() => createEventCatalog(deskEvents(), other));
    expect(problems).toContain('desk-2: events/report:ready is already declared by desk');
    expect(problems).toContain("desk-2: rooms/turn is reserved for the agent turn's room, which each host names");
  });
});

describe('the platform events', () => {
  it('go only to the turn room, whichever room the host names', () => {
    const catalog = createEventCatalog(PLATFORM_EVENTS, deskEvents());
    expect(catalog.allowsRoom('agent:token', 'chat:turn:abc')).toBe(true);
    expect(catalog.allowsRoom('report:ready', 'export:x-1')).toBe(true);
    expect(catalog.allowsRoom('report:ready', 'member:ana')).toBe(true);
    expect(catalog.allowsRoom('report:ready', 'chat:turn:abc')).toBe(false);
    expect(catalog.allowsRoom('report:progress', 'member:ana')).toBe(false);
    expect(catalog.allowsRoom('report:unknown', 'export:x-1')).toBe(false);
  });
});

describe('the platform events of a stopped turn (ADR-0252)', () => {
  const validator = createPayloadValidator(createEventCatalog(PLATFORM_EVENTS));

  it('accept a completion that says why the turn was stopped, and refuse a reason that is not one', () => {
    const done = { turnId: 't1', rounds: 1, usage: {}, timestamp: 1 };
    expect(validator.problems('agent:turn_complete', done)).toEqual([]);
    expect(validator.problems('agent:turn_complete', { ...done, stopReason: 'user_stop' })).toEqual([]);
    expect(validator.problems('agent:turn_complete', { ...done, stopReason: 'superseded' })).toEqual([]);
    expect(validator.problems('agent:turn_complete', { ...done, stopReason: 'bored' })).not.toEqual([]);
  });

  it('accept a UI request with its turn, and one without: an older worker sends none', () => {
    const request = { requestId: 'r1', surfaceId: 's', actionId: 'a', params: {}, timestamp: 1 };
    expect(validator.problems(OUI_WIRE.dispatch, request)).toEqual([]);
    expect(validator.problems(OUI_WIRE.dispatch, { ...request, turnId: 't1' })).toEqual([]);
    expect(validator.problems(OUI_WIRE.dispatch, { ...request, turnId: '' })).not.toEqual([]);
  });
});

describe('acceptance: a declared job binds, settles, and reads back as its outcome', () => {
  const catalog = createEventCatalog(PLATFORM_EVENTS, deskEvents());

  it('binds async work to the completion, pairing its declared failure and id field', () => {
    expect(catalog.asyncBinding({ usedBy: "intent 'export-report'", completion: 'report:ready', correlation: 'exportId' })).toEqual({
      usedBy: "intent 'export-report'",
      kind: 'export',
      completion: 'report:ready',
      failure: 'report:failed',
      correlation: 'exportId',
    });
  });

  it('reads a completion as the result, and a failure as its reason', () => {
    const done = catalog.settlement('report:ready', { exportId: 'x-1', url: 'https://files/x-1.pdf', pages: null, extra: 1 });
    expect(done).toEqual({
      kind: 'export',
      role: 'completion',
      event: 'report:ready',
      id: 'x-1',
      payload: { exportId: 'x-1', url: 'https://files/x-1.pdf', pages: null, extra: 1 },
    });
    expect(catalog.outcome(done!)).toEqual({ status: 'complete', result: { url: 'https://files/x-1.pdf' } });

    const failed = catalog.settlement('report:failed', { exportId: 'x-2', error: 'Renderer crashed' })!;
    expect(catalog.outcome(failed)).toEqual({ status: 'failed', reason: 'Renderer crashed' });
    expect(catalog.outcome(catalog.settlement('report:failed', { exportId: 'x-3' })!)).toEqual({
      status: 'failed',
      reason: 'The export failed',
    });
  });

  it('settles nothing on progress, on a notice, or without the job id', () => {
    expect(catalog.settlement('report:progress', { exportId: 'x-1', progress: 0.5 })).toBeNull();
    expect(catalog.settlement('agent:token', { turnId: 't', text: 'hi', timestamp: 1 })).toBeNull();
    expect(catalog.settlement('report:ready', { url: 'u' })).toBeNull();
  });

  it('fails, naming the user and the event, for an undeclared name', () => {
    expect(() => catalog.require('report:done', "intent 'export-report'")).toThrow(
      new UndeclaredEventError('report:done', "intent 'export-report'", catalog.names()),
    );
    expect(() => catalog.asyncBinding({ usedBy: "intent 'export-report'", completion: 'report:done' })).toThrow(
      "[agent-sdk-events] intent 'export-report' names the event 'report:done', which is not declared. Declared: report:ready.",
    );
  });

  it('refuses a wait that could not resolve as asked', () => {
    expect(() => catalog.asyncBinding({ usedBy: 'op', completion: 'report:progress' })).toThrow(
      "op: waits on 'report:progress', a progress event: waiting on progress reports a running job as done. Wait on a completion: report:ready.",
    );
    expect(() => catalog.asyncBinding({ usedBy: 'op', completion: 'report:ready', correlation: 'reportId' })).toThrow(AsyncBindingError);
    expect(() => catalog.asyncBinding({ usedBy: 'op', completion: 'report:ready', failure: 'agent:turn_error' })).toThrow(
      "op: names 'agent:turn_error' as the failure of 'report:ready', but the declarations pair it with 'report:failed'",
    );
  });
});
