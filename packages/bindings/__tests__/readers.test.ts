/**
 * A room's readers (ADR-0244 §2.2, §2.5): `inspect` and `query` built from
 * the room's declared lists, a name accepted wherever an id is, and the rows
 * an edit changed reported with its result.
 *
 * The room is the shape of the vector studio board of the 2026-10-02 session:
 * artboards named "Anim 01 …", one "Text" layer on each. In that session the
 * assistant called `select` with "Anim 01", was told there was no such id,
 * and had no tool that could tell it one.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ROOM_INSPECT_ID,
  ROOM_QUERY_ID,
  catalogData,
  changedRows,
  createBindingRegistry,
  indexRow,
  listLookup,
  refTo,
  resolveInputRefs,
  roomReaders,
  type JsonSchema,
  type OuiManifest,
  type RoomAction,
  type RoomCatalog,
  type RoomList,
  type RoomResult,
} from '../src/index.js';
import { connectBindings } from '../src/oui.js';

interface Layer {
  id: string;
  name: string;
  kind: 'text' | 'shape';
  artboardId: string;
  box: number[];
  anchor: [number, number];
  position: [number, number];
  keyframes: Record<string, number[]>;
}
interface Artboard {
  id: string;
  name: string;
  width: number;
  height: number;
}
interface Board {
  artboards: Artboard[];
  layers: Layer[];
}

const artboardId = (i: number) => `vector-ab-${String(i).padStart(2, '0')}`;
const layerId = (i: number) => `vector-ly-${String(i).padStart(2, '0')}`;

function sessionBoard(): Board {
  const names = ['Fade by Character', 'Rise by Character', 'Scale In (Elastic)', 'Typewriter', 'Slide In from Left'];
  return {
    artboards: Array.from({ length: 15 }, (_, i) => ({
      id: artboardId(i + 1),
      name: `Anim ${String(i + 1).padStart(2, '0')} — ${names[i % names.length]}`,
      width: 900,
      height: 500,
    })),
    layers: Array.from({ length: 15 }, (_, i) => ({
      id: layerId(i + 1),
      name: i === 10 ? 'TRAIDR Anim 11' : 'Text',
      kind: 'text' as const,
      artboardId: artboardId(i + 1),
      box: [155.7, -1.8, 604.6, 193.6],
      anchor: [0, 0] as [number, number],
      position: [0.173, 0.3064] as [number, number],
      keyframes: (i === 2 ? { 'motion.scale': [0, 0.075, 0.135, 0.225] } : {}) as Record<string, number[]>,
    })),
  };
}

type Ctx = { board: Board };

const ARTBOARDS: RoomList<Ctx> = {
  id: 'document/artboards',
  title: 'Artboards',
  rows: { ref: 'id', title: 'name', index: ['width', 'height'], selection: 'selection' },
  list: ctx => ctx.board.artboards.map(a => ({ ...a })),
  detail: (ctx, ref) => {
    const artboard = ctx.board.artboards.find(a => a.id === ref);
    return artboard && { ...artboard, layers: ctx.board.layers.filter(l => l.artboardId === ref).map(l => l.id) };
  },
};
const LAYERS: RoomList<Ctx> = {
  id: 'document/layers',
  title: 'Layers',
  rows: { ref: 'id', title: 'name', index: ['kind', 'artboardId'], selection: 'selection' },
  list: ctx => ctx.board.layers.map(({ id, name, kind, artboardId: on, box }) => ({ id, name, kind, artboardId: on, box })),
  detail: (ctx, ref) => {
    const layer = ctx.board.layers.find(l => l.id === ref);
    return layer && { ...layer, motion: { anchorPoint: layer.anchor, position: layer.position, keyframes: layer.keyframes } };
  },
};
const LISTS = [ARTBOARDS, LAYERS] as const;

const IDS: JsonSchema = { type: 'array', items: { type: 'string' }, ...refTo(ARTBOARDS, LAYERS) };

const RENAME: RoomAction<Ctx, { id: string; name: string }> = {
  kind: 'action',
  id: 'rename',
  title: 'Rename',
  description: 'Renames a layer or an artboard',
  control: 'The Layers panel',
  effect: 'edit',
  input: {
    type: 'object',
    properties: { id: { type: 'string', ...refTo(ARTBOARDS, LAYERS) }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
  run: (ctx, input): RoomResult => {
    const row = [...ctx.board.layers, ...ctx.board.artboards].find(r => r.id === input.id);
    if (!row) return { ok: false, code: 'NO_SUCH_LAYER', message: `No layer or artboard with id "${input.id}"` };
    row.name = input.name;
    return { ok: true, data: { id: row.id, name: row.name }, changed: changedRows(LISTS, ctx, [row.id]) };
  },
};
const SELECT: RoomAction<Ctx, { ids: string[] }> = {
  kind: 'action',
  id: 'select',
  title: 'Select',
  description: 'Selects layers or artboards',
  control: 'Clicking them',
  effect: 'selection',
  input: { type: 'object', properties: { ids: IDS }, required: ['ids'] },
  run: (ctx, input): RoomResult => {
    const missing = input.ids.find(id => ![...ctx.board.layers, ...ctx.board.artboards].some(r => r.id === id));
    return missing
      ? { ok: false, code: 'NO_SUCH_LAYER', message: `No layer or artboard with id "${missing}"` }
      : { ok: true, data: { selection: input.ids } };
  },
};

const CATALOG: RoomCatalog<Ctx> = {
  room: 'vector-studio',
  title: 'Vector Studio',
  description: 'Vector artwork on artboards',
  actions: [RENAME, SELECT, ...roomReaders({ title: 'Vector Studio' }, LISTS)] as RoomCatalog<Ctx>['actions'],
  fields: [],
  commands: [],
  observations: [
    {
      id: 'document',
      description: 'The artwork',
      schema: {
        type: 'object',
        properties: {
          selection: { type: 'array', items: { type: 'string' } },
          artboards: { type: 'array', 'x-rows': ARTBOARDS.rows, items: { type: 'object' } },
          layers: { type: 'array', 'x-rows': LAYERS.rows, items: { type: 'object' } },
        },
      },
    },
  ],
};

const run = (ctx: Ctx, id: string, input: Record<string, unknown>) =>
  (CATALOG.actions.find(a => a.id === id) as RoomAction<Ctx, Record<string, unknown>>).run(ctx, input) as RoomResult;

const data = (result: RoomResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data as Record<string, unknown>;
};

describe('query: finding a thing by its name or by what it is on', () => {
  it('finds the artboard the person calls "Anim 03" and the layer on it', () => {
    const ctx = { board: sessionBoard() };
    const artboards = data(run(ctx, ROOM_QUERY_ID, { list: 'document/artboards', title_contains: 'anim 03' }));
    expect(artboards).toEqual({
      list: 'document/artboards',
      total: 1,
      rows: [{ id: artboardId(3), name: 'Anim 03 — Scale In (Elastic)', width: 900, height: 500 }],
    });
    const layers = data(run(ctx, ROOM_QUERY_ID, { list: 'document/layers', where: { artboardId: artboardId(3) }, fields: ['box', 'motion'] }));
    expect(layers.total).toBe(1);
    expect(layers.rows).toEqual([
      {
        id: layerId(3),
        name: 'Text',
        kind: 'text',
        artboardId: artboardId(3),
        box: [155.7, -1.8, 604.6, 193.6],
        motion: { anchorPoint: [0, 0], position: [0.173, 0.3064], keyframes: { 'motion.scale': [0, 0.075, 0.135, 0.225] } },
      },
    ]);
  });

  it('pages through every row: each page says how many follow and where to read on', () => {
    const ctx = { board: sessionBoard() };
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = data(run(ctx, ROOM_QUERY_ID, { list: 'document/layers', limit: 4, ...(after ? { after } : {}) }));
      const rows = result.rows as { id: string }[];
      seen.push(...rows.map(r => r.id));
      expect(result.total).toBe(15);
      if (result.more === undefined) break;
      expect(result.more).toBe(15 - seen.length);
      after = result.after as string;
    }
    expect(seen).toEqual(sessionBoard().layers.map(l => l.id));
  });

  it('refuses a list the room does not have, a property rows are not indexed by, and an unknown `after`', () => {
    const ctx = { board: sessionBoard() };
    expect(run(ctx, ROOM_QUERY_ID, { list: 'document/pages' })).toMatchObject({ ok: false, code: 'NO_SUCH_LIST' });
    const notIndexed = run(ctx, ROOM_QUERY_ID, { list: 'document/layers', where: { box: 1 } });
    expect(notIndexed).toMatchObject({ ok: false, code: 'NOT_INDEXED' });
    expect((notIndexed as { message: string }).message).toContain('id, name, kind, artboardId');
    expect(run(ctx, ROOM_QUERY_ID, { list: 'document/layers', after: 'nope' })).toMatchObject({ ok: false, code: 'NO_SUCH_ROW' });
  });
});

describe('inspect: everything about the things named', () => {
  it('returns a layer’s whole detail — its anchor, position and keyframes — by id or by its one name', () => {
    const ctx = { board: sessionBoard() };
    const result = data(run(ctx, ROOM_INSPECT_ID, { refs: [layerId(3), 'TRAIDR Anim 11', 'Anim 05 — Slide In from Left'] }));
    const items = result.items as { list: string; ref: string; detail: Record<string, unknown> }[];
    expect(items.map(i => [i.list, i.ref])).toEqual([
      ['document/layers', layerId(3)],
      ['document/layers', layerId(11)],
      ['document/artboards', artboardId(5)],
    ]);
    expect(items[0].detail.motion).toEqual({
      anchorPoint: [0, 0],
      position: [0.173, 0.3064],
      keyframes: { 'motion.scale': [0, 0.075, 0.135, 0.225] },
    });
    expect(items[2].detail.layers).toEqual([layerId(5)]);
    expect(result.missing).toBeUndefined();
  });

  it('says which names several things share, with their ids, and which it could not find', () => {
    const ctx = { board: sessionBoard() };
    const ambiguous = run(ctx, ROOM_INSPECT_ID, { refs: ['Text'] });
    expect(ambiguous).toMatchObject({ ok: false, code: 'AMBIGUOUS_REF' });
    expect((ambiguous as { message: string }).message).toContain(layerId(1));
    expect(run(ctx, ROOM_INSPECT_ID, { refs: ['Anim 99'] })).toMatchObject({ ok: false, code: 'NO_SUCH_ROW' });
    const partial = data(run(ctx, ROOM_INSPECT_ID, { refs: [layerId(1), 'Anim 99'] }));
    expect((partial.items as unknown[]).length).toBe(1);
    expect(partial.missing).toEqual(['Anim 99']);
  });
});

describe('a name given where an id is taken', () => {
  it('becomes the id of the one row it names, in a string and in a list; an id stays; anything else is left for the action to refuse', () => {
    const lookup = listLookup(LISTS, { board: sessionBoard() });
    expect(resolveInputRefs(SELECT.input, { ids: ['anim 02 — rise by character', layerId(4), 'no such'] }, lookup)).toEqual({
      input: { ids: [artboardId(2), layerId(4), 'no such'] },
    });
    expect(resolveInputRefs(RENAME.input, { id: 'TRAIDR Anim 11', name: 'Wordmark' }, lookup)).toEqual({
      input: { id: layerId(11), name: 'Wordmark' },
    });
    // A name is never resolved in an input that addresses nothing.
    expect(resolveInputRefs(RENAME.input, { id: layerId(1), name: 'TRAIDR Anim 11' }, lookup)).toEqual({
      input: { id: layerId(1), name: 'TRAIDR Anim 11' },
    });
    const shared = resolveInputRefs(SELECT.input, { ids: ['Text'] }, lookup);
    expect(shared).toMatchObject({ error: { ok: false, code: 'AMBIGUOUS_REF' } });
  });
});

describe('the index row', () => {
  it('holds what addresses a row, what it is called and what tells rows apart', () => {
    expect(indexRow(LAYERS.rows, LAYERS.list({ board: sessionBoard() })[0])).toEqual({
      id: layerId(1),
      name: 'Text',
      kind: 'text',
      artboardId: artboardId(1),
    });
  });
});

/** The manifest a generator would emit for the room: one tool per action, the observation with its declared lists. */
function manifestOf(catalog: RoomCatalog<Ctx>): OuiManifest {
  const declared = catalogData(catalog);
  return {
    version: 1,
    surfaces: [
      {
        id: `room:${declared.room}`,
        kind: 'room',
        title: declared.title,
        description: declared.description,
        routes: ['/vector/:boardId'],
        actions: declared.actions.map(a => ({
          name: `vector_studio_${a.id.replace(/-/g, '_')}`,
          id: `${declared.room}/action/${a.id}`,
          source: 'room-action' as const,
          title: a.title,
          description: a.description,
          input: a.input,
          effect: a.effect,
          reach: [],
        })),
        observations: declared.observations.map(o => ({ ...o })),
      },
    ],
  } as unknown as OuiManifest;
}

