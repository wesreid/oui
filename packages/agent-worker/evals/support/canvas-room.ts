/**
 * A design canvas for the capability evals: artboards on a board, text layers
 * on artboards, each layer placed by a position and an anchor — a neutral
 * room, not any product's, that holds a real document and really edits it.
 *
 * It is declared the way a room is (oui-bindings' `RoomAction`, `RoomList`),
 * and answered the way a tab answers: each action runs against the document
 * and returns its result with the page's observations. So an eval runs a whole
 * turn through the worker — its tools, its page-state fitting, its turn record
 * — and grades the document afterwards, never what the model said it did.
 *
 * `platform: 'before'` is the room as rooms were before ADR-0244: lists with
 * no declared rows, no readers, ids only, results that carry no `changed`, an
 * anchor whose measure is not said. `'after'` is the room as ADR-0244 has it.
 * The same scenarios on both show what the platform changed.
 */
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import {
  changedRows,
  listLookup,
  refTo,
  resolveInputRefs,
  roomReaders,
  type JsonSchema,
  type RoomAction,
  type RoomList,
  type RoomResult,
} from '@ouispec/bindings';

import type { UIActionChannel } from '../../src/ui/channel.js';

export type Platform = 'before' | 'after';

export interface CanvasArtboard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasLayer {
  id: string;
  name: string;
  kind: 'text';
  artboardId: string;
  text: string;
  /** Font size in pixels. */
  size: number;
  fill: string;
  opacity: number;
  /** Where the anchor lands on the artboard, as a fraction of its width and height. */
  position: [number, number];
  /** A point of the layer's own content (origin: the start of its baseline), in pixels divided by the artboard's size. */
  anchor: [number, number];
  /** Percent. */
  scale: number;
  locked?: boolean;
}

export interface CanvasDocument {
  artboards: CanvasArtboard[];
  layers: CanvasLayer[];
  selection: string[];
}

export const ROOM_ID = 'room:canvas';
const LAYERS_LIST = 'document/layers';
const ARTBOARDS_LIST = 'document/artboards';

const round = (n: number) => Math.round(n * 10) / 10;

/** The width a line of text takes: a fixed advance per character, so geometry is exact and has no fonts in it. */
export const textWidth = (layer: Pick<CanvasLayer, 'text' | 'size'>) => layer.text.length * layer.size * 0.6;

/** A layer's box on its artboard, in pixels from its top left: [x, y, width, height]. */
export function layerBox(document: CanvasDocument, layer: CanvasLayer): [number, number, number, number] {
  const artboard = document.artboards.find(a => a.id === layer.artboardId)!;
  const s = layer.scale / 100;
  const anchor = [layer.anchor[0] * artboard.width, layer.anchor[1] * artboard.height];
  const position = [layer.position[0] * artboard.width, layer.position[1] * artboard.height];
  // The content: a box from the baseline's start, one line high, rising above it.
  const left = position[0] + s * (0 - anchor[0]);
  const top = position[1] + s * (-layer.size - anchor[1]);
  return [round(left), round(top), round(s * textWidth(layer)), round(s * layer.size)];
}

interface Ctx {
  document: CanvasDocument;
  newId(prefix: string): string;
}

const ok = (data: Record<string, unknown> = {}): RoomResult => ({ ok: true, data });
const fail = (code: string, message: string): RoomResult => ({ ok: false, code, message });

const artboardRow = (document: CanvasDocument, a: CanvasArtboard) => ({
  id: a.id,
  name: a.name,
  x: a.x,
  y: a.y,
  width: a.width,
  height: a.height,
  layerCount: document.layers.filter(l => l.artboardId === a.id).length,
});

const layerRow = (document: CanvasDocument, l: CanvasLayer) => ({
  id: l.id,
  name: l.name,
  kind: l.kind,
  artboardId: l.artboardId,
  box: layerBox(document, l),
  text: l.text,
  face: 'Inter-ExtraBold',
  appearance: [{ id: 'fill', kind: 'fill', paint: { kind: 'solid', color: l.fill } }],
  ...(l.locked ? { locked: true } : {}),
});

const ARTBOARDS: RoomList<Ctx> = {
  id: ARTBOARDS_LIST,
  title: 'Artboards',
  rows: { ref: 'id', title: 'name', index: ['x', 'y', 'width', 'height'], selection: 'selection' },
  list: ctx => ctx.document.artboards.map(a => artboardRow(ctx.document, a)),
  detail: (ctx, ref) => {
    const artboard = ctx.document.artboards.find(a => a.id === ref);
    if (!artboard) return undefined;
    return {
      ...artboardRow(ctx.document, artboard),
      layers: ctx.document.layers.filter(l => l.artboardId === ref).map(l => ({ id: l.id, name: l.name, box: layerBox(ctx.document, l) })),
    };
  },
};

