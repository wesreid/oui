/**
 * The event catalog: one or more declaration documents (the platform's own
 * and the product's), checked, merged and looked up by name.
 *
 * Everything that names an event goes through it. A name it does not hold is
 * an error that says who used it: the realtime server refuses the emit, the
 * worker refuses to load the tool, the job tracker refuses to start.
 */
import { EVENT_DECLARATIONS_SCHEMA } from './schema.js';
import { validateLite } from './json-schema-lite.js';
import { isObjectSchema, payloadShape } from './payload-shape.js';
import { formatRoom, roomPatternsRegExp, roomPlaceholders } from './rooms.js';
import type { Settlement, SettlementOutcome } from './settlement.js';
import {
  TURN_ROOM,
  type EventDeclaration,
  type EventDeclarationDocument,
  type EventRole,
  type FailureReason,
  type JsonSchema,
} from './types.js';

// ─── What the catalog holds ─────────────────────────────────────────────────

export interface DeclaredRoom {
  name: string;
  /** Null for `turn`: the room of the agent turn, which each host names. */
  pattern: string | null;
}

export interface DeclaredEvent {
  name: string;
  /** The product whose document declares it. */
  product: string;
  description: string;
  role: EventRole;
  /** The name generated code gives its payload type. */
  typeName: string;
  payload: JsonSchema;
  /** The declaring document's `$defs`, which the payload's `$ref`s point into. */
  defs: Readonly<Record<string, JsonSchema>>;
  rooms: readonly DeclaredRoom[];
  correlation: readonly string[];
  /** The kind of job it settles; null unless it is a completion or failure. */
  completes: string | null;
  result: readonly string[];
  reason: FailureReason | null;
}

/** A kind of job, as its settling events declare it. */
export interface JobKind {
  kind: string;
  product: string;
  completion: DeclaredEvent;
  /** Null when the product declares no failure: a failed job can then only time out. */
  failure: DeclaredEvent | null;
  /** The field both settling events carry the job's id in. */
  correlation: string;
  /**
   * The room a follower joins to hear one job settle: a room of the
   * completion whose only id is the correlation field. Null when there is
   * none, and then a follower needs its own way in (an identity room).
   */
  followRoom: (DeclaredRoom & { pattern: string }) | null;
}

export interface AsyncBindingSpec {
  /** Who is binding, for errors: `intent 'generate-image'`, `operation POST /reports`. */
  usedBy: string;
  /** The completion event the work waits on. */
  completion: string;
  /** Its failure event. Default: the one the declarations pair with the completion. */
  failure?: string;
  /** The field the dispatch returns the job's id in. Default: the declared correlation field. */
  correlation?: string;
}

/** A checked binding of async work to its declared settling events. */
export interface AsyncBinding {
  usedBy: string;
  kind: string;
  completion: string;
  failure: string | null;
  correlation: string;
}

