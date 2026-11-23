/**
 * An eval's page answers the app-wide search and page guide as the product's
 * tab does: from the product's manifest and knowledge, the way to
 * each result starting at the page the eval is on.
 */
import { describe, expect, it } from 'vitest';
import type { GeneratedKnowledge, OuiManifest } from '@ouispec/contract';
import { CLIENT_KNOWLEDGE_KEY, CLIENT_SNAPSHOT_KEY } from '@ouispec/agent-worker';
import { createFixturePage } from '../page.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'eval-lookup',
  surfaces: [
    {
      id: 'page:CharacterPage',
      kind: 'page',
      title: 'Character',
      description: 'A character.',
      routes: ['/characters/:id'],
      observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
      actions: [
        { name: 'character_rename', id: 'character.rename', source: 'control', control: 'button', title: 'Rename', description: 'Press "Rename": Rename the character.', input: { type: 'object', properties: {} }, reach: [{ kind: 'route', path: '/characters/:id', title: 'Character' }] },
      ],
    },
    {
      id: 'page:StudioHome',
      kind: 'page',
      title: 'Picture Studio',
      description: 'Pictures in layers.',
      routes: ['/studio'],
      observations: [],
      actions: [
        { name: 'studio_new', id: 'studio.new', source: 'control', control: 'button', title: 'New picture', description: 'Press "New picture": Start one.', input: { type: 'object', properties: {} }, effect: { kind: 'navigate', to: '/studio/:pictureId' }, reach: [{ kind: 'route', path: '/studio', title: 'Picture Studio' }] },
      ],
    },
    {
      id: 'room:editor',
      kind: 'room',
      title: 'Picture Editor',
      description: 'Edits a picture.',
      routes: ['/studio/:pictureId'],
      observations: [],
      actions: [
        { name: 'editor_remove', id: 'editor/action/remove', source: 'room-action', title: 'Remove', description: 'Remove: Removes what is selected and fills the area. (Edit › Remove)', input: { type: 'object', properties: {} }, effect: { kind: 'job' }, reach: [{ kind: 'room', room: 'editor', where: 'Edit › Remove' }] },
      ],
    },
    { id: 'page:EditorPage', kind: 'page', title: 'Picture Editor', description: 'Offers Remove.', routes: ['/studio/:pictureId'], observations: [], actions: [] },
  ],
};

const entry = (surface: string, title: string, route: string) => ({
  surface,
  routes: [route],
  summary: { title, content: title },
  detail: { title, content: `${title} in full.` },
  relationships: null,
  recipes: [],
  adjacent: [],
});

const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'eval-lookup',
  overview: { title: 'The app’s pages', content: '- Picture Studio /studio: New picture\n  - Picture Editor /studio/:pictureId (from New picture): Edit: Remove' },
  pages: [entry('page:CharacterPage', 'Character', '/characters/:id'), entry('page:StudioHome', 'Picture Studio', '/studio'), entry('page:EditorPage', 'Picture Editor', '/studio/:pictureId')],
};

describe('an eval page with the product’s knowledge', () => {
  it('names the lookup in its snapshot, sends the map, and answers a search from the page it is on', async () => {
    const page = createFixturePage({ at: '/characters/c-1', controls: { 'character.rename': {} } }, { manifest, knowledge });
    try {
      const context = await page.context();
      expect((context[CLIENT_SNAPSHOT_KEY] as { lookup?: string[] }).lookup).toEqual(['find', 'guide']);
      expect((context[CLIENT_KNOWLEDGE_KEY] as { map?: { content: string } }).map?.content).toContain('Picture Editor /studio/:pictureId');

      await page.channel.dispatch('turn', { requestId: 'f1', surfaceId: 'oui', actionId: 'find', params: { query: 'remove an object' }, timestamp: 0 });
      const found = await page.channel.awaitResult('f1', { userId: 'u-1', timeoutMs: 2_000 });
      expect(found?.success).toBe(true);
      expect(found?.data).toMatchObject({
        from: { page: 'Character', route: '/characters/:id' },
        results: [
          {
            tool: 'editor_remove',
            page: 'Picture Editor',
            way: ['Go to Picture Studio (/studio) with app_navigate.', 'On Picture Studio, open Picture Editor with New picture [studio_new].'],
          },
        ],
      });
      // A search changes nothing in the page: nothing ran.
      expect(page.ran).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('searches the whole build over `search` when the manifest is kept to the suite’s pages', async () => {
    const kept: OuiManifest = { ...manifest, surfaces: manifest.surfaces.filter((s) => s.id === 'page:CharacterPage') };
    const page = createFixturePage({ at: '/characters/c-1', controls: { 'character.rename': {} } }, { manifest: kept, knowledge, search: manifest });
    try {
      await page.channel.dispatch('turn', { requestId: 'f2', surfaceId: 'oui', actionId: 'find', params: { query: 'remove an object' }, timestamp: 0 });
      const found = await page.channel.awaitResult('f2', { userId: 'u-1', timeoutMs: 2_000 });
      expect((found?.data as { results: Array<{ tool: string }> }).results[0].tool).toBe('editor_remove');
    } finally {
      page.close();
    }
    // Without it, the search reads only what the kept manifest holds.
    const narrow = createFixturePage({ at: '/characters/c-1', controls: { 'character.rename': {} } }, { manifest: kept, knowledge });
    try {
      await narrow.channel.dispatch('turn', { requestId: 'f3', surfaceId: 'oui', actionId: 'find', params: { query: 'remove an object' }, timestamp: 0 });
      const found = await narrow.channel.awaitResult('f3', { userId: 'u-1', timeoutMs: 2_000 });
      expect((found?.data as { results: unknown[] }).results).toEqual([]);
    } finally {
      narrow.close();
    }
  });
});