const LAYERS: RoomList<Ctx> = {
  id: LAYERS_LIST,
  title: 'Layers',
  rows: { ref: 'id', title: 'name', index: ['kind', 'artboardId'], selection: 'selection' },
  list: ctx => ctx.document.layers.map(l => layerRow(ctx.document, l)),
  detail: (ctx, ref) => {
    const layer = ctx.document.layers.find(l => l.id === ref);
    if (!layer) return undefined;
    const artboard = ctx.document.artboards.find(a => a.id === layer.artboardId)!;
    const box = layerBox(ctx.document, layer);
    const centre: [number, number] = [box[0] + box[2] / 2, box[1] + box[3] / 2];
    const s = layer.scale / 100;
    // The content point under the box's centre, and where it is now: the pivot that leaves the layer in place.
    const inContent = [
      (centre[0] - layer.position[0] * artboard.width) / s + layer.anchor[0] * artboard.width,
      (centre[1] - layer.position[1] * artboard.height) / s + layer.anchor[1] * artboard.height,
    ];
    return {
      ...layerRow(ctx.document, layer),
      size: layer.size,
      fill: layer.fill,
      opacity: layer.opacity,
      transform: {
        position: { fraction: layer.position, px: [round(layer.position[0] * artboard.width), round(layer.position[1] * artboard.height)] },
        anchor: { fraction: layer.anchor, px: [round(layer.anchor[0] * artboard.width), round(layer.anchor[1] * artboard.height)] },
        centre: {
          px: centre.map(round),
          anchor: [inContent[0] / artboard.width, inContent[1] / artboard.height],
          position: [centre[0] / artboard.width, centre[1] / artboard.height],
        },
        scale: layer.scale,
        frame: [artboard.width, artboard.height],
      },
    };
  },
};

const LISTS = [LAYERS, ARTBOARDS] as const;

const ANCHOR_MEASURE =
  'The point of the layer’s own content that position places and scale turns about, measured from the content’s origin (the start ' +
  'of the text’s baseline) in pixels and divided by the artboard’s width and height: [0.5, 0.5] is half an artboard from the origin, ' +
  'not the layer’s middle. Changing the anchor alone moves the layer; to pivot about another point and leave the layer where it is, ' +
  'set the anchor and the position together. inspect gives both for the middle of the layer’s box: transform.centre.anchor and ' +
  'transform.centre.position.';
const POSITION_MEASURE =
  'Where the layer’s anchor lands on its artboard, as a fraction of the artboard’s width and height: [0.5, 0.5] is its centre.';

