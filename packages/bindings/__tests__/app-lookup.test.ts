/**
 * The app as a whole (`app.ts`) and the tab's lookup over it (`lookup.ts`).
 *
 * On 2026-11-23 the assistant, on a character's page, said it could not
 * remove an object from the character's photo: it knew only that page. The
 * picture editor one page away does it. The lookup searches every action of
 * the build and gives the way to each from the page the person is on, with
 * what it needs first; the tab answers it as `oui.find` and `oui.guide`.
 */
import { createSurfaceRuntime } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';
import { describe, expect, it, vi } from 'vitest';

import {
  actionNeeds,
  actionRank,
  capabilitiesOf,
  createKnowledgeLookup,
  createBindingRegistry,
  describedByActions,
  pageLinks,
  pictureSources,
  searchWords,
  sharedIdPrefix,
  stem,
  surfacesOfPage,
  takesPicture,
  wayTo,
  wayWords,
  type AppPage,
} from '../src/index.js';
import { connectBindings, type AppNavigation } from '../src/oui.js';
import { knowledge, manifest, surfaces } from './support/app-fixture.js';

const pages: AppPage[] = knowledge.pages.map(p => ({ surface: p.surface, routes: p.routes, title: p.summary.title }));
const pageOf = (surface: string) => pages.find(p => p.surface === surface)!;
const actionOf = (name: string) => surfaces.flatMap(s => s.actions).find(a => a.name === name)!;
const roomSurface = surfaces.find(s => s.id === 'room:image-studio')!;

describe('the app as a whole', () => {
  it('gives each page its own surface, its rooms and the frame, and never the navigation', () => {
    expect(surfacesOfPage(pageOf('page:ImageEditorPage'), surfaces).map(p => [p.surface.id, p.part])).toEqual([
      ['page:ImageEditorPage', 'own'],
      ['room:image-studio', 'room'],
      ['shell:StudioShell', 'frame'],
    ]);
  });

  it('ranks what makes something or starts work first, upkeep last, and drops what is inside a dialog', () => {
    expect(actionRank(actionOf('image_studio_generative_remove'))).toBe(0);
    expect(actionRank(actionOf('characters_new'))).toBe(1);
    expect(actionRank(actionOf('characters_delete'))).toBeGreaterThan(actionRank(actionOf('characters_images_set_primary')));
    const caps = capabilitiesOf(surfaces.find(s => s.id === 'page:CharacterDetailPage')!.actions);
    expect(caps.map(c => c.title)).toEqual(['Add Images', 'Set Primary', 'Tabs', 'Remove', 'Rename']);
    expect(caps.find(c => c.title === 'Add Images')!.group).toBe('Images');
    const editor = capabilitiesOf(roomSurface.actions);
    expect(editor.slice(0, 5).map(c => [c.group, c.title])).toEqual([
      ['Edit', 'Remove'],
      ['Edit', 'Generative Fill'],
      ['Edit', 'Edit by Instruction'],
      ['Edit', 'Relight'],
      ['Image', 'Generative Expand'],
    ]);
    // A room's generic entries for fields and commands are not capabilities of their own.
    expect(editor.map(c => c.tool)).not.toContain('image_studio_set_properties');
  });

  it('describes a page by what it offers when it declares nothing', () => {
    expect(describedByActions(roomSurface.actions)).toBe(
      'Offers Remove, Generative Fill, Edit by Instruction, Relight and Generative Expand, among 13 actions.',
    );
    expect(describedByActions([])).toBeNull();
  });

  it('finds the way from a character to the picture editor: its studio by address, then New image or Open', () => {
    const links = pageLinks(pages, surfaces);
    const way = wayTo(pageOf('page:CharacterDetailPage'), pageOf('page:ImageEditorPage'), pages, links)!;
    expect(wayWords(way)).toEqual([
      'Go to Image Studio (/image) with app_navigate.',
      'On Image Studio, open Image Editor with New image [image_home_new] or Open [image_home_open] on the row you want (item).',
    ]);
    expect(wayTo(pageOf('page:ImageEditorPage'), pageOf('page:ImageEditorPage'), pages, links)).toEqual([]);
    expect(wayWords(wayTo(null, pageOf('page:CharactersPage'), pages, links)!)).toEqual(['Go to Characters (/characters) with app_navigate.']);
    // From the studio's home, nothing to go to first.
    expect(wayWords(wayTo(pageOf('page:ImageEditorHomePage'), pageOf('page:ImageEditorPage'), pages, links)!)).toEqual([
      'On Image Studio, open Image Editor with New image [image_home_new] or Open [image_home_open] on the row you want (item).',
    ]);
  });

  it('says what an action needs first: a selection, an open item, a row, approval, an attached file', () => {
    const editor = pageOf('page:ImageEditorPage');
    const remove = actionNeeds(actionOf('image_studio_generative_remove'), editor, roomSurface);
    expect(remove).toEqual([
      'an open item: Image Editor shows one (/image/:imageId)',
      'a selection in the Image Studio: make one with Select an object [image_studio_select_object], Select all [image_studio_select_all], or another of its selection actions',
    ]);
    expect(actionNeeds(actionOf('image_studio_delete_layer'), editor, roomSurface)).toContain("the person's approval of the call");
    expect(actionNeeds(actionOf('characters_images_add_select'), pageOf('page:CharacterDetailPage'))).toEqual([
      'an open item: Character Detail shows one (/characters/:id)',
      'a row of its list: name it with item',
      'the "Images" tab selected (characters_tabs)',
      'the "Add images" dialog open (characters_images_add)',
    ]);
    expect(actionNeeds(actionOf('image_studio_place_image'), editor, roomSurface)).toContain(
      'a file the person attached to the conversation, by its id, where it takes a file',
    );
  });

  it('tells a picture input by what it takes, and the pictures its input names', () => {
    expect(takesPicture(actionOf('image_studio_place_image'))).toBe(true);
    expect(takesPicture(actionOf('characters_images_add_device'))).toBe(true);
    expect(takesPicture(actionOf('image_studio_generative_remove'))).toBe(true);
    expect(pictureSources(actionOf('image_studio_generative_remove'))).toEqual([
      'assetId: A library picture, by id (browse-library).',
    ]);
    expect(takesPicture(actionOf('characters_rename'))).toBe(false);
  });
});