export interface EventCatalog {
  /** The products whose documents make up the catalog, in order. */
  readonly products: readonly string[];
  /** Every declared name, in declaration order. */
  names(): string[];
  has(name: string): boolean;
  get(name: string): DeclaredEvent | undefined;
  /** The declaration of `name`, or an `UndeclaredEventError` naming `usedBy`. */
  require(name: string, usedBy: string): DeclaredEvent;
  jobKinds(): JobKind[];
  jobKind(kind: string): JobKind | undefined;
  /** Bind async work to its settling events, or throw saying what is wrong and who is wrong. */
  asyncBinding(spec: AsyncBindingSpec): AsyncBinding;
  /** The settlement `payload` makes, when `event` is a completion or failure carrying its job's id; else null. */
  settlement(event: string, payload: unknown): Settlement | null;
  /** The result a completion carries, or the reason a failure gives. */
  outcome(settlement: Settlement): SettlementOutcome;
  /** Whether `room` is one of the rooms `event` is declared to go to. A turn room is any room the host names. */
  allowsRoom(event: string, room: string): boolean;
  /** The room to join to follow one job of `kind`; throws when the kind has none. */
  followRoom(kind: string, id: string): string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A document breaks the schema or a rule of the catalog. Lists every problem found. */
export class EventDeclarationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`[agent-sdk-events] Invalid event declarations:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EventDeclarationError';
  }
}

/** Something names an event the declarations do not hold. */
export class UndeclaredEventError extends Error {
  constructor(
    readonly event: string,
    readonly usedBy: string,
    declared: readonly string[],
  ) {
    super(`[agent-sdk-events] ${usedBy} names the event '${event}', which is not declared. Declared: ${declared.join(', ') || '(none)'}.`);
    this.name = 'UndeclaredEventError';
  }
}

/** A binding names declared events that cannot settle its work as asked. */
export class AsyncBindingError extends Error {
  constructor(usedBy: string, problem: string) {
    super(`[agent-sdk-events] ${usedBy}: ${problem}`);
    this.name = 'AsyncBindingError';
  }
}

// ─── Checking a document ────────────────────────────────────────────────────

/** `generation:completed` → `GenerationCompleted`, `asset:qc_passed` → `AssetQcPassed`, `avatar:frame-reselect` → `AvatarFrameReselect`. */
export function defaultTypeName(event: string): string {
  return event
    .split(/[:_-]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

interface Checked {
  events: DeclaredEvent[];
  problems: string[];
}

function checkDocument(doc: EventDeclarationDocument): Checked {
  const where = typeof doc?.product === 'string' && doc.product ? doc.product : '(document)';
  const structural = validateLite(EVENT_DECLARATIONS_SCHEMA, doc);
  if (structural.length > 0) return { events: [], problems: structural.map((p) => `${where}: ${p || '/'}`) };

  const problems: string[] = [];
  const defs = doc.$defs ?? {};
  if (TURN_ROOM in doc.rooms) {
    problems.push(`${where}: rooms/${TURN_ROOM} is reserved for the agent turn's room, which each host names`);
  }
  const typeNames = new Map<string, string>(Object.keys(defs).map((name) => [name, `$defs/${name}`]));
  const events: DeclaredEvent[] = [];

  for (const [name, decl] of Object.entries(doc.events) as Array<[string, EventDeclaration]>) {
    const at = `${where}: events/${name}`;
    const typeName = decl.typeName ?? defaultTypeName(name);
    const clash = typeNames.get(typeName);
    if (clash) problems.push(`${at}: its type name ${typeName} is also ${clash}; give it a typeName`);
    typeNames.set(typeName, `events/${name}`);

    const rooms: DeclaredRoom[] = [];
    for (const room of decl.rooms) {
      if (room === TURN_ROOM) rooms.push({ name: room, pattern: null });
      else if (doc.rooms[room]) rooms.push({ name: room, pattern: doc.rooms[room].pattern });
      else problems.push(`${at}: room '${room}' is not declared in rooms (declared: ${Object.keys(doc.rooms).join(', ') || 'none'})`);
    }

    // A payload that does not resolve is reported once; its fields are not
    // checked against a shape that could not be read.
    let shape: ReturnType<typeof payloadShape> | null = null;
    try {
      shape = payloadShape(decl.payload, defs);
      if (!isObjectSchema(decl.payload, defs)) problems.push(`${at}: payload must be an object schema`);
    } catch (err) {
      problems.push(`${at}: payload ${err instanceof Error ? err.message : String(err)}`);
    }
    if (shape) {
      const { properties, required } = shape;
      for (const field of decl.correlation) {
        if (!properties.has(field)) problems.push(`${at}: correlation field '${field}' is not a property of its payload`);
        else if (!required.has(field)) problems.push(`${at}: correlation field '${field}' must be required: an event without it correlates to nothing`);
      }
      for (const field of decl.result ?? []) {
        if (!properties.has(field)) problems.push(`${at}: result field '${field}' is not a property of its payload`);
      }
      if (decl.reason && !properties.has(decl.reason.field)) {
        problems.push(`${at}: reason field '${decl.reason.field}' is not a property of its payload`);
      }
    }

    events.push({
      name,
      product: doc.product,
      description: decl.description,
      role: decl.role,
      typeName,
      payload: decl.payload,
      defs,
      rooms,
      correlation: decl.correlation,
      completes: decl.completes ?? null,
      result: decl.result ?? [],
      reason: decl.reason ?? null,
    });
  }
  return { events, problems };
}