describe('through the tab’s runtime, as the assistant’s tools run', () => {
  let disconnect: (() => void) | null = null;
  afterEach(() => {
    disconnect?.();
    disconnect = null;
  });

  async function mount() {
    const ctx = { board: sessionBoard() };
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
    disconnect = connectBindings({ registry, runtime, manifest: manifestOf(CATALOG) });
    const calls: [string, Record<string, unknown>][] = [];
    const handle = registry.registerRoom({
      catalog: catalogData(CATALOG),
      run: (id, input) => {
        calls.push([id, input]);
        return run(ctx, id, input);
      },
    });
    const report = () =>
      handle.setObservation('document', { selection: [], artboards: ARTBOARDS.list(ctx), layers: LAYERS.list(ctx) });
    report();
    await new Promise(resolve => setTimeout(resolve, 0));
    let n = 0;
    const execute = (actionId: string, params: Record<string, unknown>) =>
      runtime.execute({ requestId: `r${++n}`, surfaceId: 'room:vector-studio', actionId, params, timestamp: 0 });
    return { ctx, runtime, calls, execute, report };
  }

  it('offers inspect and query beside the room’s actions', async () => {
    const { runtime } = await mount();
    const tools = runtime.snapshot().surfaces.find(s => s.id === 'room:vector-studio')!.actions.map(a => a.id);
    expect(tools).toEqual(['vector_studio_rename', 'vector_studio_select', 'vector_studio_inspect', 'vector_studio_query']);
  });

  it('selects "Anim 01" by its name — the call the session’s assistant made and was refused', async () => {
    const { execute, calls } = await mount();
    const result = await execute('vector_studio_select', { ids: ['Anim 01 — Fade by Character'] });
    expect(result).toMatchObject({ success: true, data: { selection: [artboardId(1)] } });
    expect(calls.at(-1)).toEqual(['select', { ids: [artboardId(1)] }]);
  });

  it('runs nothing when a name is shared, and says which ids it could mean', async () => {
    const { execute, calls } = await mount();
    const result = await execute('vector_studio_select', { ids: ['Text'] });
    expect(result).toMatchObject({ success: false, error: { code: 'AMBIGUOUS_REF' } });
    expect(result.error!.message).toContain(layerId(15));
    expect(calls).toEqual([]);
  });

  it('answers an edit with the row it changed, as inspect would report it now', async () => {
    const { execute, ctx } = await mount();
    const result = await execute('vector_studio_rename', { id: 'TRAIDR Anim 11', name: 'Wordmark' });
    expect(result.success).toBe(true);
    expect(ctx.board.layers[10].name).toBe('Wordmark');
    expect((result.data as { changed: unknown[] }).changed).toEqual([
      {
        list: 'document/layers',
        ref: layerId(11),
        detail: expect.objectContaining({ id: layerId(11), name: 'Wordmark', motion: expect.objectContaining({ anchorPoint: [0, 0] }) }),
      },
    ]);
  });

  it('reads a layer through the inspect tool', async () => {
    const { execute } = await mount();
    const result = await execute('vector_studio_inspect', { refs: [layerId(3)] });
    expect(result).toMatchObject({
      success: true,
      data: { items: [{ list: 'document/layers', ref: layerId(3), detail: { box: [155.7, -1.8, 604.6, 193.6] } }] },
    });
  });
});