describe('the search’s words', () => {
  it('fold a word’s forms together and drop words that say nothing', () => {
    expect(['remove', 'removed', 'removing', 'removes'].map(stem)).toEqual(['remov', 'remov', 'remov', 'remov']);
    expect(stem('layers')).toBe(stem('layer'));
    expect(stem('galleries')).toBe('gallery');
    expect(searchWords("Remove the basketball from this character's photo")).toEqual(['remov', 'basketball', 'character', 'imag']);
  });

  it('make a photo, a picture, a pic and an image one word, as a person says them interchangeably', () => {
    expect(['photo', 'photos', 'photograph', 'picture', 'pictures', 'pic', 'image', 'images'].flatMap(w => searchWords(w))).toEqual(
      Array(8).fill('imag'),
    );
  });
});

describe('the lookup', () => {
  const at = (path: string) => createKnowledgeLookup({ knowledge, manifest, location: () => path });

  it('finds the editor’s Remove from a character’s page, with the way there and the selection it needs', () => {
    const answer = at('/characters/c_alex').find({ query: 'remove an object from a picture' });
    expect(answer.success).toBe(true);
    const data = (answer as { data: { from: unknown; results: Record<string, unknown>[]; total: number } }).data;
    expect(data.from).toEqual({ page: 'Character Detail', route: '/characters/:id' });
    const top = data.results[0];
    expect(top).toMatchObject({
      capability: 'Remove',
      tool: 'image_studio_generative_remove',
      where: 'Image Editor (/image/:imageId) › Image Studio › Edit › Remove',
      page: 'Image Editor',
      route: '/image/:imageId',
      opensAnItem: true,
      way: [
        'Go to Image Studio (/image) with app_navigate.',
        'On Image Studio, open Image Editor with New image [image_home_new] or Open [image_home_open] on the row you want (item).',
      ],
    });
    expect(top.what).toBe(
      'Removes what is selected and fills the area from what surrounds it, as a new generative layer above the active one, masked to the selection.',
    );
    expect(top.needs).toEqual([
      'a selection in the Image Studio: make one with Select an object [image_studio_select_object], Select all [image_studio_select_all], or another of its selection actions',
    ]);
    // An attached file reaches it as a layer: placed through the room's own file input, then referenced.
    expect(top.takesPicture).toBe(
      'any picture you can reach; assetId: A library picture, by id (browse-library).; a file the person attached to the conversation, through Place a picture as a layer [image_studio_place_image]',
    );
    // The character's own Remove takes an image off the character: found too, below the editor's.
    expect(data.results.map(r => r.tool)).toContain('characters_images_remove');
  });

  it('finds the editor’s Remove however the person names the picture', () => {
    for (const query of ['remove an object from a photo', 'remove an object from an image']) {
      const data = (at('/characters/c_alex').find({ query }) as { data: { results: Record<string, unknown>[] } }).data;
      expect(data.results[0]?.tool, query).toBe('image_studio_generative_remove');
    }
  });

  it('finds where a generated picture is added to a character', () => {
    const data = (at('/images').find({ query: 'add my generated portrait to Alex' }) as { data: { results: Record<string, unknown>[] } }).data;
    expect(data.results[0]).toMatchObject({ tool: 'characters_images_add', page: 'Character Detail', way: [
      'Go to Characters (/characters) with app_navigate.',
      'On Characters, open Character Detail with Open [characters_open] on the row you want (item).',
    ] });
    const device = (at('/characters/c_alex').find({ query: 'attach picture file from this device to the character' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(device).toMatchObject({ tool: 'characters_images_add_device', onThisPage: true });
    expect(device.takesPicture).toBe('any picture you can reach; a file the person attached to the conversation, by its id');
  });

  it('finds a room’s field and command, with what to pass the tool', () => {
    const field = (at('/image/i_1').find({ query: 'brush size' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(field).toMatchObject({ capability: 'Size', tool: 'image_studio_set_properties', call: 'image_studio_set_properties with values.brush-size', onThisPage: true });
    const command = (at('/image/i_1').find({ query: 'lasso freehand outline' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(command).toMatchObject({ capability: 'Lasso (L)', call: 'image_studio_run_command with command: tool.lasso' });
  });

  it('finds a member of a room’s action family by its own words, with its op to pass', () => {
    const member = (at('/image/i_1').find({ query: 'turn an adjustment off' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(member).toMatchObject({ capability: 'Switch an adjustment', tool: 'image_studio_adjustment', call: 'image_studio_adjustment with op: enable', onThisPage: true });
    const curves = (at('/image/i_1').find({ query: 'add a curves adjustment above the layer' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(curves).toMatchObject({ capability: 'Add an adjustment', call: 'image_studio_adjustment with op: add' });
    // The family is found as its members, never as one entry of its own.
    const all = (at('/image/i_1').find({ query: 'adjust a layer adjustments', limit: 10 }) as { data: { results: Record<string, unknown>[] } }).data.results;
    expect(all.filter(r => r.tool === 'image_studio_adjustment').every(r => typeof r.call === 'string')).toBe(true);
  });

  it('gives what the frame offers as on every page, with no way to go', () => {
    const top = (at('/images').find({ query: 'capture a website' }) as { data: { results: Record<string, unknown>[] } }).data.results[0];
    expect(top).toMatchObject({ tool: 'shell_capture_website', where: 'Every page (the app’s frame)' });
    expect(top).not.toHaveProperty('way');
  });

  it('is deterministic, honours limit, and says when nothing matches', () => {
    const lookup = at('/characters/c_alex');
    expect(lookup.find({ query: 'remove', limit: 2 })).toEqual(lookup.find({ query: 'remove', limit: 2 }));
    expect((lookup.find({ query: 'remove', limit: 2 }) as { data: { results: unknown[] } }).data.results).toHaveLength(2);
    expect(lookup.find({ query: 'xylophone quasar' })).toMatchObject({ success: true, data: { results: [], total: 0 } });
    expect((lookup.find({ query: 'xylophone quasar' }) as { data: { note: string } }).data.note).toContain('Nothing in the app matches');
  });

  it('refuses a query with no words, and a limit out of range', () => {
    const lookup = at('/characters/c_alex');
    expect(lookup.find({})).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
    expect(lookup.find({ query: 'the of and' })).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
    expect(lookup.find({ query: 'remove', limit: 11 })).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
    expect(lookup.find({ query: 'remove', limit: 0 })).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('reads another page’s knowledge by title, route or address, a part at a time', () => {
    const lookup = at('/characters/c_alex');
    const first = lookup.guide({ page: 'Image Editor' }) as { success: true; data: { page: string; text: string; total: number; next?: number; from: number } };
    expect(first.success).toBe(true);
    expect(first.data.page).toBe('Image Editor');
    expect(first.data.text.startsWith('Image Editor (/image/:imageId)\nOffers Remove')).toBe(true);
    expect(first.data.text.length).toBeLessThanOrEqual(12_000);
    expect(first.data.next).toBeGreaterThan(0);
    const second = lookup.guide({ page: '/image/:imageId', from: first.data.next }) as { data: { text: string; from: number; next?: number } };
    expect(second.data.from).toBe(first.data.next);
    // Read on until it ends: the last part holds the page's recipes by name.
    let part = second.data;
    const parts = [first.data.text, part.text];
    while (part.next !== undefined) {
      part = (lookup.guide({ page: '/image/:imageId', from: part.next }) as { data: typeof part }).data;
      parts.push(part.text);
    }
    expect(part.text).toContain('Recipes on this page');
    expect(parts.join('')).toHaveLength(first.data.total);
    expect((lookup.guide({ page: '/image/i_42' }) as { data: { page: string } }).data.page).toBe('Image Editor');
    expect((lookup.guide({ page: 'character detail' }) as { data: { page: string } }).data.page).toBe('Character Detail');
  });

  it('refuses a page it does not know, naming the pages', () => {
    const answer = at('/images').guide({ page: 'Nowhere' });
    expect(answer).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect((answer as { error: { message: string } }).error.message).toContain('"Image Editor"');
    expect(at('/images').guide({})).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
  });
});

describe('the start a surface’s whole catalog shares, declared by the bindings', () => {
  it('comes from the build’s whole surface, however few of its actions the page offers now', async () => {
    const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const registry = createBindingRegistry();
    const disconnect = connectBindings({ registry, runtime, manifest, navigation: { navigate: () => {}, location: () => '/image/i_1', subscribe: () => () => {} } });
    // The room offers two of its actions; the start is its whole catalog's.
    registry.registerRoom({
      catalog: {
        room: 'image-studio',
        title: 'Image Studio',
        description: 'Pictures',
        actions: ['generative-remove', 'run-command'].map(id => ({ kind: 'action' as const, id, title: id, description: id, control: 'c', input: { type: 'object' }, effect: 'edit' as const })),
        fields: [],
        commands: [],
        observations: [],
      },
      run: () => ({ ok: true as const }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const index = runtime.snapshot().index!;
    const room = index.find(s => s.id === 'room:image-studio')!;
    expect(room.index.map(e => e.id).sort()).toEqual(['image_studio_generative_remove', 'image_studio_run_command']);
    expect(room.idPrefix).toBe('image_studio_');
    expect(room.idPrefix).toBe(sharedIdPrefix(surfaces.find(s => s.id === 'room:image-studio')!.actions.map(a => a.name)));
    // The navigation's one action shares no start: declared as none.
    expect(index.find(s => s.id === 'app:navigation')!.idPrefix).toBe('');
    disconnect();
  });
});

describe('connectBindings with the build’s knowledge', () => {
  function router(start: string): AppNavigation {
    let path = start;
    return { navigate: vi.fn((to: string) => void (path = to)), location: () => path, subscribe: () => () => {} };
  }
  const request = (actionId: string, params: Record<string, unknown>): OUIActionRequest => ({
    requestId: `r-${Math.random()}`,
    surfaceId: 'oui',
    actionId,
    params,
    timestamp: Date.now(),
  });

  it('answers oui.find and oui.guide in the tab, from the page the person is on, until it disconnects', async () => {
    const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 200 } });
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation: router('/characters/c_alex'), knowledge });
    expect(runtime.snapshot().lookup).toEqual(['find', 'guide']);

    const found = await runtime.execute(request('find', { query: 'remove an object from a picture', limit: 3 }));
    expect(found.success).toBe(true);
    const data = found.data as { from: unknown; results: Array<{ tool: string }> };
    expect(data.from).toEqual({ page: 'Character Detail', route: '/characters/:id' });
    expect(data.results[0].tool).toBe('image_studio_generative_remove');

    const guide = await runtime.execute(request('guide', { page: 'Image Studio' }));
    expect(guide).toMatchObject({ success: true, data: { page: 'Image Studio' } });

    disconnect();
    expect(runtime.snapshot()).not.toHaveProperty('lookup');
    expect((await runtime.execute(request('find', { query: 'remove' }))).error?.code).toBe('ACTION_NOT_FOUND');
  });

  it('installs no lookup without the knowledge', () => {
    const runtime = createSurfaceRuntime({ form: 'index', announce: false });
    const disconnect = connectBindings({ registry: createBindingRegistry(), runtime, manifest, navigation: router('/images') });
    expect(runtime.snapshot()).not.toHaveProperty('lookup');
    disconnect();
  });
});
