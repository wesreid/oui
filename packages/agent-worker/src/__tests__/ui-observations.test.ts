/**
 * A page's problems reach the model whole, however much else the page
 * reports; and the UI rules tell it to read them before it claims a result.
 */
import { describe, expect, it } from 'vitest';

import { boundObservations, jobStatuses, observationsText, surfaceProblems } from '../ui/observations.js';
import { getUIControlRules } from '../prompt/rules/ui-control.js';

const PROBLEM = {
  kind: 'missing-font',
  message: 'Text hidden: Impact (Impact-Black) is not in the account’s fonts',
  hides: ['text-28'],
};

/**
 * A page whose document alone is far over budget, with one problem: a long
 * layer list, and a path no list shortening can make fit.
 */
function busyPage() {
  const layers = Array.from({ length: 200 }, (_, i) => ({
    id: `shape-${i}`,
    name: 'polygon',
    kind: 'shape',
  }));
  return {
    'app-shell': { current_location: { path: '/vector' } },
    'vector-studio': { document: { layers, path: 'M0 0 L10 10 '.repeat(200) }, problems: [PROBLEM] },
  };
}

describe('page state over budget', () => {
  it('keeps every surface’s problems whole and cuts only the rest', () => {
    const bounded = boundObservations(busyPage(), 600) as Record<string, unknown>;
    expect(bounded.truncated).toBe(true);
    expect(bounded.problems).toEqual({ 'vector-studio': [PROBLEM] });
    expect(String(bounded.preview)).toHaveLength(600);
    expect(String(bounded.preview)).not.toContain('missing-font');
    expect(String(bounded.note)).toContain('problems in full');
  });

  it('is unchanged when it fits', () => {
    const page = { 'vector-studio': { problems: [PROBLEM] } };
    expect(boundObservations(page, 6000)).toBe(page);
    expect(observationsText(page, 6000)).toBe(JSON.stringify(page));
  });

  it('puts the problems first on the user’s message’s page state', () => {
    const text = observationsText(busyPage(), 600);
    expect(text.startsWith('Problems (in full): {"vector-studio":[{"kind":"missing-font"')).toBe(true);
    expect(text).toContain('truncated from');
  });

  it('keeps every job’s status whole too: how the model knows what it started has finished', () => {
    const page = busyPage();
    const status = { status: 'complete', jobId: 'local:1', made: 'Saved to the project as “Promo.gif”.' };
    (page['vector-studio'] as Record<string, unknown>)['page:Editor:export_gif_make:status'] = status;
    const bounded = boundObservations(page, 600) as Record<string, unknown>;
    expect(bounded.jobs).toEqual({ 'vector-studio': { 'page:Editor:export_gif_make:status': status } });
    expect(String(bounded.preview)).not.toContain('Promo.gif');
    expect(String(bounded.note)).toContain('every job’s status in full');
    const text = observationsText(page, 600);
    expect(text).toContain('Jobs (in full): {"vector-studio":{"page:Editor:export_gif_make:status"');
    expect(jobStatuses({ other: { state: {} } })).toBeNull();
  });

  it('reports no problems when no surface has any', () => {
    expect(surfaceProblems({ 'vector-studio': { problems: [] }, other: {} })).toBeNull();
  });
});

describe('the UI rules', () => {
  const rules = getUIControlRules();

  it('have the model read the page’s problems and never claim what the page state does not confirm', () => {
    expect(rules).toContain('`problems` observation');
    expect(rules).toMatch(
      /Never tell the user that something worked, is visible or renders unless the page state confirms it/
    );
    expect(rules).toMatch(/fix it with the page's own actions, or tell the user plainly/);
    expect(rules).toMatch(/Importing a raw file is for the user's own files/);
  });

  it('have the model offer only next steps the page can carry out, and say plainly when none can', () => {
    expect(rules).toMatch(
      /Only suggest a next step, or offer it as an option, when an action in the page's index or a tool in your list can carry it out/
    );
    expect(rules).toMatch(/Never offer something no tool can do/);
    expect(rules).toMatch(
      /When the user asks for something no tool can do, your reply opens with that: the first sentence says it cannot be done here, with no praise or preamble before it, and comes before any action that changes the page/
    );
    expect(rules).toMatch(/Build a substitute only after the user says yes to it, and call it a substitute/);
    expect(rules).toMatch(/no action's description names, even if other actions could imitate it/);
    // A kind an action takes is in its description, not in the index: it is looked up before it is called impossible.
    expect(rules).toMatch(/Look them up with ui_describe before you decide/);
  });

  it('have the model work from the index, describe before it guesses, and never change a page it cannot see', () => {
    expect(rules).toMatch(/Run an action with ui_act: its id exactly as the index gives it/);
    expect(rules).toMatch(/Otherwise call ui_describe first/);
    expect(rules).toMatch(/Never guess a part you have not opened/);
    expect(rules).toMatch(/Never change the page to find out what it shows/);
    expect(rules).toMatch(/nothing that changes the page will run until you have read it/);
  });

  it('name no tool, route or page', () => {
    expect(rules).not.toMatch(/vector|font|svg|text layer/i);
  });
});
