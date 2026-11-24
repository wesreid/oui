/**
 * The page as the worker holds it: one index, whichever
 * form the client sent, and the lines the model reads of it.
 */
import { describe, expect, it } from 'vitest';
import { surfaceIndex, type OUISurface } from 'oui-spec/spec';
import {
  definitionKey,
  indexDiff,
  indexLine,
  indexText,
  shortInput,
  pageActions,
  pageFingerprint,
  pageFromIndex,
  pageFromSurfaces,
  ambiguousNameError,
  foldedPrefixes,
  resolveActionName,
  sharedIdPrefix,
  sharedPrefixNote,
  type HeldDefinitions,
  type PageSurface,
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
    // An observation travels with what says how to shorten its rows.
    expect(fromIndex[1].observations).toEqual([{ id: 'reports', schema: { 'x-rows': { ref: 'id', title: 'title' } } }]);
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
      '- reports_export: Export a report (waits for its work, 30-60s)',
      '- reports_send: Emails a saved report. (reportId, to; needs approval)',
      '- reports_query: Finds reports by title. (title_contains?; reads)',
      '- reports_delete: Deletes a report. (reportId; needs approval)',
    ]);
  });

  it('lists every surface with its actions, and past its budget lists the furthest by id only, never dropping one', () => {
    const whole = indexText(page);
    expect(whole).toContain('App Shell (app-shell): The frame around every page\n- navigate: Go to a page. (path)');
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
        '- reports_send: Emails a saved report. (reportId, to, cc?; needs approval)',
        '- reports_archive: Archives a report.',
      ],
      removed: ['reports_delete'],
    });
    expect(indexDiff(page, page)).toEqual({ added: [], removed: [] });
  });
});

describe('an index over what the model is given', () => {
  const surface = (id: string, actions: number): PageSurface => ({
    id,
    name: id,
    description: id,
    index: Array.from({ length: actions }, (_, i) => ({
      id: `${id}_${i}`,
      description: 'Does the one thing this control does on this surface of the page.',
      input: 'value: string',
      definitionHash: '00000000',
    })),
  });
  const idsOnly = (text: string, id: string) => new RegExp(`${id} \\(${id}(; [^)]*)?\\): ${id}\\n- \\d+ actions, listed by id only`).test(text);
  // As a client lists them: the frame first, then what mounted, the studio docked last of all.
  const page = [surface('app:navigation', 2), surface('shell:Frame', 20), surface('room:editor', 200), surface('page:Editor', 100), surface('room:studio', 200)];

  it('leaves it whole when it fits', () => {
    expect(indexText(page, 1_000_000)).not.toContain('listed by id only');
  });

  it('lists the frame by id before any page or room', () => {
    const whole = indexText(page, Infinity).length;
    const text = indexText(page, whole - 1);
    expect(idsOnly(text, 'shell:Frame')).toBe(true);
    expect(idsOnly(text, 'room:editor')).toBe(false);
    expect(idsOnly(text, 'room:studio')).toBe(false);
  });

  it('keeps the lines of what mounted last, the studio docked on the page, longest', () => {
    const studio = indexText([surface('room:studio', 200)], Infinity).length;
    const text = indexText(page, studio + 6_500);
    expect(idsOnly(text, 'room:editor')).toBe(true);
    expect(idsOnly(text, 'page:Editor')).toBe(true);
    expect(idsOnly(text, 'room:studio')).toBe(false);
  });

  it('keeps every action findable, whatever it lists by id', () => {
    const text = indexText(page, 100);
    for (const s of page) {
      const prefix = sharedIdPrefix(s);
      if (prefix) expect(text).toContain(sharedPrefixNote(prefix));
      for (const entry of s.index) {
        expect(text).toContain(entry.id.slice(prefix.length));
        // Every surface here numbers its actions alike: a bare number is several surfaces' action, listed by its full ids.
        const meant = resolveActionName(page, entry.id.slice(prefix.length));
        expect(meant && ('id' in meant ? [meant.id] : meant.ambiguous)).toContain(entry.id);
      }
    }
    expect(text.indexOf('app:navigation')).toBeLessThan(text.indexOf('room:studio'));
  });
});

describe('what an action takes, in a line of the index', () => {
  it('keeps an enum’s first values and how many it has, and a number’s range', () => {
    const input = 'preset: rotating-long-shadow|warp-wave-loop|shadow-grow|stroke-draw|…(64), kind: fill|stroke, width: number 0–100 px';
    expect(shortInput(input)).toBe(input);
  });

  it('leaves a text as its name, and says a list or an object is one', () => {
    expect(shortInput('value: string, item?: string, ids?: list of string, paint?: object(4), +3 more')).toBe('value, item?, ids?: list, paint?: object, +3 more');
  });

  it('leaves what has no properties to name as the entry gives it', () => {
    expect(shortInput('one of 60 shapes by effect')).toBe('one of 60 shapes by effect');
    expect(shortInput('number 0–100 px')).toBe('number 0–100 px');
    expect(shortInput('a|b|c')).toBe('a|b|c');
  });
});

