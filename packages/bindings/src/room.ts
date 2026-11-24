/**
 * The room catalog contract: what a room with its own editing
 * model — the vector studio, the video editor — declares about everything a
 * person can do in it, so the assistant's actions and knowledge are generated
 * from the room's code rather than written by hand.
 *
 * The declarations are the contract's (`room-catalog-data.json`), generated
 * from its schema: what `agent-catalog.json` holds and a generator reads. This
 * module adds what a room runs — each action's `run`, each field's `read` and
 * `write` — and the catalog's two derived pieces: its `problems` schema and
 * its data.
 *
 * - **actions**: its operations, each carried out through the room's own
 *   reducer and commands, with a JSON schema for the input;
 * - **fields**: its inspector's fields, from the same definitions the
 *   inspector renders, each with its value's schema, unit, range, its
 *   animation and which kinds of thing it applies to;
 * - **commands**: its keymap, each command with its keys and what it does;
 * - **observations**: what a host reports about the room's state, including
 *   the problems it has drawing it.
 */

import type {
  JsonSchema,
  RoomActionData,
  RoomCatalogData,
  RoomCommand,
  RoomFieldData,
  RoomObservation,
  RoomProblemKind,
  RoomRecipe,
  RoomEntryInfo,
  RoomResult,
} from '@ouispec/contract';
import { validateValue } from './json-schema.js';

export type {
  AgentCatalogManifestEntry,
  RoomActionData,
  RoomCatalogData,
  RoomChangedRow,
  RoomCommand,
  RoomEntryInfo,
  RoomFieldAnimation,
  RoomFieldData,
  RoomObservation,
  RoomProblem,
  RoomProblemKind,
  RoomRecipe,
  RoomResult,
  RoomSection,
} from '@ouispec/contract';

/**
 * What a room action changes.
 * @deprecated Since 0.8: a room action's effect is an `ActionEffect`, of which
 * these are four. Kept for one minor.
 */
export type RoomEffect = 'edit' | 'selection' | 'view' | 'file';

/** One operation of the room. `Ctx` is the room's runtime: what `run` edits through. */
export interface RoomAction<Ctx, Input = Record<string, unknown>> extends RoomActionData {
  /** Carries the action out through the room's own reducer and commands, as the person's control does. */
  run(ctx: Ctx, input: Input): RoomResult | Promise<RoomResult>;
}

/** One inspector field: what it shows for the selection, and what setting it does. */
export interface RoomField<Ctx, Value = unknown> extends RoomFieldData {
  /** The value for what is selected; `undefined` when the field does not apply to it. */
  read(ctx: Ctx): Value | undefined;
  /** Set it on what is selected, as typing into the field does. */
  write(ctx: Ctx, value: Value): RoomResult | Promise<RoomResult>;
}

/** Whether a field animates: its `animation`, or the `keyframeable` of a catalog written before it. */
export function isKeyframeable(field: Pick<RoomFieldData, 'animation' | 'keyframeable'>): boolean {
  return field.animation?.keyframeable ?? field.keyframeable ?? false;
}

/** Everything a room declares. */
export interface RoomCatalog<Ctx> {
  /** The room's id: the surface id its assistant surface is published under. */
  room: string;
  title: string;
  /** What the room is for, in one or two sentences. */
  description: string;
  actions: readonly RoomAction<Ctx, never>[];
  fields: readonly RoomField<Ctx, unknown>[];
  commands: readonly RoomCommand[];
  observations: readonly RoomObservation[];
  /** The kinds of problem it reports, in its own vocabulary. Default: the generic `problems` schema. */
  problems?: readonly RoomProblemKind[];
  /** Tasks its tools carry out together, which only the room knows. */
  recipes?: readonly RoomRecipe[];
}

/**
 * The ids of a room's two generic actions, built from the rest of its
 * catalog so they cannot fall behind it: one sets any of its fields (its
 * input has one property per field, under `values`), one runs any available
 * command. A room with fields declares the first; a room with available
 * commands declares the second.
 */
export const ROOM_SET_PROPERTIES_ID = 'set-properties';
export const ROOM_RUN_COMMAND_ID = 'run-command';

/** The id every room and page reports its problems under. */
export const PROBLEMS_OBSERVATION_ID = 'problems';

const PROBLEMS_DESCRIPTION =
  'What is wrong that a person would see: what the page cannot show, load or do, as its banners and messages say it. ' +
  'Empty when nothing is wrong.';

/**
 * The schema of a `problems` observation: a list of `RoomProblem`. Its kinds
 * are the room's own when it declares them (`RoomCatalog.problems`).
 */
