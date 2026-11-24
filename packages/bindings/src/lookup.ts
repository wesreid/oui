/**
 * The tab's lookup over what its build knows of itself: the
 * answers to `oui.find` (every action of the app, searched by words) and
 * `oui.guide` (any page's knowledge, read without going there).
 *
 * It reads the build's own generated manifest and knowledge, which the tab
 * already holds, so it answers for exactly the build the person has open. The
 * search is BM25 over each action's title, its own words, where a person finds
 * it and its page, deterministic: the same words on the same build always give
 * the same results, in the same order. Nothing here names a feature.
 */
import type { GeneratedKnowledge, ManifestAction, ManifestSurface, OuiManifest, PageKnowledge } from '@ouispec/contract';

import {
  actionNeeds,
  actionRank,
  describeStep,
  pageLinks,
  pictureSources,
  routeTakesId,
  takesAttachment,
  takesPicture,
  wayTo,
  wayWords,
  type AppPage,
  type PageLinks,
} from './app.js';
import type { JsonSchema } from './json-schema.js';
import { pageForPath } from './manifest.js';
import { ROOM_SET_PROPERTIES_ID } from './room.js';

/** What a lookup answers: data the assistant is given, or why it could not (oui-spec's `OUILookupAnswer`). */
export type KnowledgeLookupAnswer =
  | { success: true; data: unknown }
  | { success: false; error: { code: string; message: string } };

/** The lookup a runtime answers `oui.find` and `oui.guide` with (oui-spec's `OUILookup`). */
export interface KnowledgeLookup {
  find(params: Record<string, unknown>): KnowledgeLookupAnswer;
  guide(params: Record<string, unknown>): KnowledgeLookupAnswer;
}

export interface KnowledgeLookupOptions {
  /** This build's generated knowledge. */
  knowledge: GeneratedKnowledge;
  /** This build's generated manifest. */
  manifest: OuiManifest;
  /** The address of the page the person is on, read at each search: the way to each result starts there. */
  location?: () => string;
}

/** Results one search gives when it names no limit, and the most it gives. */
export const FIND_DEFAULT_RESULTS = 5;
export const FIND_MAX_RESULTS = 10;
/** The most characters of a page's knowledge one `oui.guide` answer gives. */
export const GUIDE_PAGE_CHARS = 12_000;

// ─── Words ───────────────────────────────────────────────────────────────────

/** Words that say nothing about what an action does. */
const STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from has have how i in into is it its it’s me my of on or our so that the their them then there these this those to up us was we what when where which who will with you your'.split(' '),
);

/** A word reduced to the part its forms share: "layers", "layer" → "layer"; "removed", "removing", "remove" → "remov". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * Stems that name the same thing, as one: a person says "photo" where an app's controls say "image" or "picture".
 * Only words that mean the same in every app's controls; a word a product uses in a sense of its own stays itself.
 */
const SAME_THING: ReadonlyMap<string, string> = new Map([
  ['photo', 'imag'],
  ['photograph', 'imag'],
  ['pictur', 'imag'],
  ['pic', 'imag'],
]);

/**
 * Text as the search's words: lower case, split on anything that is not a letter or digit, stop words out, stemmed,
 * and stems that name the same thing made one (`SAME_THING`).
 */
export function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && !STOP_WORDS.has(w))
    .map(stem)
    .map(word => SAME_THING.get(word) ?? word);
}

// ─── What is searched ────────────────────────────────────────────────────────

/** One thing the search can find: an action, a field a room sets, or a command a room runs. */
interface Entry {
  title: string;
  /** The tool that does it. */
  tool: string;
  /** For a room's field or command: what to pass the tool. */
  call?: string;
  /** Its own words. */
  what: string;
  /** Where a person finds it on its page, in words. */
  where: string;
  action: ManifestAction;
  surface: ManifestSurface;
  /** The pages it is on; empty when it is on every page (the app's frame). */
  pages: AppPage[];
  rank: number;
  terms: Map<string, number>;
  length: number;
}

/** Fields of an entry and how much a word in each counts. */
const WEIGHTS = { title: 3, where: 1.5, what: 1, page: 1, needs: 0.5 } as const;

/** An action's own words: its description without the tool's lead-in and the sentences that say where it is. */
function ownWords(action: ManifestAction): string {
  let text = action.description;
  const lead = text.indexOf('": ');
  if (action.source === 'control' && lead !== -1 && lead < 120) text = text.slice(lead + 3);
  else if (text.startsWith(`${action.title}: `)) text = text.slice(action.title.length + 2);
  return text
    .split(/ It is (?:in|on|one per row)| It goes to | It saves through | It starts a job/)[0]
    .replace(/\s*\([^()]*›[^()]*\)\s*$/, '')
    .trim();
}

