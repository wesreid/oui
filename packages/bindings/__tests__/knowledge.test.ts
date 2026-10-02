import { describe, expect, it } from 'vitest';

import { pageForPath, resolveKnowledge, routeMatcher, type GeneratedKnowledge } from '../src/index.js';

const knowledge: GeneratedKnowledge = {
  version: 1,
  buildId: 'b1',
  overview: { title: 'Pages', content: '…' },
  pages: [
    {
      surface: 'page:VoicesPage',
      routes: ['/voices'],
      summary: { title: 'Voices', content: 'Voice library' },
      detail: { title: 'Voices (/voices)', content: 'All of it' },
      relationships: null,
      recipes: [{ name: 'Open a voice', trigger: 'open', steps: ['a'] }],
      adjacent: ['page:VoiceCreatePage'],
    },
    {
      surface: 'page:VoiceCreatePage',
      routes: ['/voices/create'],
      summary: { title: 'Create Voice', content: 'Clone one' },
      detail: { title: 'Create Voice (/voices/create)', content: '…' },
      relationships: null,
      recipes: [],
      adjacent: [],
    },
    {
      surface: 'page:VoiceDetail',
      routes: ['/voices/:id'],
      summary: { title: 'Voice', content: 'One voice' },
      detail: { title: 'Voice (/voices/:id)', content: '…' },
      relationships: null,
      recipes: [],
      adjacent: [],
    },
  ],
};

describe('routeMatcher', () => {
  it('matches parameters and nothing more', () => {
    expect(routeMatcher('/voices/:id').test('/voices/abc')).toBe(true);
    expect(routeMatcher('/voices/:id').test('/voices/abc/edit')).toBe(false);
    expect(routeMatcher('/voices').test('/voices/')).toBe(true);
  });
});

describe('pageForPath', () => {
  it('prefers a static route over a parameter', () => {
    expect(pageForPath(knowledge, '/voices/create')?.surface).toBe('page:VoiceCreatePage');
    expect(pageForPath(knowledge, '/voices/v123')?.surface).toBe('page:VoiceDetail');
    expect(pageForPath(knowledge, '/voices?x=1')?.surface).toBe('page:VoicesPage');
  });
});

describe('resolveKnowledge', () => {
  it('gives the map, the page in full, its recipes and its neighbours’ summaries', () => {
    const resolved = resolveKnowledge(knowledge, '/voices');
    expect(resolved.entries.map(e => e.title)).toEqual(['Pages', 'Voices (/voices)', 'Create Voice']);
    expect(resolved.workflows.map(w => w.name)).toEqual(['Open a voice']);
  });

  it('gives only the map on a page the build does not know', () => {
    expect(resolveKnowledge(knowledge, '/nowhere').entries.map(e => e.title)).toEqual(['Pages']);
  });
});