export function problemsSchema(kinds: readonly RoomProblemKind[] = []): JsonSchema {
  const listed = kinds.map(k => `${k.kind} = ${k.description}`).join('; ');
  return {
    type: 'array',
    description: kinds.length ? `${PROBLEMS_DESCRIPTION} Its kinds: ${listed}.` : PROBLEMS_DESCRIPTION,
    items: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'What kind of problem it is, in the page’s own vocabulary',
          ...(kinds.length ? { enum: kinds.map(k => k.kind) } : {}),
        },
        message: { type: 'string', description: 'The words the page shows for it' },
        hides: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of what is not shown because of it',
        },
        resolve: {
          type: 'object',
          description: 'The action that resolves it, and the choices it offers',
          properties: { action: { type: 'string' }, choices: { type: 'array' } },
        },
        detail: { type: 'object' },
      },
      required: ['kind', 'message'],
    },
  };
}

/** The schema of a `problems` observation whose kinds are not declared: every page's. */
export const PROBLEMS_SCHEMA: JsonSchema = problemsSchema();

/** The catalog's declarations, as `agent-catalog.json` holds them. Deterministic: entries keep the catalog's order. */
export function catalogData<Ctx>(catalog: RoomCatalog<Ctx>): RoomCatalogData {
  return {
    room: catalog.room,
    title: catalog.title,
    description: catalog.description,
    actions: catalog.actions.map(a => ({
      kind: a.kind,
      id: a.id,
      title: a.title,
      description: a.description,
      control: a.control,
      input: a.input,
      effect: a.effect,
      ...(a.destructive ? { destructive: true } : {}),
    })),
    fields: catalog.fields.map(f => ({
      kind: f.kind,
      id: f.id,
      title: f.title,
      description: f.description,
      control: f.control,
      section: f.section,
      appliesTo: [...f.appliesTo],
      value: f.value,
      // Every reader finds `animation`; a catalog written before it keeps its
      // `keyframeable` too, for readers of that name during the transition.
      ...(f.animation || f.keyframeable !== undefined ? { animation: { keyframeable: isKeyframeable(f) } } : {}),
      ...(f.keyframeable !== undefined ? { keyframeable: f.keyframeable } : {}),
    })),
    commands: catalog.commands.map(c => ({ ...c, keys: [...c.keys] })),
    observations: catalog.observations.map(o => ({ ...o })),
    ...(catalog.problems ? { problems: catalog.problems.map(p => ({ ...p })) } : {}),
    ...(catalog.recipes ? { recipes: catalog.recipes.map(r => ({ ...r, steps: [...r.steps] })) } : {}),
  };
}

// ─── Action families ─────────────────────────────────────────────────────────

/** The property a family's input names its member by. */
export const ROOM_FAMILY_KEY = 'op';

/** The extension on a family's `op` that names each op's member by its own id. */
export const ROOM_FAMILY_MEMBERS = 'x-members';