describe('the start a surface’s action ids share, said once', () => {
  const room = (id: string, prefix: string, names: string[]): OUISurface => ({
    id,
    name: id,
    description: `The ${id}`,
    actions: names.map((n) => ({ id: `${prefix}${n}`, description: `Does ${n}.`, input: { type: 'object', properties: {} } })),
  });
  const editor = room('room:video-editor', 'video_editor_', ['add_clip', 'remove_clips', 'set_zoom', 'run_command', 'add_marker', 'add_track', 'set_playhead']);
  const studio = room('room:vector-studio', 'vector_studio_', ['add_text', 'add_shape', 'run_command', 'set_grid', 'export', 'add_guide', 'set_swatch']);
  const page = pageFromSurfaces([shell, editor, studio], new Map());

  it('is the longest start of whole words every id shares, leaving each id a word of its own', () => {
    expect(sharedIdPrefix(page[1])).toBe('video_editor_');
    expect(sharedIdPrefix(page[2])).toBe('vector_studio_');
    // One action: no start to share. Ids that share nothing: none.
    expect(sharedIdPrefix(page[0])).toBe('');
    expect(sharedIdPrefix(pageFromSurfaces([room('r', '', ['add_a', 'set_b', 'run_c'])], new Map())[0])).toBe('');
    // Every id is the start and one more word: the last word stays each id's own.
    expect(sharedIdPrefix(pageFromSurfaces([room('r', 'a_b_', ['x', 'y', 'z', 'w', 'v', 'u', 'q', 't'])], new Map())[0])).toBe('');
    // Saying it once would be longer than repeating it.
    expect(sharedIdPrefix(pageFromSurfaces([room('r', 'ab_', ['x_1', 'y_1', 'z_1'])], new Map())[0])).toBe('');
  });

  it('says the start in the surface’s heading once, and each line gives the rest of its id', () => {
    const text = indexText(page);
    expect(text).toContain(`room:video-editor (room:video-editor; ${sharedPrefixNote('video_editor_')}): The room:video-editor\n- add_clip: Does add_clip.`);
    expect(text).toContain('\n- run_command: Does run_command.');
    expect(text).not.toContain('- video_editor_');
    expect(text).not.toContain('- vector_studio_');
    // Shorter than every id written whole, which is what the model was given before.
    expect(text.length).toBeLessThan(indexText(page, Infinity, { foldSharedPrefix: false }).length);
  });

  it('gives every id whole where a line is read on its own', () => {
    const text = indexText(page, Infinity, { foldSharedPrefix: false });
    expect(text).toContain('- video_editor_add_clip: Does add_clip.');
    expect(text).not.toContain(sharedPrefixNote('video_editor_'));
    // What an answer adds is listed whole too.
    const more = pageFromSurfaces([shell, { ...editor, actions: [...editor.actions, { id: 'video_editor_split_clip', description: 'Splits.', input: { type: 'object', properties: {} } }] }, studio], new Map());
    expect(indexDiff(page, more).added).toEqual(['- video_editor_split_clip: Splits.']);
  });

  it('lists a surface by id only with the start still said once', () => {
    const text = indexText(page, 300);
    expect(text).toContain(`${sharedPrefixNote('vector_studio_')}): The room:vector-studio\n- 7 actions, listed by id only to save room; describe one to learn what it does: add_text, add_shape, run_command, set_grid, export, add_guide, set_swatch`);
  });

  it('resolves a full id exactly as before, and a line’s name to the one action it means', () => {
    for (const s of page) for (const entry of s.index) expect(resolveActionName(page, entry.id)).toEqual({ id: entry.id });
    expect(resolveActionName(page, 'add_clip')).toEqual({ id: 'video_editor_add_clip' });
    expect(resolveActionName(page, 'export')).toEqual({ id: 'vector_studio_export' });
    expect(resolveActionName(page, 'navigate')).toEqual({ id: 'navigate' });
    expect(resolveActionName(page, 'add_bus')).toBeNull();
    // A start is never added twice.
    expect(resolveActionName(page, 'video_editor_add_bus')).toBeNull();
  });

  it('never guesses a name more than one surface’s actions end in: it lists their full ids', () => {
    const meant = resolveActionName(page, 'run_command');
    expect(meant).toEqual({ ambiguous: ['video_editor_run_command', 'vector_studio_run_command'] });
    expect(ambiguousNameError('run_command', ['video_editor_run_command', 'vector_studio_run_command'])).toBe(
      '"run_command" names an action on more than one part of the page: video_editor_run_command, vector_studio_run_command. Call it by its full id.',
    );
  });

  it('resolves only to the surface that keeps an id two surfaces declare', () => {
    const twice = room('room:copy', 'video_editor_', ['add_clip', 'remove_clips', 'set_zoom', 'run_command', 'add_marker', 'add_track', 'set_playhead']);
    const both = pageFromSurfaces([editor, twice], new Map());
    expect(resolveActionName(both, 'add_clip')).toEqual({ id: 'video_editor_add_clip' });
  });
});