function actions(platform: Platform): RoomAction<Ctx, never>[] {
  const after = platform === 'after';
  const layerRef = after ? refTo(LAYERS) : {};
  const artboardRef = after ? refTo(ARTBOARDS) : {};
  const anyRef = after ? refTo(LAYERS, ARTBOARDS) : {};
  const ids: JsonSchema = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Layer or artboard ids', ...anyRef };
  const point = (description: string, space: string): JsonSchema => ({
    type: 'array',
    items: { type: 'number', ...(after ? { 'x-unit': 'fraction', 'x-space': space } : {}) },
    minItems: 2,
    maxItems: 2,
    description: after ? description : 'A point as [x, y]',
  });
  const px = after ? { 'x-unit': 'px' } : {};

  const find = (ctx: Ctx, id: string) => ctx.document.layers.find(l => l.id === id) ?? ctx.document.artboards.find(a => a.id === id);
  const missing = (ctx: Ctx, given: readonly string[]) => {
    const id = given.find(g => !find(ctx, g));
    return id ? fail('NO_SUCH_LAYER', `No layer or artboard with id "${id}" — read the room’s document observation for ids`) : null;
  };

  const all: RoomAction<Ctx, Record<string, unknown>>[] = [
    {
      kind: 'action',
      id: 'add-artboard',
      title: 'Add an artboard',
      description: 'Adds an artboard to the right of the others.',
      control: 'The artboard tool',
      effect: 'edit',
      input: {
        type: 'object',
        properties: { name: { type: 'string' }, width: { type: 'number', ...px }, height: { type: 'number', ...px } },
        required: ['name'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const right = Math.max(0, ...ctx.document.artboards.map(a => a.x + a.width));
        const artboard: CanvasArtboard = {
          id: ctx.newId('artboard'),
          name: String(input.name),
          x: ctx.document.artboards.length ? right + 100 : 0,
          y: 0,
          width: (input.width as number) ?? 900,
          height: (input.height as number) ?? 500,
        };
        ctx.document.artboards.push(artboard);
        return ok({ artboardId: artboard.id });
      },
    },
    {
      kind: 'action',
      id: 'duplicate',
      title: 'Duplicate',
      description:
        'Copies layers or artboards with everything on them, offset by dx and dy, and selects the copies. With no offset a copy ' +
        'lies exactly on its original.',
      control: 'Edit › Duplicate',
      effect: 'edit',
      input: {
        type: 'object',
        properties: { ids, dx: { type: 'number', ...px }, dy: { type: 'number', ...px } },
        required: ['ids'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const given = input.ids as string[];
        const gone = missing(ctx, given);
        if (gone) return gone;
        const copies: string[] = [];
        for (const id of given) {
          const artboard = ctx.document.artboards.find(a => a.id === id);
          if (artboard) {
            const copy = { ...artboard, id: ctx.newId('artboard'), name: `${artboard.name} copy`, x: artboard.x + ((input.dx as number) ?? 0), y: artboard.y + ((input.dy as number) ?? 0) };
            ctx.document.artboards.push(copy);
            for (const layer of ctx.document.layers.filter(l => l.artboardId === id)) {
              ctx.document.layers.push({ ...layer, id: ctx.newId('layer'), artboardId: copy.id });
            }
            copies.push(copy.id);
          } else {
            const layer = ctx.document.layers.find(l => l.id === id)!;
            const board = ctx.document.artboards.find(a => a.id === layer.artboardId)!;
            const copy: CanvasLayer = {
              ...layer,
              id: ctx.newId('layer'),
              position: [layer.position[0] + ((input.dx as number) ?? 0) / board.width, layer.position[1] + ((input.dy as number) ?? 0) / board.height],
            };
            ctx.document.layers.push(copy);
            copies.push(copy.id);
          }
        }
        ctx.document.selection = copies;
        return ok({ selection: copies });
      },
    },
    {
      kind: 'action',
      id: 'move-artboard',
      title: 'Move an artboard',
      description: 'Puts an artboard’s top left at a place on the board.',
      control: 'Dragging the artboard’s name',
      effect: 'edit',
      input: {
        type: 'object',
        properties: { id: { type: 'string', ...artboardRef }, x: { type: 'number', ...px }, y: { type: 'number', ...px } },
        required: ['id', 'x', 'y'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const artboard = ctx.document.artboards.find(a => a.id === input.id);
        if (!artboard) return fail('NO_SUCH_ARTBOARD', `No artboard with id "${String(input.id)}"`);
        artboard.x = input.x as number;
        artboard.y = input.y as number;
        return ok({ id: artboard.id, x: artboard.x, y: artboard.y });
      },
    },
    {
      kind: 'action',
      id: 'rename',
      title: 'Rename',
      description: 'Renames a layer or an artboard.',
      control: 'Double-clicking its name',
      effect: 'edit',
      input: {
        type: 'object',
        properties: { id: { type: 'string', ...anyRef }, name: { type: 'string', minLength: 1 } },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const row = find(ctx, String(input.id));
        if (!row) return missing(ctx, [String(input.id)])!;
        row.name = String(input.name);
        return ok({ id: row.id, name: row.name });
      },
    },
    {
      kind: 'action',
      id: 'add-text',
      title: 'Add text',
      description: after
        ? 'Sets new text on an artboard with its first baseline starting at (x, y): the letters stand on y and rise above it.'
        : 'Sets new text on an artboard at (x, y).',
      control: 'The Type tool',
      effect: 'edit',
      input: {
        type: 'object',
        properties: {
          artboard_id: { type: 'string', ...artboardRef },
          x: { type: 'number', ...(after ? { 'x-unit': 'px', 'x-space': 'artboard' } : {}) },
          y: { type: 'number', ...(after ? { 'x-unit': 'px', 'x-space': 'artboard' } : {}) },
          text: { type: 'string', minLength: 1 },
          size: { type: 'number', minimum: 1, ...px },
          fill: { type: 'string', description: 'A CSS colour' },
        },
        required: ['artboard_id', 'x', 'y', 'text'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const artboard = ctx.document.artboards.find(a => a.id === input.artboard_id);
        if (!artboard) return fail('NO_SUCH_ARTBOARD', `No artboard with id "${String(input.artboard_id)}"`);
        const layer: CanvasLayer = {
          id: ctx.newId('layer'),
          name: 'Text',
          kind: 'text',
          artboardId: artboard.id,
          text: String(input.text),
          size: (input.size as number) ?? 96,
          fill: (input.fill as string) ?? '#000000',
          opacity: 100,
          position: [(input.x as number) / artboard.width, (input.y as number) / artboard.height],
          anchor: [0, 0],
          scale: 100,
        };
        ctx.document.layers.push(layer);
        return ok({ layerId: layer.id, artboardId: artboard.id });
      },
    },
    {
      kind: 'action',
      id: 'set-properties',
      title: 'Set properties',
      description: 'Sets a text layer’s size, colour or opacity on every layer named. A locked layer cannot be changed.',
      control: 'The Design panel',
      effect: 'edit',
      input: {
        type: 'object',
        properties: {
          ids: { ...ids, description: 'The layers', ...layerRef },
          values: {
            type: 'object',
            properties: {
              size: { type: 'number', minimum: 1, ...px },
              fill: { type: 'string', description: 'A CSS colour' },
              opacity: { type: 'number', minimum: 0, maximum: 100, ...(after ? { 'x-unit': '%' } : {}) },
            },
            additionalProperties: false,
          },
        },
        required: ['ids', 'values'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const given = input.ids as string[];
        const layers = given.map(id => ctx.document.layers.find(l => l.id === id));
        const unknown = given.find((_, i) => !layers[i]);
        if (unknown) return fail('NO_SUCH_LAYER', `No layer with id "${unknown}" — read the room’s document observation for ids`);
        const locked = layers.filter(l => l!.locked);
        if (locked.length > 0) {
          return fail(
            'LOCKED',
            `Nothing was changed: ${locked.map(l => l!.id).join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked. Set the others without ${
              locked.length === 1 ? 'it' : 'them'
            }.`,
          );
        }
        const values = input.values as Partial<Pick<CanvasLayer, 'size' | 'fill' | 'opacity'>>;
        for (const layer of layers) Object.assign(layer!, values);
        return ok({ set: values, ids: given });
      },
    },
    {
      kind: 'action',
      id: 'set-motion',
      title: 'Set position, anchor or scale',
      description: after
        ? 'Sets a layer’s transform: its position, its anchor point and its scale in percent. What is not given is left as it is.'
        : 'Sets a layer’s transform: its position, its anchor point and its scale. What is not given is left as it is.',
      control: 'The Timeline’s Transform lanes',
      effect: 'edit',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', ...layerRef },
          position: point(POSITION_MEASURE, 'artboard-fraction'),
          anchor: point(ANCHOR_MEASURE, 'layer-content-as-artboard-fraction'),
          scale: { type: 'number', minimum: 0, ...(after ? { 'x-unit': '%' } : {}) },
        },
        required: ['id'],
        additionalProperties: false,
      },
      run: (ctx, input) => {
        const layer = ctx.document.layers.find(l => l.id === input.id);
        if (!layer) return fail('NO_SUCH_LAYER', `No layer with id "${String(input.id)}" — read the room’s document observation for ids`);
        if (layer.locked) return fail('LOCKED', `${layer.id} is locked`);
        if (input.position) layer.position = input.position as [number, number];
        if (input.anchor) layer.anchor = input.anchor as [number, number];
        if (typeof input.scale === 'number') layer.scale = input.scale;
        return ok({ id: layer.id });
      },
    },
    ...(after ? (roomReaders<Ctx>({ title: 'Design Canvas' }, LISTS) as unknown as RoomAction<Ctx, Record<string, unknown>>[]) : []),
  ];
  return all as unknown as RoomAction<Ctx, never>[];
}

const toolName = (id: string) => `canvas_${id.replace(/-/g, '_')}`;

function documentSchema(platform: Platform): JsonSchema {
  const rows = (list: RoomList<Ctx>) => (platform === 'after' ? { 'x-rows': list.rows } : {});
  return {
    type: 'object',
    properties: {
      selection: { type: 'array', items: { type: 'string' } },
      artboards: { type: 'array', ...rows(ARTBOARDS), items: { type: 'object' } },
      layers: { type: 'array', ...rows(LAYERS), items: { type: 'object' } },
    },
  };
}

export interface CanvasRoom {
  document: CanvasDocument;
  surface: OUISurface;
  observations(): Record<string, Record<string, unknown>>;
  channel: UIActionChannel;
  /** Every request the room was sent, in order. */
  requests: OUIActionRequest[];
}

/** The room, holding `document`, as a tab would offer and answer it. */
export function createCanvasRoom(document: CanvasDocument, platform: Platform): CanvasRoom {
  let n = 0;
  const ctx: Ctx = { document, newId: prefix => `${prefix}-new-${String(++n).padStart(3, '0')}` };
  const entries = actions(platform);
  const byTool = new Map(entries.map(a => [toolName(a.id), a]));
  const surface: OUISurface = {
    id: ROOM_ID,
    name: 'Design Canvas',
    description:
      'Text on artboards. Geometry is in an artboard’s pixels, origin at its top left, y down. A layer is placed by its position and its anchor.',
    actions: entries.map(a => ({
      id: toolName(a.id),
      title: a.title,
      description: `${a.title}: ${a.description} (${a.control})`,
      input: a.input as never,
      effect: a.effect as never,
    })),
    observations: [
      {
        id: 'document',
        description: 'The artwork: every artboard with its place on the board (x, y: its top left, in board pixels) and its size, and every layer with its id, the artboard it is on and its box in that artboard’s pixels.',
        schema: documentSchema(platform) as never,
      },
    ],
  } as OUISurface;

  const observations = () => ({
    [ROOM_ID]: {
      document: {
        selection: [...document.selection],
        artboards: ARTBOARDS.list(ctx),
        layers: LAYERS.list(ctx),
      },
    },
  });

  const requests: OUIActionRequest[] = [];
  const answers = new Map<string, OUIActionResult>();

  const execute = (request: OUIActionRequest): OUIActionResult => {
    const entry = byTool.get(request.actionId) as RoomAction<Ctx, Record<string, unknown>> | undefined;
    const base = { requestId: request.requestId, timestamp: Date.now() };
    if (!entry) return { ...base, success: false, error: { code: 'ACTION_NOT_FOUND', message: `No action ${request.actionId}` }, observations: observations() };
    let input = request.params as Record<string, unknown>;
    if (platform === 'after') {
      const resolved = resolveInputRefs(entry.input, input, listLookup(LISTS, ctx));
      if ('error' in resolved) {
        const { code, message } = resolved.error as { code: string; message: string };
        return { ...base, success: false, error: { code, message }, observations: observations() };
      }
      input = resolved.input as Record<string, unknown>;
    }
    const before = JSON.stringify(document);
    const snapshot = new Map([...document.layers, ...document.artboards].map(r => [r.id, JSON.stringify(r)]));
    const result = entry.run(ctx, input) as RoomResult;
    if (!result.ok) return { ...base, success: false, error: { code: result.code, message: result.message }, observations: observations() };
    let data = result.data ?? {};
    if (platform === 'after' && before !== JSON.stringify(document)) {
      const touched = [...document.layers, ...document.artboards].filter(r => snapshot.get(r.id) !== JSON.stringify(r)).map(r => r.id);
      data = { ...data, changed: changedRows(LISTS, ctx, touched.slice(0, 8)) };
    }
    return { ...base, success: true, data, observations: observations() };
  };

  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      requests.push(request);
      if (!answers.has(request.requestId)) answers.set(request.requestId, execute(request));
      return undefined;
    },
    awaitResult: async requestId => answers.get(requestId) ?? null,
  };

  return { document, surface, observations, channel, requests };
}

/** A board of `count` artboards named "Anim 01"…, each with one wordmark, as the 2026-10-02 session's was. */
export function wordmarkBoard(count: number, text = 'TRAIDR'): CanvasDocument {
  // Ids as a real document's are: nothing in one says which artboard it is, so none can be guessed from another.
  const hex = (n: number) => (Math.imul(n + 1, 2654435761) >>> 0).toString(16).padStart(8, '0');
  const artboards: CanvasArtboard[] = Array.from({ length: count }, (_, i) => ({
    id: `artboard-${hex(i)}-${hex(i + 7919).slice(0, 4)}`,
    name: `Anim ${String(i + 1).padStart(2, '0')}`,
    x: i * 1000,
    y: 0,
    width: 900,
    height: 500,
  }));
  const layers: CanvasLayer[] = artboards.map((a, i) => ({
    id: `layer-${hex(i + 104729)}-${hex(i + 1299709).slice(0, 4)}`,
    name: 'Text',
    kind: 'text',
    artboardId: a.id,
    text,
    size: 96,
    fill: '#ffffff',
    opacity: 100,
    position: [0.2, 0.6],
    anchor: [0, 0],
    scale: 100,
  }));
  return { artboards, layers, selection: [] };
}