/** The members' own ids of a family action, from its input (`x-members`); none for any other action. */
export function roomFamilyMembers(input: { properties?: Record<string, unknown> } | undefined): string[] {
  const out: string[] = [];
  for (const property of Object.values(input?.properties ?? {})) {
    const members = (property as Record<string, unknown> | null)?.[ROOM_FAMILY_MEMBERS];
    if (members && typeof members === 'object') {
      for (const id of Object.values(members)) if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

/** A family cannot be built from these members: it says which and why. */
export class RoomFamilyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomFamilyError';
  }
}

export interface RoomActionFamilyOptions<Ctx> extends RoomEntryInfo {
  /**
   * The actions it gathers: near-identical operations on one kind of thing (an effect's add, set,
   * switch and move). They share one effect, none is destructive (a removal stays an action of its
   * own, approved as one), and a property two of them take means the same in both.
   */
  members: readonly RoomAction<Ctx, never>[];
}

/** A schema without its words: what two members must agree on for one property to serve both. */
function shapeOf(schema: JsonSchema): string {
  const { description: _description, ...rest } = schema as JsonSchema & { description?: string };
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * One action for a family of near-identical ones: its input names the member by `op`, and takes
 * what that member takes. Index lines are an assistant's map of a page, and a room of hundreds of
 * actions spends most of it repeating what such a family shares; gathered, the family is one line
 * that lists its members, and each member still runs exactly as it did, through its own `run`, its
 * input checked against its own schema first.
 *
 * `op`'s description is a line per member, "op = Title: what it does", the form a room's
 * run-command lists its commands in, so the app-wide search (`roomChoices`) finds each member by
 * its own words and gives the call (`op: set`). A member's op is its id after the family's
 * (`clip-effect-set` in `clip-effect` is `set`), or its whole id.
 *
 * Throws `RoomFamilyError` when the members cannot be one action: fewer than two, a destructive
 * one, effects that differ, an input that is not an object or already takes `op`, two ops alike,
 * or a property two members take with different schemas.
 */
export function roomActionFamily<Ctx>(options: RoomActionFamilyOptions<Ctx>): RoomAction<Ctx, Record<string, unknown>> {
  const { id, title, description, control, members } = options;
  const fail = (why: string): never => {
    throw new RoomFamilyError(`The ${id} family ${why}`);
  };
  if (members.length < 2) fail('needs at least two members');
  const effect = members[0].effect;
  const byOp = new Map<string, RoomAction<Ctx, never>>();
  const properties: Record<string, JsonSchema> = {};
  const takenBy = new Map<string, string[]>();
  for (const member of members) {
    if (member.destructive) fail(`cannot hold ${member.id}: it is destructive, and is approved as an action of its own`);
    if (member.effect !== effect) fail(`cannot hold ${member.id}: its effect is ${member.effect}, the family's ${effect}`);
    const input = member.input as JsonSchema;
    if (input.type !== 'object') fail(`cannot hold ${member.id}: its input is not an object`);
    const op = member.id.startsWith(`${id}-`) ? member.id.slice(id.length + 1) : member.id;
    if (byOp.has(op)) fail(`has two members whose op is ${op}`);
    byOp.set(op, member);
    for (const [name, schema] of Object.entries(input.properties ?? {})) {
      if (name === ROOM_FAMILY_KEY) fail(`cannot hold ${member.id}: it already takes ${ROOM_FAMILY_KEY}`);
      const had = properties[name];
      if (had && shapeOf(had) !== shapeOf(schema)) fail(`cannot hold ${member.id}: its ${name} is not the ${name} the others take`);
      if (!had) properties[name] = schema;
      takenBy.set(name, [...(takenBy.get(name) ?? []), op]);
    }
  }
  const ops = [...byOp.keys()];
  const line = (op: string, member: RoomAction<Ctx, never>): string => {
    const needs = ((member.input as JsonSchema).required ?? []) as string[];
    const words = member.description.replace(/\s+/g, ' ').trim();
    return `${op} = ${member.title.replace(/:/g, ' ')}: ${words}${needs.length ? ` Needs ${needs.join(', ')}.` : ''}`;
  };
  const merged = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      const by = takenBy.get(name)!;
      const words = (schema as { description?: string }).description;
      // A property only some members take says which.
      const scoped = by.length === ops.length ? words : `For ${by.join(', ')}${words ? `: ${words}` : ''}`;
      return [name, { ...schema, ...(scoped ? { description: scoped } : {}) }];
    }),
  );
  return {
    kind: 'action',
    id,
    title,
    description,
    control,
    effect,
    input: {
      type: 'object',
      properties: {
        [ROOM_FAMILY_KEY]: {
          type: 'string',
          enum: ops,
          description: ops.map(op => line(op, byOp.get(op)!)).join('\n'),
          // Each op's member by its own id: what a generator and a reason naming the member read.
          ...({ [ROOM_FAMILY_MEMBERS]: Object.fromEntries(ops.map(op => [op, byOp.get(op)!.id])) } as Record<string, unknown>),
        } as JsonSchema,
        ...merged,
      },
      required: [ROOM_FAMILY_KEY],
      additionalProperties: false,
    },
    run: (ctx, input) => {
      const { [ROOM_FAMILY_KEY]: op, ...rest } = input;
      const member = typeof op === 'string' ? byOp.get(op) : undefined;
      if (!member) {
        return { ok: false, code: 'NO_SUCH_OP', message: `${String(op)} is not one of ${id}'s: ${ops.join(', ')}` };
      }
      const problem = validateValue(member.input as JsonSchema, rest, 'input');
      if (problem) return { ok: false, code: 'INVALID_INPUT', message: `${op}: ${problem}` };
      return member.run(ctx, rest as never);
    },
  };
}

/** A family a room declares by its members' ids: its own id, title, words and control. */
export interface RoomFamilyDeclaration extends RoomEntryInfo {
  members: readonly string[];
}

/**
 * A room's actions with its families gathered (`roomActionFamily`): each family takes the place
 * of its first member, and its other members leave the list. Members are named by id, so a room
 * keeps each member's definition, and its tests, where it was. Throws `RoomFamilyError` for a
 * member the room does not have or that two families claim.
 */
export function gatherRoomFamilies<Ctx>(
  actions: readonly RoomAction<Ctx, never>[],
  families: readonly RoomFamilyDeclaration[],
): RoomAction<Ctx, never>[] {
  const byId = new Map(actions.map(a => [a.id, a]));
  const familyOf = new Map<string, RoomFamilyDeclaration>();
  for (const family of families) {
    for (const member of family.members) {
      if (!byId.has(member)) throw new RoomFamilyError(`The ${family.id} family names ${member}, which the room does not have`);
      const other = familyOf.get(member);
      if (other) throw new RoomFamilyError(`${member} is in two families: ${other.id} and ${family.id}`);
      familyOf.set(member, family);
    }
  }
  const built = new Map(
    families.map(f => [
      f.id,
      roomActionFamily<Ctx>({ id: f.id, title: f.title, description: f.description, control: f.control, members: f.members.map(m => byId.get(m)!) }),
    ]),
  );
  const out: RoomAction<Ctx, never>[] = [];
  const placed = new Set<string>();
  for (const action of actions) {
    const family = familyOf.get(action.id);
    if (!family) out.push(action);
    else if (!placed.has(family.id)) {
      placed.add(family.id);
      out.push(built.get(family.id)! as RoomAction<Ctx, never>);
    }
  }
  return out;
}