function buildJobKinds(events: readonly DeclaredEvent[], problems: string[]): Map<string, JobKind> {
  const byKind = new Map<string, { completion: DeclaredEvent[]; failure: DeclaredEvent[] }>();
  for (const event of events) {
    if (!event.completes || (event.role !== 'completion' && event.role !== 'failure')) continue;
    const entry = byKind.get(event.completes) ?? { completion: [], failure: [] };
    entry[event.role].push(event);
    byKind.set(event.completes, entry);
  }

  const kinds = new Map<string, JobKind>();
  for (const [kind, { completion, failure }] of byKind) {
    const at = `job kind '${kind}'`;
    if (completion.length !== 1) {
      problems.push(
        completion.length === 0
          ? `${at}: settled by ${failure.map((e) => e.name).join(', ')} but no completion: a job of it could never finish`
          : `${at}: has ${completion.length} completions (${completion.map((e) => e.name).join(', ')}); a job completes one way`,
      );
      continue;
    }
    if (failure.length > 1) {
      problems.push(`${at}: has ${failure.length} failures (${failure.map((e) => e.name).join(', ')}); declare one`);
      continue;
    }
    const done = completion[0];
    const failed = failure[0] ?? null;
    const products = new Set([done.product, failed?.product].filter(Boolean));
    if (products.size > 1) {
      problems.push(`${at}: declared by more than one product (${[...products].join(', ')})`);
      continue;
    }
    const correlation = done.correlation[0];
    if (failed && failed.correlation[0] !== correlation) {
      problems.push(
        `${at}: ${done.name} correlates on '${correlation}' and ${failed.name} on '${failed.correlation[0]}'; a job has one id`,
      );
      continue;
    }
    const followRoom = done.rooms.find(
      (r): r is DeclaredRoom & { pattern: string } =>
        r.pattern !== null && roomPlaceholders(r.pattern).length === 1 && roomPlaceholders(r.pattern)[0] === correlation,
    );
    kinds.set(kind, { kind, product: done.product, completion: done, failure: failed, correlation, followRoom: followRoom ?? null });
  }
  return kinds;
}

/** Every problem with one document, or none. */
export function validateEventDeclarations(doc: unknown): string[] {
  const checked = checkDocument(doc as EventDeclarationDocument);
  if (checked.problems.length > 0) return checked.problems;
  const problems: string[] = [];
  buildJobKinds(checked.events, problems);
  return problems;
}

// ─── The catalog ────────────────────────────────────────────────────────────

const presentValue = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * Check and merge declaration documents: the platform's own
 * (`PLATFORM_EVENTS`) and the product's. Throws an `EventDeclarationError`
 * listing every problem when any document breaks the schema or a rule, or
 * when two documents declare the same event.
 */
