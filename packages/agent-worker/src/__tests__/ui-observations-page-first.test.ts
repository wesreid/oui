/**
 * Over budget, the page the model is working on comes first; a long list in the
 * shell never crowds it out.
 *
 * On dev the PA added a document to a knowledge base and could not see it: the
 * page state was cut at its first 6,000 characters, which were the app shell and
 * the Studio Shell's project list (dozens of projects), and the knowledge base's
 * own state never reached the model. Now long lists are shortened to
 * MAX_LIST_ROWS plus how many more, the surface the action acted on comes first
 * and the shells last, and only what still does not fit is cut.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LIST_ROWS, boundObservations, observationsText } from '../ui/observations.js';

const projects = Array.from({ length: 180 }, (_, i) => ({
  key: `7c6a7339-6e48-4e96-a1e5-${String(i).padStart(12, '0')}`,
  title: `E2E Project ${1783938342040 + i}`,
}));

/** In mount order, as the tab reports it: the shells first, the page last. */
const observations = {
  'app-shell': { current_location: { path: '/characters/knowledge/kb1' } },
  'shell:StudioShell': {
    state: { values: { 'shell.theme': 'twilight' }, lists: { 'shell.project.choose': projects }, unavailable: [] },
  },
  'page:KnowledgeBaseDetailPage': {
    state: {
      values: {},
      lists: { 'knowledge.kb.document-remove': [{ key: 'd1', title: 'Hours' }] },
      unavailable: [],
      busy: ['knowledge.kb.document-add'],
    },
  },
};

describe('the page state over budget', () => {
  it('keeps the page the model acted on whole when a shell list is long', () => {
    expect(JSON.stringify(observations).length).toBeGreaterThan(6_000);
    const bounded = boundObservations(observations, 6_000, 'page:KnowledgeBaseDetailPage') as {
      truncated: boolean;
      values?: Record<string, unknown>;
      preview?: string;
    };
    expect(bounded.truncated).toBe(true);
    // Shortening the lists made it fit: nothing is cut.
    expect(bounded.preview).toBeUndefined();
    const values = bounded.values!;
    expect(Object.keys(values)[0]).toBe('page:KnowledgeBaseDetailPage');
    expect(Object.keys(values).slice(-2)).toEqual(['app-shell', 'shell:StudioShell']);
    expect(values['page:KnowledgeBaseDetailPage']).toEqual(observations['page:KnowledgeBaseDetailPage']);
    const shortened = (values['shell:StudioShell'] as { state: { lists: Record<string, unknown[]> } }).state.lists[
      'shell.project.choose'
    ];
    // Every row it keeps still names its project; the rest are counted, with how to reach them (ADR-0244 §2.1).
    expect(shortened).toHaveLength(40 + 1);
    expect(shortened.slice(0, 40)).toEqual(projects.slice(0, 40).map(({ key, title }) => ({ key, title })));
    expect(shortened.at(-1)).toBe('… and 140 more rows, not listed to fit the page state; name a row by its title');
  });

  it('when lists shortened to 20 rows still do not fit, shortens them further before cutting anything', () => {
    const bounded = boundObservations(observations, 900, 'page:KnowledgeBaseDetailPage') as {
      values?: Record<string, { state: { lists: Record<string, unknown[]> } }>;
      preview?: string;
    };
    expect(bounded.preview).toBeUndefined();
    const values = bounded.values!;
    expect(values['page:KnowledgeBaseDetailPage']).toEqual(observations['page:KnowledgeBaseDetailPage']);
    const shortened = values['shell:StudioShell'].state.lists['shell.project.choose'];
    expect(shortened.length).toBeLessThan(MAX_LIST_ROWS);
    expect(String(shortened.at(-1))).toMatch(/more|rows, not listed/);
  });

  it('puts the pages before the shells on the user’s message’s page state too', () => {
    const text = observationsText(observations, 900);
    expect(text.indexOf('page:KnowledgeBaseDetailPage')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('page:KnowledgeBaseDetailPage')).toBeLessThan(text.indexOf('shell:StudioShell'));
  });

  it('is unchanged when it fits', () => {
    const small = { 'app-shell': { current_location: { path: '/' } }, 'page:Home': { state: { values: {} } } };
    expect(boundObservations(small, 6_000, 'page:Home')).toBe(small);
  });
});
