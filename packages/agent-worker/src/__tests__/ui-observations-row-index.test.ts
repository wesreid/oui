/**
 * A list too long for the page state keeps an index of its rows, never a bare
 * count (ADR-0244 §2.1).
 *
 * The case is the vector studio session of 2026-10-02: a board of 20 artboards
 * and 19 text layers, whose document observation the 6,000-character budget
 * cut to `"19 rows, not listed to fit the page state; name a row by its title"`
 * — so the assistant could name no layer, and asked the person for ids. With
 * the lists declared (`x-rows`), every row stays addressable: its id, what it
 * is called, and the few facts that tell rows apart; the selection and the rows
 * an action just changed stay whole.
 */
import { describe, expect, it } from 'vitest';

import { boundObservations, observationSchemas, observationsText } from '../ui/observations.js';

const ROOM = 'room:vector-studio';

const documentSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    selection: { type: 'array', items: { type: 'string' } },
    artboards: {
      type: 'array',
      'x-rows': { ref: 'id', title: 'name', index: ['width', 'height'], selection: 'selection' },
      items: { type: 'object' },
    },
    layers: {
      type: 'array',
      'x-rows': { ref: 'id', title: 'name', index: ['kind', 'artboardId'], selection: 'selection' },
      items: { type: 'object' },
    },
  },
};

const surfaces = [
  { id: ROOM, observations: [{ id: 'document', schema: documentSchema }, { id: 'problems', schema: { type: 'array' } }] },
  { id: 'shell:StudioShell', observations: [{ id: 'state', schema: { type: 'object' } }] },
];

const artboardId = (i: number) => `vector-artboard-${String(i).padStart(4, '0')}-9c1d-4e0a94314a38`;
const layerId = (i: number) => `vector-layer-${String(i).padStart(4, '0')}-bb5a-beb0d02da6ae`;

/** The session's board: artboards named as the assistant named them, one TRAIDR wordmark on each. */
function board(count: number, selection: string[] = []) {
  return {
    name: 'TRAIDR — Logo Concepts',
    selection,
    artboards: Array.from({ length: count }, (_, i) => ({
      id: artboardId(i),
      name: `Anim ${String(i + 1).padStart(2, '0')} — Variation`,
      width: 900,
      height: 500,
      layerCount: 1,
    })),
    layers: Array.from({ length: count }, (_, i) => ({
      id: layerId(i),
      name: 'Text',
      kind: 'text',
      artboardId: artboardId(i),
      box: [155.7, 153.2, 588.6, 193.6],
      text: 'TRAIDR',
      face: 'Inter-ExtraBold',
      styles: [
        { start: 0, end: 2, face: 'Inter-ExtraBold', size: 160, fill: { kind: 'solid', color: '#d0d0d0' } },
        { start: 2, end: 4, face: 'Inter-ExtraBold', size: 160, fill: { kind: 'solid', color: '#41c8ff' } },
        { start: 4, end: 6, face: 'Inter-ExtraBold', size: 160, fill: { kind: 'solid', color: '#d0d0d0' } },
      ],
      appearance: [{ id: 'fill-1', kind: 'fill', paint: { kind: 'solid', color: '#d0d0d0' } }],
    })),
  };
}

const observations = (count: number, selection: string[] = []) => ({
  'shell:StudioShell': { state: { values: { 'shell.theme': 'twilight' }, lists: {}, unavailable: [] } },
  [ROOM]: { document: board(count, selection), problems: [] },
});

interface Bounded {
  truncated: boolean;
  note: string;
  values?: Record<string, { document: ReturnType<typeof board> & { layers: unknown[]; artboards: unknown[] } }>;
  preview?: string;
}

const fit = (count: number, maxChars: number, options: { selection?: string[]; changed?: string[] } = {}) =>
  boundObservations(observations(count, options.selection), maxChars, ROOM, {
    schemas: observationSchemas(surfaces),
    changed: options.changed,
  }) as Bounded;

describe('a declared list over budget keeps an index of every row', () => {
  it('names every artboard and every layer of the session’s 20-artboard board within 6,000 characters', () => {
    expect(JSON.stringify(observations(20)).length).toBeGreaterThan(6_000);
    const bounded = fit(20, 6_000);
    expect(bounded.preview).toBeUndefined();
    const document = bounded.values![ROOM].document;

    // Every row is there, addressable: none is a count.
    expect(document.artboards).toHaveLength(20);
    expect(document.layers).toHaveLength(20);
    expect(document.artboards.every((row) => typeof row === 'object')).toBe(true);
    expect(document.layers.every((row) => typeof row === 'object')).toBe(true);

    // "Anim 07" is findable, with the layer on it.
    const anim07 = (document.artboards as { id: string; name: string }[]).find((a) => a.name.startsWith('Anim 07'))!;
    expect(anim07).toEqual({ id: artboardId(6), name: 'Anim 07 — Variation', width: 900, height: 500 });
    const onIt = (document.layers as { id: string; artboardId: string }[]).filter((l) => l.artboardId === anim07.id);
    expect(onIt.map((l) => l.id)).toEqual([layerId(6)]);

    // The rows cut to their index hold what addresses them, what they are called and what tells them apart: nothing else.
    const indexed = (document.layers as Record<string, unknown>[]).filter((l) => l.box === undefined);
    expect(indexed.length).toBeGreaterThan(0);
    for (const row of indexed) expect(Object.keys(row).sort()).toEqual(['artboardId', 'id', 'kind', 'name']);
    expect(bounded.note).toContain('index rows');
  });

  it('keeps the selected rows and the rows the action changed whole', () => {
    const selected = layerId(17);
    const changed = layerId(11);
    const bounded = fit(20, 6_000, { selection: [selected], changed: [changed] });
    const layers = bounded.values![ROOM].document.layers as { id: string; box?: number[]; styles?: unknown[] }[];
    for (const id of [selected, changed]) {
      const row = layers.find((l) => l.id === id)!;
      expect(row.box).toEqual([155.7, 153.2, 588.6, 193.6]);
      expect(row.styles).toHaveLength(3);
    }
  });

  it('on a board of 400 artboards, says how many index rows it left out and how to read them', () => {
    const bounded = fit(400, 6_000);
    expect(bounded.preview).toBeUndefined();
    const layers = bounded.values![ROOM].document.layers;
    const tail = layers.at(-1);
    expect(typeof tail).toBe('string');
    expect(tail).toMatch(/^… and \d+ more rows, not listed to fit the page state; read them with this surface’s query tool/);
    // Every row before the tail is still an index row a tool can be given.
    const rows = layers.slice(0, -1) as { id: string; name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.every((row) => row.id.startsWith('vector-layer-') && row.name === 'Text')).toBe(true);
    const left = Number(/and (\d+) more/.exec(String(tail))![1]);
    expect(rows.length + left).toBe(400);
  });

  it('fits the user’s message’s page state the same way', () => {
    const text = observationsText(observations(20), 6_000, { schemas: observationSchemas(surfaces) });
    for (let i = 0; i < 20; i++) {
      expect(text).toContain(artboardId(i));
      expect(text).toContain(layerId(i));
    }
    expect(text).toContain('index rows');
  });

  it('without the declaration, the same board is cut to a count — the failure this replaces', () => {
    const bounded = boundObservations(observations(20), 6_000, ROOM) as Bounded;
    const layers = bounded.values![ROOM].document.layers;
    expect(layers.some((row) => typeof row === 'string')).toBe(true);
  });
});
