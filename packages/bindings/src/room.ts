/**
 * The room catalog contract (ADR-0220 §2.3): what a room with its own editing
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
  RoomResult,
} from '@ouispec/contract';

export type {
  AgentCatalogManifestEntry,
  RoomActionData,
  RoomCatalogData,
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
 * @deprecated Since 0.8: a room action's effect is an `ActionEffect` (ADR-0226 §2.6), of which these are four. Kept for one minor.
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
