/**
 * Over budget, the item open in a detail panel keeps its fields and facts whole
 * beside a long list on the same page.
 *
 * On dev, /voices lists every voice (open, select, duplicate, download: one row
 * each per voice) on the same page surface as the open voice's detail panel.
 * Putting the acting page first was not enough: the page itself was over budget,
 * its long lists shortened to 20 rows still did not fit, and the cut took the
 * panel's fields and its engine choices. Now long lists are shortened further,
 * then only counted, before anything else is cut; fields, what is unavailable or
 * busy, the page's own facts, chosen rows and lists of five rows or fewer are
 * never shortened.
 */
import { describe, expect, it } from 'vitest';
import { WHOLE_LIST_ROWS, boundObservations, observationsText } from '../ui/observations.js';

const voices = Array.from({ length: 140 }, (_, i) => ({
  key: `3f2b8c1e-5a47-4d0e-9b61-${String(i).padStart(12, '0')}`,
  title: `Narrator voice ${i + 1}`,
}));
const OPEN = voices[97];

const engines = [
  { key: 'omnivoice', title: 'OmniVoice' },
  { key: 'fish_s2', title: 'Fish S2' },
  { key: 'chatterbox', title: 'Chatterbox' },
];

/** The detail panel's own state: what must reach the model whole. */
const detail = {
  values: {
    'voices.detail.variant': OPEN.key,
    'voices.detail.description': 'Warm, unhurried documentary narrator. '.repeat(6),
    'voices.detail.reference-text':
      'The river bends twice before it reaches the old mill, and both times it slows. '.repeat(5),
    'voices.detail.preview-script': 'Welcome back. Today we follow the river to the sea. '.repeat(4),
    'voices.detail.preview-speed': 1,
    'voices.detail.preview-language': 'en',
  },
  unavailable: ['voices.detail.save', 'voices.detail.edit-cancel'],
  busy: ['voices.engines.compare'],
  shown: [
    {
      id: 'voices.detail.facts',
      title: OPEN.title,
      facts: {
        Engine: 'OmniVoice',
        Type: 'Cloned',
        Created: '28 Sep 2026',
        Presets: '2',
      },
    },
  ],
};

function voicesPage() {
  const rows = (id: string) =>
    voices.map((v) => ({
      ...v,
      ...(id === 'voices.select' ? { value: v === OPEN } : {}),
    }));
  return {
    'app:navigation': { location: { path: '/voices' } },
    'shell:StudioShell': {
      state: {
        values: { 'shell.theme': 'twilight' },
        lists: {
          'shell.project.choose': Array.from({ length: 60 }, (_, i) => ({
            key: `p${i}`,
            title: `E2E Project ${i}`,
          })),
        },
        unavailable: [],
      },
    },
    'page:VoicesPage': {
      state: {
        values: detail.values,
        lists: {
          'voices.open': rows('voices.open'),
          'voices.select': rows('voices.select'),
          'voices.duplicate': rows('voices.duplicate'),
          'voices.download-source': rows('voices.download-source'),
          'voices.engines.use': engines,
          'voices.engines.play-take': engines,
        },
        unavailable: detail.unavailable,
        busy: detail.busy,
        shown: [
          ...detail.shown,
          // A card per voice, each with its facts: a list, shortened like one.
          ...voices.map((v) => ({
            id: 'voices.card',
            title: v.title,
            facts: { Type: 'Cloned' },
            item: v,
          })),
        ],
      },
    },
  };
}

type PageState = {
  values: Record<string, unknown>;
  lists: Record<string, unknown[]>;
  unavailable: string[];
  busy?: string[];
  shown: Array<{ id: string }>;
};

describe('the page state over budget, with a big list and an open detail panel', () => {
  const observations = voicesPage();

  it('keeps the open voice’s fields, facts and engine choices whole and compacts the voice lists', () => {
    expect(JSON.stringify(observations).length).toBeGreaterThan(40_000);
    const bounded = boundObservations(observations, 6_000, 'page:VoicesPage') as {
      note: string;
      values?: Record<string, { state: PageState }>;
      preview?: string;
    };
    expect(bounded.preview).toBeUndefined();
    const page = bounded.values!['page:VoicesPage'].state;
    expect(Object.keys(bounded.values!)[0]).toBe('page:VoicesPage');

    // The panel, whole.
    expect(page.values).toEqual(detail.values);
    expect(page.unavailable).toEqual(detail.unavailable);
    expect(page.busy).toEqual(detail.busy);
    expect(page.shown.filter((s) => s.id === 'voices.detail.facts')).toEqual(detail.shown);
    expect(page.lists['voices.engines.use']).toEqual(engines);
    expect(page.lists['voices.engines.play-take']).toEqual(engines);

    // The voice lists, compacted: the chosen voice is still there.
    for (const id of ['voices.open', 'voices.duplicate', 'voices.download-source']) {
      expect(page.lists[id].length).toBeLessThan(voices.length);
      expect(String(page.lists[id].at(-1))).toMatch(/more|rows, not listed/);
    }
    expect(page.lists['voices.select']).toContainEqual({
      ...OPEN,
      value: true,
    });
    expect(page.shown.filter((s) => s.id === 'voices.card').length).toBeLessThan(voices.length);

    // The shell's list is compacted too.
    const shell = bounded.values!['shell:StudioShell'].state;
    expect(shell.lists['shell.project.choose'].length).toBeLessThanOrEqual(WHOLE_LIST_ROWS + 1);
    expect(bounded.note).toContain('kept whole');
  });

  it('never shortens a list of five rows or fewer, however tight the budget', () => {
    const bounded = boundObservations(observations, 3_000, 'page:VoicesPage') as {
      values?: Record<string, { state: PageState }>;
      preview?: string;
    };
    expect(bounded.preview).toBeUndefined();
    const page = bounded.values!['page:VoicesPage'].state;
    expect(page.values).toEqual(detail.values);
    expect(page.lists['voices.engines.use']).toHaveLength(Math.min(engines.length, WHOLE_LIST_ROWS));
    expect(page.lists['voices.open']).toEqual(['140 rows, not listed to fit the page state; name a row by its title']);
    expect(page.lists['voices.select']).toEqual([
      { ...OPEN, value: true },
      '… and 139 more rows, not listed to fit the page state; name a row by its title',
    ]);
  });

  it('leaves out the shells before cutting the page, and says so', () => {
    const bounded = boundObservations(observations, 2_200, 'page:VoicesPage') as {
      note: string;
      values?: Record<string, { state: PageState }>;
      preview?: string;
    };
    expect(bounded.preview).toBeUndefined();
    expect(Object.keys(bounded.values!)).toEqual(['page:VoicesPage']);
    expect(bounded.values!['page:VoicesPage'].state.values).toEqual(detail.values);
    expect(bounded.note).toContain('left out to fit: shell:StudioShell, app:navigation');
  });

  it('fits the user’s message’s page state the same way', () => {
    const text = observationsText(observations, 6_000);
    expect(text).not.toContain('truncated from');
    expect(text).toContain(JSON.stringify(detail.values));
    expect(text).toContain('fitted from');
  });
});
