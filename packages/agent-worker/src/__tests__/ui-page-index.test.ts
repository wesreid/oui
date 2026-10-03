/**
 * The page as the worker holds it (ADR-0245 §2.1, §2.2): one index, whichever
 * form the client sent, and the lines the model reads of it.
 */
import { describe, expect, it } from 'vitest';
import { surfaceIndex, type OUISurface } from 'oui-spec/spec';
import {
  definitionKey,
  indexDiff,
  indexLine,
  indexText,
  pageActions,
  pageFingerprint,
  pageFromIndex,
  pageFromSurfaces,
  type HeldDefinitions,
} from '../ui/page-index.js';

const shell: OUISurface = {
  id: 'app-shell',
  name: 'App Shell',
  description: 'The frame around every page',
  actions: [{ id: 'navigate', description: 'Go to a page. The address is one of the app’s routes.', input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
};
const reports: OUISurface = {
  id: 'reports',
  name: 'Reports',
  description: 'Saved reports',
  observations: [{ id: 'reports', description: 'The saved reports', schema: { type: 'array', 'x-rows': { ref: 'id', title: 'title' } } }],
  actions: [
    { id: 'reports_export', description: 'Export a report', async: true, estimatedDuration: '30-60s', polling: { intervalMs: 1000, maxDurationMs: 120_000 }, input: { type: 'object', properties: {} } },
    { id: 'reports_send', title: 'Send a report', description: 'Emails a saved report. Once sent it cannot be unsent.', effect: 'transaction', input: { type: 'object', required: ['reportId', 'to'], properties: { reportId: { type: 'string' }, to: { type: 'string' } } } },
    { id: 'reports_query', description: 'Finds reports by title.', effect: 'view', input: { type: 'object', properties: { title_contains: { type: 'string' } } } },
    { id: 'reports_delete', description: 'Deletes a report.', confirm: true, input: { type: 'object', required: ['reportId'], properties: { reportId: { type: 'string' } } } },
  ],
};

describe('the page, from either form a client sends', () => {
  it('is the same from definitions as from the index a client would have sent, and keeps the definitions', () => {
    const held: HeldDefinitions = new Map();
    const fromFull = pageFromSurfaces([shell, reports], held);
    const fromIndex = pageFromIndex([surfaceIndex(shell), surfaceIndex(reports)]);
    expect(fromFull).toEqual(fromIndex);
    expect(pageFingerprint(fromFull)).toBe(pageFingerprint(fromIndex));
    // Each definition is held under its action and its hash: good until the action changes.
    expect(held.size).toBe(5);
    const send = fromFull[1].index[1];
    expect(held.get(definitionKey('reports', send))).toBe(reports.actions[1]);
    // The observation definitions travel whole: they say how to read the rows.
    expect(fromIndex[1].observations).toEqual(reports.observations);
  });

  it('gives an action id to the first surface that offers it, and names the collision', () => {
    const twice: OUISurface = { ...shell, id: 'other-shell', name: 'Other' };
    const { actions, collisions } = pageActions(pageFromSurfaces([shell, twice], new Map()));
    expect(actions.map((a) => [a.surface.id, a.entry.id])).toEqual([['app-shell', 'navigate']]);
    expect(collisions).toEqual([{ actionId: 'navigate', keptSurface: 'app-shell', droppedSurface: 'other-shell' }]);
  });
});

describe('the index as the model reads it', () => {
  const page = pageFromSurfaces([shell, reports], new Map());

  it('gives each action a line: its id, what it does, what it takes, and what running it involves', () => {
    expect(page[1].index.map(indexLine)).toEqual([
      '- reports_export: Export a report (takes nothing; waits for its work, 30-60s)',
      '- reports_send: Emails a saved report. (takes reportId: string, to: string; needs approval)',
      '- reports_query: Finds reports by title. (takes title_contains?: string; reads)',
      '- reports_delete: Deletes a report. (takes reportId: string; needs approval)',
    ]);
  });

  it('lists every surface with its actions, and past its budget lists the furthest by id only, never dropping one', () => {
    const whole = indexText(page);
    expect(whole).toContain('App Shell (app-shell): The frame around every page\n- navigate: Go to a page. (takes path: string)');
    expect(whole).toContain('Reports (reports): Saved reports\n- reports_export: ');
    const tight = indexText(page, 200);
    expect(tight).toContain('- 4 actions, listed by id only to save room; describe one to learn what it does: reports_export, reports_send, reports_query, reports_delete');
    for (const id of ['navigate', 'reports_export', 'reports_send', 'reports_query', 'reports_delete']) expect(tight).toContain(id);
  });

  it('names what an answer added, changed and removed', () => {
    const changed: OUISurface = {
      ...reports,
      actions: [
        reports.actions[0],
        // The same action, taking one more thing: listed again.
        { ...reports.actions[1], input: { type: 'object', required: ['reportId', 'to'], properties: { reportId: { type: 'string' }, to: { type: 'string' }, cc: { type: 'string' } } } },
        reports.actions[2],
        { id: 'reports_archive', description: 'Archives a report.', input: { type: 'object', properties: {} } },
      ],
    };
    expect(indexDiff(page, pageFromSurfaces([shell, changed], new Map()))).toEqual({
      added: [
        '- reports_send: Emails a saved report. (takes reportId: string, to: string, cc?: string; needs approval)',
        '- reports_archive: Archives a report. (takes nothing)',
      ],
      removed: ['reports_delete'],
    });
    expect(indexDiff(page, page)).toEqual({ added: [], removed: [] });
  });
});