export function createEventCatalog(...documents: readonly EventDeclarationDocument[]): EventCatalog {
  if (documents.length === 0) throw new EventDeclarationError(['no declaration documents were given']);
  const problems: string[] = [];
  const events = new Map<string, DeclaredEvent>();
  const products: string[] = [];

  for (const doc of documents) {
    const checked = checkDocument(doc);
    problems.push(...checked.problems);
    if (products.includes(doc?.product)) problems.push(`${doc.product}: declared twice`);
    products.push(doc?.product);
    for (const event of checked.events) {
      const earlier = events.get(event.name);
      if (earlier) problems.push(`${event.product}: events/${event.name} is already declared by ${earlier.product}`);
      else events.set(event.name, event);
    }
  }
  const kinds = buildJobKinds([...events.values()], problems);
  if (problems.length > 0) throw new EventDeclarationError(problems);

  const roomMatchers = new Map<string, RegExp | null>();
  for (const event of events.values()) {
    const turn = event.rooms.some((r) => r.pattern === null);
    const patterns = event.rooms.flatMap((r) => (r.pattern ? [r.pattern] : []));
    roomMatchers.set(event.name, turn ? null : roomPatternsRegExp(patterns));
  }
  const names = [...events.keys()];
  const completionNames = () => [...kinds.values()].map((k) => k.completion.name);

  const catalog: EventCatalog = {
    products,
    names: () => [...names],
    has: (name) => events.has(name),
    get: (name) => events.get(name),
    require(name, usedBy) {
      const event = events.get(name);
      if (!event) throw new UndeclaredEventError(name, usedBy, names);
      return event;
    },
    jobKinds: () => [...kinds.values()],
    jobKind: (kind) => kinds.get(kind),

    asyncBinding({ usedBy, completion, failure, correlation }) {
      const done = events.get(completion);
      if (!done) throw new UndeclaredEventError(completion, usedBy, completionNames());
      if (done.role !== 'completion' || !done.completes) {
        const hint = done.role === 'progress' ? ': waiting on progress reports a running job as done' : '';
        throw new AsyncBindingError(
          usedBy,
          `waits on '${completion}', a ${done.role} event${hint}. Wait on a completion: ${completionNames().join(', ')}.`,
        );
      }
      const kind = kinds.get(done.completes)!;
      if (failure !== undefined) {
        if (!events.has(failure)) throw new UndeclaredEventError(failure, usedBy, names);
        if (kind.failure?.name !== failure) {
          throw new AsyncBindingError(
            usedBy,
            `names '${failure}' as the failure of '${completion}', but the declarations pair it with ${kind.failure ? `'${kind.failure.name}'` : 'no failure event'}`,
          );
        }
      }
      if (correlation !== undefined && correlation !== kind.correlation) {
        throw new AsyncBindingError(
          usedBy,
          `correlates '${completion}' on '${correlation}', but it is declared to carry its job's id in '${kind.correlation}'; the wait would match nothing`,
        );
      }
      return { usedBy, kind: kind.kind, completion, failure: kind.failure?.name ?? null, correlation: kind.correlation };
    },

    settlement(name, payload) {
      const event = events.get(name);
      if (!event?.completes || (event.role !== 'completion' && event.role !== 'failure')) return null;
      if (!payload || typeof payload !== 'object') return null;
      const kind = kinds.get(event.completes)!;
      const id = (payload as Record<string, unknown>)[kind.correlation];
      if (typeof id !== 'string' || id.length === 0) return null;
      return { kind: kind.kind, role: event.role, event: name, id, payload: payload as Record<string, unknown> };
    },

    outcome(settlement) {
      const event = events.get(settlement.event);
      if (!event) throw new UndeclaredEventError(settlement.event, 'a settlement', names);
      if (settlement.role === 'failure') {
        const reason = event.reason ? settlement.payload[event.reason.field] : undefined;
        return { status: 'failed', reason: typeof reason === 'string' ? reason : (event.reason?.fallback ?? `${settlement.kind} failed`) };
      }
      const result: Record<string, unknown> = {};
      for (const field of event.result) {
        if (presentValue(settlement.payload[field])) result[field] = settlement.payload[field];
      }
      return { status: 'complete', result };
    },

    allowsRoom(name, room) {
      if (!events.has(name)) return false;
      const matcher = roomMatchers.get(name);
      return matcher === null || !!matcher?.test(room);
    },

    followRoom(kind, id) {
      const declared = kinds.get(kind);
      if (!declared) throw new UndeclaredEventError(kind, 'a job kind lookup', [...kinds.keys()]);
      if (!declared.followRoom) {
        throw new AsyncBindingError(
          `job kind '${kind}'`,
          `no room of ${declared.completion.name} is keyed by '${declared.correlation}' alone, so one job cannot be followed by joining a room`,
        );
      }
      return formatRoom(declared.followRoom.pattern, { [declared.correlation]: id });
    },
  };
  return catalog;
}