describe('a start the client declares from its whole catalog', () => {
  const entry = (id: string) => ({ id, description: `Does ${id}.`, input: 'none', definitionHash: '0' });
  const shown = (ids: string[], idPrefix?: string): PageSurface => ({
    id: 'room:storyboard',
    name: 'Storyboard',
    description: 'The Storyboard',
    index: ids.map(entry),
    ...(idPrefix !== undefined ? { idPrefix } : {}),
  });

  it('is the start folded, whatever the actions shown now share, so a name stays the same between turns', () => {
    const now = shown(['storyboard_editor_storyboard_shot_add', 'storyboard_editor_storyboard_shot_move', 'storyboard_editor_storyboard_shot_split'], 'storyboard_editor_storyboard_');
    // Taken from what shows now, the start would swallow `shot_` too, and the names would change as other sections open.
    expect(sharedIdPrefix({ index: now.index })).toBe('storyboard_editor_storyboard_shot_');
    expect(sharedIdPrefix(now)).toBe('storyboard_editor_storyboard_');
    expect(indexText([now])).toContain('- shot_add: Does storyboard_editor_storyboard_shot_add.');
    // One action shown: still folded, still the same name.
    const one = shown(['storyboard_editor_storyboard_shot_add'], 'storyboard_editor_storyboard_');
    expect(indexText([one])).toContain('- shot_add: ');
    expect(resolveActionName([one], 'shot_add')).toEqual({ id: 'storyboard_editor_storyboard_shot_add' });
  });

  it('folds nothing when the client declares there is none, or when an action shown does not start with it', () => {
    const ids = ['video_editor_a', 'video_editor_b', 'video_editor_c', 'video_editor_d', 'video_editor_e', 'video_editor_f', 'video_editor_g'];
    expect(sharedIdPrefix(shown(ids, ''))).toBe('');
    expect(indexText([shown(ids, '')])).toContain('- video_editor_a: ');
    expect(sharedIdPrefix(shown([...ids, 'other_x'], 'video_editor_'))).toBe('');
    // Undeclared, a start is taken from what is offered.
    expect(sharedIdPrefix(shown(ids))).toBe('video_editor_');
  });

  it('arrives with the index a client sends', () => {
    expect(pageFromIndex([{ id: 's', name: 'S', description: 's', index: [entry('studio_a')], idPrefix: 'studio_' }])[0].idPrefix).toBe('studio_');
  });
});

describe('a surface whose folded name would be another action’s full id', () => {
  // As on /audio/compose: the Song room's song_voice_track, and the page's own voice_track.
  const entry = (id: string) => ({ id, description: `Does ${id}.`, input: 'none', definitionHash: '0' });
  const song: PageSurface = {
    id: 'room:song',
    name: 'Song',
    description: 'The song',
    index: ['song_voice_track', 'song_add_track', 'song_set_tempo', 'song_play'].map(entry),
    idPrefix: 'song_',
  };
  const page: PageSurface = { id: 'page:Compose', name: 'Compose', description: 'Compose', index: ['voice_track', 'compose_save'].map(entry) };

  it('keeps its full ids, so the name the page’s own action has runs that action and no other', () => {
    expect(foldedPrefixes([page, song]).get('room:song')).toBe('');
    const text = indexText([page, song]);
    expect(text).toContain('- song_voice_track: ');
    expect(text).toContain('- voice_track: ');
    expect(text).not.toContain(sharedPrefixNote('song_'));
    expect(resolveActionName([page, song], 'voice_track')).toEqual({ id: 'voice_track' });
    expect(resolveActionName([page, song], 'add_track')).toBeNull();
    expect(resolveActionName([page, song], 'song_add_track')).toEqual({ id: 'song_add_track' });
  });

  it('is folded again on a page where nothing has that id', () => {
    expect(foldedPrefixes([song]).get('room:song')).toBe('song_');
    expect(resolveActionName([song], 'voice_track')).toEqual({ id: 'song_voice_track' });
  });
});