/** The fields a room's set-properties action takes: each field's id, title, section and words. */
function roomFields(action: ManifestAction): { id: string; title: string; where: string; what: string }[] {
  const values = action.input.properties?.values?.properties ?? {};
  return Object.entries(values).map(([id, schema]: [string, JsonSchema]) => {
    const text = schema.description ?? '';
    const colon = text.indexOf(': ');
    const head = colon === -1 ? text : text.slice(0, colon);
    const where = head.includes('›') ? head : '';
    const title = (where ? head.split('›').pop()! : id).trim();
    return { id, title, where, what: colon === -1 ? '' : text.slice(colon + 2) };
  });
}

/**
 * The choices a room action names by one of its properties, each an entry of its own: the commands its
 * run-command takes, or the members of an action family (`roomActionFamily`, its `op`). Such a property
 * is a string enum whose description is a line per value, "id = Title (keys): words", every line of it;
 * each is called as `<property>: <id>`. Empty for an action with none.
 */
export function roomChoices(action: ManifestAction): { property: string; id: string; title: string; what: string }[] {
  for (const [property, schema] of Object.entries(action.input.properties ?? {}) as [string, JsonSchema][]) {
    if (!Array.isArray(schema.enum) || typeof schema.description !== 'string') continue;
    const lines = schema.description.split('\n').map(line => line.trim()).filter(Boolean);
    const parsed = lines.map(line => /^([\w.:-]+) = ([^:]+?)(?::\s*(.*))?$/.exec(line));
    if (parsed.length === 0 || parsed.some(m => !m)) continue;
    const values = new Set(schema.enum.map(String));
    const choices = (parsed as RegExpExecArray[])
      .filter(m => values.has(m[1]))
      .map(m => ({ property, id: m[1], title: m[2].trim(), what: (m[3] ?? '').trim() }));
    if (choices.length > 0) return choices;
  }
  return [];
}

function countTerms(parts: [string, number][]): { terms: Map<string, number>; length: number } {
  const terms = new Map<string, number>();
  let length = 0;
  for (const [text, weight] of parts) {
    for (const word of searchWords(text)) {
      terms.set(word, (terms.get(word) ?? 0) + weight);
      length += weight;
    }
  }
  return { terms, length };
}

/** The pages a surface is on: its own page, or every page whose routes it shares; none for a surface on every page. */
function pagesOfSurface(surface: ManifestSurface, pages: readonly AppPage[]): AppPage[] {
  if (surface.kind === 'page') return pages.filter(p => p.surface === surface.id);
  if (surface.routes.includes('*')) return [];
  return pages.filter(p => p.routes.some(r => surface.routes.includes(r)));
}

function entriesOf(manifest: OuiManifest, pages: readonly AppPage[]): Entry[] {
  const out: Entry[] = [];
  for (const surface of manifest.surfaces) {
    if (surface.kind === 'navigation') continue;
    const on = pagesOfSurface(surface, pages);
    const pageWords = on.map(p => p.title).join(' ');
    for (const action of surface.actions) {
      const where = action.reach
        .filter(s => s.kind !== 'route')
        .map(describeStep)
        .join(', ');
      const needs = actionNeeds(action, on[0] ?? null, surface.kind === 'room' ? surface : undefined).join(' ');
      const add = (title: string, what: string, at: string, call?: string) => {
        const { terms, length } = countTerms([
          [title, WEIGHTS.title],
          [at, WEIGHTS.where],
          [what, WEIGHTS.what],
          [pageWords || surface.title, WEIGHTS.page],
          [needs, WEIGHTS.needs],
        ]);
        out.push({
          title,
          tool: action.name,
          ...(call ? { call } : {}),
          what,
          where: at,
          action,
          surface,
          pages: on,
          rank: actionRank(action),
          terms,
          length,
        });
      };
      if (action.source === 'room-action' && action.id.endsWith(`/action/${ROOM_SET_PROPERTIES_ID}`)) {
        for (const f of roomFields(action)) add(f.title, f.what, f.where || where, `values.${f.id}`);
        continue;
      }
      // Its commands (run-command) or its family's members, each found by its own words.
      const choices = action.source === 'room-action' ? roomChoices(action) : [];
      if (choices.length > 0) {
        for (const c of choices) add(c.title, c.what, where, `${c.property}: ${c.id}`);
        continue;
      }
      add(action.title, ownWords(action), where);
    }
  }
  return out;
}

// ─── BM25 ────────────────────────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;

interface Index {
  entries: Entry[];
  /** How many entries hold each word. */
  holding: Map<string, number>;
  averageLength: number;
}

function buildIndex(entries: Entry[]): Index {
  const holding = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    total += e.length;
    for (const word of e.terms.keys()) holding.set(word, (holding.get(word) ?? 0) + 1);
  }
  return { entries, holding, averageLength: entries.length ? total / entries.length : 0 };
}

function score(index: Index, entry: Entry, words: readonly string[]): number {
  const n = index.entries.length;
  let sum = 0;
  for (const word of new Set(words)) {
    const tf = entry.terms.get(word);
    if (!tf) continue;
    const df = index.holding.get(word) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    sum += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * entry.length) / (index.averageLength || 1)));
  }
  return sum;
}

// ─── The lookup ──────────────────────────────────────────────────────────────

/** A page's knowledge as `oui.guide` gives it: its detail, how its parts relate, and its recipes by name. */
function guideText(page: PageKnowledge): string {
  return [
    `${page.detail.title}\n${page.detail.content}`,
    page.relationships ? `${page.relationships.title}\n${page.relationships.content}` : '',
    page.recipes.length
      ? `Recipes on this page (each is in its knowledge once you are there):\n${page.recipes.map(r => `- ${r.name}: ${r.trigger}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** `text` cut at a line end at most `max` characters in, never mid-line when a line end is near. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.lastIndexOf('\n', max);
  return text.slice(0, end > max / 2 ? end : max);
}

/** The page a name means: a route, an address on one, a title (whatever its case), or the one title it starts. */
function namedPage(pages: readonly PageKnowledge[], knowledge: GeneratedKnowledge, name: string): PageKnowledge | null {
  const clean = name.trim();
  if (!clean) return null;
  const byRoute = pages.find(p => p.routes.includes(clean));
  if (byRoute) return byRoute;
  if (clean.startsWith('/')) return pageForPath(knowledge, clean);
  const lower = clean.toLowerCase();
  const titled = pages.filter(p => p.summary.title.toLowerCase() === lower);
  if (titled.length === 1) return titled[0];
  const starting = pages.filter(p => p.summary.title.toLowerCase().startsWith(lower));
  return starting.length === 1 ? starting[0] : null;
}

/**
 * The lookup over a build: `find` searches every action of the app and gives
 * each match with the way to it from the page the person is on and what it
 * needs first; `guide` gives one page's knowledge. Built once, the first time
 * either is asked.
 */
export function createKnowledgeLookup({ knowledge, manifest, location }: KnowledgeLookupOptions): KnowledgeLookup {
  let built: { index: Index; pages: AppPage[]; links: PageLinks } | null = null;
  const ready = () => {
    if (!built) {
      const pages: AppPage[] = knowledge.pages.map(p => ({ surface: p.surface, routes: p.routes, title: p.summary.title }));
      built = { index: buildIndex(entriesOf(manifest, pages)), pages, links: pageLinks(pages, manifest.surfaces) };
    }
    return built;
  };
  const refuse = (message: string): KnowledgeLookupAnswer => ({ success: false, error: { code: 'INVALID_PARAMS', message } });

  return {
    find(params) {
      const query = typeof params.query === 'string' ? params.query.trim() : '';
      if (!query) return refuse('find takes query: what to find, in words ("remove an object from a picture").');
      const limit = params.limit === undefined ? FIND_DEFAULT_RESULTS : params.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FIND_MAX_RESULTS) {
        return refuse(`find takes limit: a whole number from 1 to ${FIND_MAX_RESULTS}.`);
      }
      const words = searchWords(query);
      if (!words.length) return refuse(`"${query}" has no word to search for: say what the capability does.`);
      const { index, pages, links } = ready();
      const path = location?.() ?? '';
      const onPage = path ? pageForPath(knowledge, path) : null;
      const current = onPage ? (pages.find(p => p.surface === onPage.surface) ?? null) : null;

      const scored = index.entries
        .map(entry => ({ entry, score: score(index, entry, words) }))
        .filter(s => s.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.entry.rank - b.entry.rank ||
            a.entry.tool.localeCompare(b.entry.tool) ||
            (a.entry.call ?? '').localeCompare(b.entry.call ?? ''),
        );
      // One result per thing found: a shared action is on many pages, and the nearest one is given.
      const seen = new Set<string>();
      const results: Record<string, unknown>[] = [];
      for (const { entry } of scored) {
        const key = `${entry.tool}\u0000${entry.call ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (results.length < limit) results.push(resultOf(entry, current, pages, links));
      }
      return {
        success: true,
        data: {
          query,
          ...(current ? { from: { page: current.title, route: current.routes[0] } } : {}),
          results,
          total: seen.size,
          ...(results.length
            ? {}
            : { note: 'Nothing in the app matches these words. Try the words a person would see on the control, or fewer words.' }),
        },
      };
    },

    guide(params) {
      const name = typeof params.page === 'string' ? params.page : '';
      if (!name.trim()) return refuse('guide takes page: a route ("/image/:imageId"), an address on one, or a page’s title.');
      const page = namedPage(knowledge.pages, knowledge, name);
      if (!page) {
        const titles = knowledge.pages.map(p => p.summary.title).slice(0, 40);
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `No page is named "${name}". Pages: ${titles.map(t => `"${t}"`).join(', ')}${knowledge.pages.length > 40 ? ', …' : ''}.` },
        };
      }
      const text = guideText(page);
      const from = typeof params.from === 'number' && params.from > 0 ? Math.min(Math.floor(params.from), text.length) : 0;
      const shown = cutAt(text.slice(from), GUIDE_PAGE_CHARS);
      const next = from + shown.length;
      return {
        success: true,
        data: {
          page: page.summary.title,
          routes: page.routes,
          from,
          total: text.length,
          text: shown,
          ...(next < text.length ? { next } : {}),
        },
      };
    },
  };
}

/** The control beside an action, in the same dialog or on the same page, that takes a file the person attached. */
function fileSlotBeside(action: ManifestAction, surface: ManifestSurface): ManifestAction | null {
  const dialog = action.reach.find(s => s.kind === 'dialog');
  const sameDialog = (other: ManifestAction) => {
    const d = other.reach.find(s => s.kind === 'dialog');
    return dialog ? !!d && d.title === dialog.title : !d;
  };
  return surface.actions.find(other => other !== action && sameDialog(other) && takesAttachment(other.input)) ?? null;
}

/** One result as the assistant reads it: what it is, where, the way there, and what it needs first. */
function resultOf(entry: Entry, current: AppPage | null, pages: readonly AppPage[], links: PageLinks): Record<string, unknown> {
  const { action, surface } = entry;
  // The page it is on nearest the person: the page they are on, then the shortest way.
  const candidates = entry.pages.map(page => ({ page, way: wayTo(current, page, pages, links) }));
  candidates.sort(
    (a, b) =>
      (a.way === null ? 1 : 0) - (b.way === null ? 1 : 0) ||
      (a.way?.length ?? 0) - (b.way?.length ?? 0) ||
      a.page.title.localeCompare(b.page.title),
  );
  const chosen = candidates[0];
  const everywhere = entry.pages.length === 0;
  const page = chosen?.page ?? null;
  const where = [
    everywhere ? 'Every page (the app’s frame)' : page ? `${page.title} (${page.routes[0]})` : surface.title,
    surface.kind === 'room' ? surface.title : '',
    entry.where,
  ]
    .filter(Boolean)
    .join(' › ');
  const way = everywhere
    ? []
    : chosen?.way
      ? wayWords(chosen.way)
      : page
        ? [`Nothing in the app leads to ${page.title}: it opens by its address (${page.routes[0]}) with an id.`]
        : [];
  const needs = actionNeeds(action, page, surface.kind === 'room' ? surface : undefined).filter(
    // An open item the way already opens is not something more to do.
    n => !(chosen?.way?.length && n.startsWith('an open item')),
  );
  // A file the person attached reaches a picture input through the file slot beside it, when it does not take one itself.
  const slot = takesPicture(action) && !takesAttachment(action.input) ? fileSlotBeside(action, surface) : null;
  return {
    capability: entry.title,
    tool: entry.tool,
    ...(entry.call ? { call: `${entry.tool} with ${entry.call}` } : {}),
    what: entry.what.length > 240 ? `${entry.what.slice(0, 239).trimEnd()}…` : entry.what,
    where,
    ...(page ? { page: page.title, route: page.routes[0], ...(page.routes.some(routeTakesId) ? { opensAnItem: true } : {}) } : {}),
    ...(current && page && current.surface === page.surface ? { onThisPage: true } : {}),
    ...(way.length ? { way } : {}),
    ...(needs.length ? { needs } : {}),
    ...(takesPicture(action)
      ? {
          takesPicture: [
            'any picture you can reach',
            ...pictureSources(action),
            ...(takesAttachment(action.input) ? ['a file the person attached to the conversation, by its id'] : []),
            ...(slot ? [`a file the person attached to the conversation, through ${slot.title} [${slot.name}]`] : []),
          ].join('; '),
        }
      : {}),
  };
}
