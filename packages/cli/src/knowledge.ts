/**
 * The knowledge generated from the same declarations as the surfaces
 *: what each page offers, how to reach it, its parameters,
 * the relationships its types imply, and the task recipes the UI implies.
 *
 * The recipe templates below are the only prose written here. They are
 * generic — none names a feature — and each is instantiated only from what
 * the declarations say. A task only a room knows is a recipe the room
 * declares; none is inferred from what its entries are called.
 */

import {
  actionsOfPage,
  capabilitiesOf,
  isKeyframeable,
  NAVIGATE_ACTION_ID,
  pageForRoute,
  pageLinks,
  pictureSources,
  takesAttachment,
  takesPicture,
  type AppPage,
  type Capability,
  type PageLink,
  pageQuerySchema,
  PROBLEMS_OBSERVATION_ID,
  ROOM_RUN_COMMAND_ID,
  ROOM_SET_PROPERTIES_ID,
  toolName,
  type JsonSchema,
  type KnowledgeEntry,
  type KnowledgeRecipe,
  type ManifestAction,
  type ManifestSurface,
  type PageKnowledge,
  type ReachStep,
  type RoomCatalogData,
  appMapContent,
  type AppMapLine,
} from '@ouispec/bindings';

import { describeStep, type PageMeta } from './assemble.js';
import { DEFAULT_MAP_CHARS } from './config.js';
import type { ApiOperation, NavEntry } from './inputs.js';
import type { OutsidePage } from './outside.js';
import { resolveRecipe, roomToolName } from './recipes.js';

const CREATE_VERB = /^(add|create|draw|new|place|insert|make)\b/i;

export function generateKnowledge(
  surfaces: readonly ManifestSurface[],
  pages: readonly PageMeta[],
  frames: readonly PageMeta[],
  catalogs: readonly RoomCatalogData[],
  nav: readonly NavEntry[],
  api: ReadonlyMap<string, ApiOperation>,
  /** Pages the assistant is never on: the overview says so. */
  outside: readonly OutsidePage[] = [],
  /** The most characters the app's map takes (`mapChars`). */
  mapChars = DEFAULT_MAP_CHARS,
): { overview: KnowledgeEntry; map?: AppMapLine[]; pages: PageKnowledge[]; frames?: PageKnowledge[] } {
  const byId = new Map(surfaces.map(s => [s.id, s]));
  const byRoom = new Map(catalogs.map(c => [`room:${c.room}`, c]));

  // Which pages lead to which, from navigate effects: one reading, the app-wide readers' (`pageLinks`).
  const links = pageLinks(pages, surfaces);
  const leadsTo = new Map([...links].map(([from, to]) => [from, new Set(to.keys())]));

  const roomsOf = (ids: readonly string[]) =>
    ids.map(id => ({ surface: byId.get(id)!, catalog: byRoom.get(id)! })).filter(r => r.surface && r.catalog);
  // A room the frame registers is open on every page the frame is on: the frame describes it, once.
  const framedRooms = (page: PageMeta) =>
    new Set(
      frames
        .filter(f => f.routes.includes('*') || f.routes.some(r => page.routes.includes(r)))
        .flatMap(f => f.rooms),
    );

  const mapLines = appMapLines(pages, frames, surfaces, links, nav, outside, mapChars);
  const overview: KnowledgeEntry = { title: APP_MAP_TITLE, content: appMapContent(mapLines) };
  // Line by line too when a route is gated, so a tab leaves out the pages a session may not see (`allows`).
  const gated = pages.some(p => p.gates);
  const out: PageKnowledge[] = pages.map(page => {
    const own = byId.get(page.surface)!;
    const shared = page.shared.map(id => byId.get(id)!).filter(Boolean);
    const framed = framedRooms(page);
    const rooms = roomsOf(page.rooms.filter(id => !framed.has(id)));
    // A shared control is where this page puts it: its tab and opener here.
    const controls = [own, ...shared].flatMap(s =>
      s.actions.map(a => (page.sharedReach[a.name] ? { ...a, reach: page.sharedReach[a.name] } : a)),
    );
    const adjacent = new Set(leadsTo.get(page.surface) ?? []);
    for (const [from, to] of leadsTo) if (to.has(page.surface)) adjacent.add(from);

    return {
      surface: page.surface,
      routes: page.routes,
      summary: {
        title: page.title,
        content: `${page.title} (${page.routes.join(', ')})${page.nav ? `, in the sidebar under ${page.nav}` : ''}: ${firstSentence(page.description)}${
          page.query ? ` Its address takes ${Object.keys(page.query).map(n => `?${n}`).join(', ')}.` : ''
        }`,
      },
      detail: {
        title: `${page.title} (${page.routes.join(', ')})`,
        content: detail(page, controls, rooms, api),
      },
      relationships: relationships(page, controls, rooms, pages, api),
      recipes: recipes(page, controls, rooms),
      adjacent: [...adjacent].sort(),
      ...(page.gates ? { gates: page.gates } : {}),
    };
  });
  // The frame: what it offers and where, on every page it frames. Its controls
  // take part in the pages' tasks, so they make no recipes of their own; a room
  // it registers is open on all of those pages, so its knowledge and recipes
  // are the frame's.
  const frameKnowledge: PageKnowledge[] = frames.map(frame => {
    const own = byId.get(frame.surface);
    const controls = own ? [...own.actions] : [];
    const rooms = roomsOf(frame.rooms);
    return {
      surface: frame.surface,
      routes: frame.routes,
      summary: { title: frame.title, content: `${frame.title}: ${firstSentence(frame.description)}` },
      detail: { title: frame.title, content: detail(frame, controls, rooms, api) },
      relationships: null,
      recipes: recipes(frame, [], rooms),
      adjacent: [],
    };
  });
  return {
    overview,
    ...(gated ? { map: mapLines } : {}),
    pages: out,
    ...(frameKnowledge.length ? { frames: frameKnowledge } : {}),
  };
}

function detail(
  page: PageMeta,
  controls: readonly ManifestAction[],
  rooms: readonly { surface: ManifestSurface; catalog: RoomCatalogData }[],
  api: ReadonlyMap<string, ApiOperation>,
): string {
  const lines: string[] = [page.description];
  lines.push(
    page.surface.startsWith('shell:')
      ? 'Where: the app’s frame, whatever page is open.'
      : page.nav
        ? `Where: the sidebar, ${page.nav}.`
        : `Where: reached by address (${page.routes.join(', ')}) or from another page.`,
  );
  if (page.query) {
    lines.push(`Its address takes (open it filtered with [${toolName(NAVIGATE_ACTION_ID)}], query):`);
    for (const [name, schema] of Object.entries(pageQuerySchema(page.query).properties ?? {})) {
      lines.push(`- ${name}: ${queryValueSummary(schema)} — ${schema.description ?? ''}`.trimEnd());
    }
  }

  if (controls.length) {
    lines.push('', 'What you can do here (tool in brackets):');
    const groups = new Map<string, ManifestAction[]>();
    for (const a of controls) {
      const where = a.reach.slice(1).map(describeStep).join(', ') || 'on the page';
      groups.set(where, [...(groups.get(where) ?? []), a]);
    }
    for (const [where, actions] of [...groups.entries()].sort(([a], [b]) =>
      a === 'on the page' ? -1 : b === 'on the page' ? 1 : a.localeCompare(b),
    )) {
      lines.push(`${where[0].toUpperCase()}${where.slice(1)}:`);
      // A control on the page itself is a tool the PA holds, with its description
      // and schema; one behind a tab, dialog or panel is not a tool until it is
      // opened, so the knowledge is where the PA learns what it does.
      for (const a of actions) {
        const hidden = a.reach.some(step => step.kind !== 'route');
        lines.push(
          (hidden
            ? `- ${a.title} [${a.name}]: ${bindingDescription(a)}${params(a.input)}${effectNote(a, api)}`
            : `- ${a.title} [${a.name}]${effectNote(a, api)}`) + pictureNote(a, controls),
        );
      }
    }
  }

  if (page.shown.length) {
    lines.push('', 'What it shows (read it in its state, under shown, by id):');
    for (const d of page.shown) {
      const where = d.reach.slice(1).map(describeStep).join(', ');
      const labels = d.labels.length ? ` (${d.labels.join(', ')})` : '';
      lines.push(`- ${d.title}${labels} [${d.id}]: ${d.description}${where ? `; ${where}` : ''}`);
    }
  }

  for (const { surface, catalog } of rooms) {
    const where = page.surface.startsWith('shell:') ? 'in the app’s frame, whatever page is open' : 'on this page';
    lines.push('', `${catalog.title} (${where}): ${catalog.description}`);
    const actions = catalog.actions.filter(
      a => a.id !== ROOM_SET_PROPERTIES_ID && a.id !== ROOM_RUN_COMMAND_ID,
    );
    if (actions.length) {
      lines.push('Actions:');
      for (const a of actions) {
        // The room's actions are tools whenever the room is open; their meaning
        // and input are in the tool. Knowledge says where a person does each.
        lines.push(
          `- ${a.title} [${roomToolName(catalog.room, a.id)}]: ${a.control}${a.destructive ? ' (confirm first)' : ''}`,
        );
      }
    }
    if (catalog.fields.length) {
      lines.push(
        `Fields, set with [${roomToolName(catalog.room, ROOM_SET_PROPERTIES_ID)}] under values, by id (each one's meaning, range and unit are in that tool's input):`,
      );
      // Where each field is, grouped by the section a person finds it in. What
      // a field means and takes is in the tool's schema; repeating it here
      // would spend the context budget twice.
      const sections = [...new Set(catalog.fields.map(f => f.section.title))];
      for (const section of sections) {
        const fields = catalog.fields.filter(x => x.section.title === section);
        lines.push(`- ${section}: ${fields.map(f => `${f.title} (${f.id})`).join(', ')}`);
      }
    }
    const available = catalog.commands.filter(c => c.status === 'available');
    if (available.length) {
      lines.push(
        `Commands, run with [${roomToolName(catalog.room, ROOM_RUN_COMMAND_ID)}] (what each does is in that tool's input):`,
      );
      const groups = [...new Set(available.map(c => c.group))];
      for (const group of groups) {
        const commands = available.filter(c => c.group === group);
        lines.push(
          `- ${group}: ${commands.map(c => `${c.title} (${c.id}${c.keys.length ? `, ${c.keys.join(' / ')}` : ''})`).join('; ')}`,
        );
      }
    }
    const reserved = catalog.commands.filter(c => c.status === 'reserved');
    if (reserved.length)
      lines.push(`Not built yet (their keys do nothing): ${reserved.map(c => c.title).join(', ')}.`);
    lines.push(`What it reports: ${surface.observations.map(o => `${o.id} — ${o.description}`).join(' ')}`);
  }
  lines.push(
    '',
    `What the page reports: state (its fields, lists and unavailable controls) and ${PROBLEMS_OBSERVATION_ID}.`,
  );
  return lines.join('\n');
}

/**
 * What a control that takes a picture takes, said where it is listed: any
 * picture the assistant can reach, the sources its own input declares, and
 * the file slot beside it through which a file the person attached arrives.
 */
function pictureNote(a: ManifestAction, controls: readonly ManifestAction[]): string {
  if (!takesPicture(a)) return '';
  const dialog = a.reach.find(step => step.kind === 'dialog');
  const slot = takesAttachment(a.input)
    ? null
    : controls.find(
        o =>
          o !== a &&
          takesAttachment(o.input) &&
          (dialog ? o.reach.some(step => step.kind === 'dialog' && step.title === dialog.title) : !o.reach.some(step => step.kind === 'dialog')),
      );
  const sources = [
    ...pictureSources(a).map(s => s.split(':')[0]),
    takesAttachment(a.input) ? 'a file the person attached to the conversation, by its id' : '',
    slot ? `a file the person attached, through ${slot.title} [${slot.name}]` : '',
  ].filter(Boolean);
  return ` Takes any picture you can reach${sources.length ? `: ${sources.join('; ')}` : ''}.`;
}

function bindingDescription(a: ManifestAction): string {
  // The tool description starts with the verb and title; knowledge lists the title already.
  const i = a.description.indexOf('": ');
  const text = i === -1 ? a.description : a.description.slice(i + 3);
  return text.split(' It is ')[0].split(' It goes to ')[0].split(' It saves through ')[0];
}

function effectNote(a: ManifestAction, api: ReadonlyMap<string, ApiOperation>): string {
  const e = a.effect;
  const notes: string[] = [];
  if (a.itemized) notes.push('one per row');
  if (a.destructive || a.confirm) notes.push('confirm first');
  if (e && typeof e === 'object') {
    if (e.kind === 'navigate') notes.push(`goes to ${e.to}`);
    if (e.kind === 'mutate')
      notes.push(
        `saves through ${e.operation}${api.get(e.operation) ? ` (${api.get(e.operation)!.method} ${api.get(e.operation)!.url})` : ''}`,
      );
    if (e.kind === 'open') notes.push(`opens ${e.container}`);
    if (e.kind === 'transaction') {
      const op = e.operation ? api.get(e.operation) : undefined;
      notes.push(
        `irreversible: needs the person’s approval${e.operation ? `; through ${e.operation}${op ? ` (${op.method} ${op.url})` : ''}` : ''}`,
      );
    }
  }
  return notes.length ? ` (${notes.join('; ')})` : '';
}

function params(input: JsonSchema): string {
  const props = Object.entries(input.properties ?? {});
  if (!props.length) return '';
  return ` Takes ${props.map(([k, v]) => `${k}: ${valueSummary(v)}`).join('; ')}.`;
}

/** A query parameter in a few words: `lane|declined, default lane`, `integer ≥1`, `list of no_show|unconfirmed`. */
function queryValueSummary(s: JsonSchema): string {
  const one = (x: JsonSchema): string =>
    x.enum
      ? x.enum.map(String).join('|')
      : x.format === 'date'
        ? 'date YYYY-MM-DD'
        : `${x.type ?? 'value'}${x.minimum !== undefined ? ` ≥${x.minimum}` : ''}${x.maximum !== undefined ? ` ≤${x.maximum}` : ''}${x['x-unit'] ? ` ${x['x-unit']}` : ''}`;
  const text = s.type === 'array' && s.items ? `list of ${one(s.items)}` : one(s);
  return s.default !== undefined ? `${text}, default ${String(s.default)}` : text;
}

function valueSummary(s: JsonSchema): string {
  if (s.anyOf) return s.anyOf.map(valueSummary).join(' or ');
  const type = Array.isArray(s.type) ? s.type.join(' or ') : (s.type ?? 'value');
  const parts = [type];
  if (s.minimum !== undefined || s.maximum !== undefined)
    parts.push(`${s.minimum ?? '…'} to ${s.maximum ?? '…'}`);
  if (s['x-unit']) parts.push(s['x-unit']);
  if (s.enum)
    parts.push(
      `one of ${s.enum
        .slice(0, 20)
        .map(v => JSON.stringify(v))
        .join(', ')}${s.enum.length > 20 ? ', …' : ''}`,
    );
  return parts.join(' ');
}

function relationships(
  page: PageMeta,
  controls: readonly ManifestAction[],
  rooms: readonly { surface: ManifestSurface; catalog: RoomCatalogData }[],
  pages: readonly PageMeta[],
  api: ReadonlyMap<string, ApiOperation>,
): KnowledgeEntry | null {
  const lines: string[] = [];
  for (const { catalog } of rooms) {
    const kinds = [...new Set(catalog.fields.flatMap(f => f.appliesTo))].sort();
    for (const kind of kinds) {
      const fields = catalog.fields.filter(f => f.appliesTo.includes(kind));
      lines.push(
        `In the ${catalog.title}, ${kind} accepts: ${fields.map(f => `${f.title} (${f.id})`).join(', ')}.`,
      );
    }
    const keyframeable = catalog.fields.filter(isKeyframeable);
    if (keyframeable.length) {
      lines.push(
        `Keyframeable (set at the playhead, a keyframe there when animated): ${keyframeable.map(f => f.title).join(', ')}.`,
      );
    }
    const creators = catalog.actions.filter(a => a.effect === 'edit' && CREATE_VERB.test(a.title));
    if (creators.length)
      lines.push(`These make something new and select it: ${creators.map(a => a.title).join(', ')}.`);
    const selectors = catalog.actions.filter(a => a.effect === 'selection');
    if (selectors.length)
      lines.push(
        `These change what is selected, which fields act on: ${selectors.map(a => a.title).join(', ')}.`,
      );
  }
  for (const a of controls) {
    const e = a.effect;
    if (e && typeof e === 'object' && e.kind === 'navigate') {
      const target = pageForRoute(pages, e.to);
      lines.push(`${a.title} [${a.name}] leads to ${target ? target.title : e.to} (${e.to}).`);
    }
    if (e && typeof e === 'object' && e.kind === 'mutate') {
      const op = api.get(e.operation);
      lines.push(
        `${a.title} [${a.name}] changes data: ${e.operation}${op ? ` — ${op.method} ${op.url}${op.summary ? `, ${op.summary}` : ''}` : ''}.`,
      );
    }
  }
  if (!lines.length) return null;
  return { title: `${page.title}: how things relate`, content: lines.join('\n') };
}

function recipes(
  page: PageMeta,
  controls: readonly ManifestAction[],
  rooms: readonly { surface: ManifestSurface; catalog: RoomCatalogData }[],
): KnowledgeRecipe[] {
  const out: KnowledgeRecipe[] = [];
  const verify = `Read the page's state and ${PROBLEMS_OBSERVATION_ID} in the result, and tell the user only what they confirm.`;

  // Fill and submit: each dialog with controls inside it.
  const dialogs = new Map<
    string,
    { step: Extract<ReachStep, { kind: 'dialog' }>; actions: ManifestAction[]; before: ReachStep[] }
  >();
  for (const a of controls) {
    const i = a.reach.findIndex(s => s.kind === 'dialog');
    if (i === -1) continue;
    const step = a.reach[i] as Extract<ReachStep, { kind: 'dialog' }>;
    const key = `${step.title}|${step.binding ?? ''}`;
    const entry = dialogs.get(key) ?? { step, actions: [], before: a.reach.slice(1, i) };
    entry.actions.push(a);
    dialogs.set(key, entry);
  }
  for (const { step, actions, before: inside } of dialogs.values()) {
    // Be where its opener is: the dialog may be mounted anywhere on the page.
    const opener = controls.find(c => step.openedBy.includes(c.id));
    const before = opener ? opener.reach.slice(1) : inside;
    const fields = actions.filter(a => a.control && a.control !== 'button' && a.control !== 'dialog');
    const buttons = actions.filter(a => a.control === 'button');
    const finish = buttons.filter(
      a => a.effect && typeof a.effect === 'object' && a.effect.kind === 'mutate',
    );
    out.push({
      name: `Use the "${step.title}" dialog`,
      trigger: `Anything done in the "${step.title}" dialog on ${page.title}`,
      steps: [
        ...before.map(s => `Be ${describeStep(s)}.`),
        step.openedBy.length
          ? `Open it with ${step.openedBy.map(toolName).join(' or ')}.`
          : 'Open it from the page.',
        ...(fields.length
          ? [`Set what it asks for: ${fields.map(f => `${f.title} [${f.name}]`).join(', ')}.`]
          : []),
        ...((finish.length ? finish : buttons).length
          ? [
              `Finish with ${(finish.length ? finish : buttons).map(b => `${b.title} [${b.name}]`).join(' or ')}.`,
            ]
          : []),
        verify,
      ],
    });
  }

  // Act on a row.
  const rowed = controls.filter(a => a.itemized);
  if (rowed.length) {
    out.push({
      name: `Act on one row on ${page.title}`,
      trigger: `Doing something to one listed item on ${page.title}`,
      steps: [
        `Find the row in the page state's lists: its key (id) and title.`,
        `Call the row's tool with it as item: ${[...new Set(rowed.map(a => `${a.title} [${a.name}]`))].join(', ')}.`,
        verify,
      ],
    });
  }

  for (const { catalog } of rooms) {
    const doc = catalog.observations.find(o => o.id !== PROBLEMS_OBSERVATION_ID);
    const selectors = catalog.actions.filter(a => a.effect === 'selection');
    const setFields = roomToolName(catalog.room, ROOM_SET_PROPERTIES_ID);
    const roomVerify = `Read ${doc ? doc.id : 'the room’s observations'} and ${PROBLEMS_OBSERVATION_ID}; if something is not drawn, fix that before saying it is done.`;
    if (catalog.fields.length && selectors.length) {
      out.push({
        name: `Change a property in the ${catalog.title}`,
        trigger: `Changing how something already in the ${catalog.title} looks`,
        steps: [
          `Find its id in ${doc ? doc.id : 'the room’s observation'}.`,
          `Select it with ${selectors.map(a => roomToolName(catalog.room, a.id)).join(' or ')}.`,
          `Set the fields that apply to its kind with ${setFields}, giving their ids under values (the relationships say which).`,
          roomVerify,
        ],
      });
    }
    for (const creator of catalog.actions.filter(a => a.effect === 'edit' && CREATE_VERB.test(a.title))) {
      out.push({
        name: `${creator.title} and style it`,
        trigger: `Making something new with ${creator.title} in the ${catalog.title}`,
        steps: [
          `Make it with ${roomToolName(catalog.room, creator.id)}; the result names it and it is selected.`,
          ...(catalog.fields.length
            ? [`Style it with ${setFields}, using the fields that apply to what it made.`]
            : []),
          roomVerify,
        ],
      });
    }
    // Tasks only the room knows, as it declares them.
    for (const declared of catalog.recipes ?? []) {
      const { recipe } = resolveRecipe(catalog, declared);
      out.push({ ...recipe, steps: [...recipe.steps, roomVerify] });
    }
    out.push({
      name: `Fix what the ${catalog.title} reports`,
      trigger: `${PROBLEMS_OBSERVATION_ID} lists anything, or the user cannot see something`,
      steps: [
        `Read ${PROBLEMS_OBSERVATION_ID}: each says what is wrong, what it hides, and which action resolves it.`,
        'Resolve each with the action it names, using one of the choices it offers.',
        roomVerify,
      ],
    });
  }
  return out;
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return m ? m[1] : text.trim();
}

// ─── The app's map ───────────────────────────────────────────────────────────

/** The map's title: the knowledge's `overview`. */
export const APP_MAP_TITLE = 'The app’s pages';

/** One page's line on the map before it is fitted: where it sits, how it is reached, and what it offers. */
interface MapLine {
  page: PageMeta;
  depth: number;
  /** The controls on its parent that lead to it; none for a sidebar page or one reached by address. */
  via: readonly PageLink[];
  capabilities: Capability[];
  /** The line without what it offers. */
  head: string;
  /** For a frame's line: the whole line is text, not a page's. */
  frame?: true;
  /**
   * The first sentence of what the page tells the assistant it is for
   * (`@agentDescription`): the head ends with it, and what the page offers
   * follows it.
   */
  says?: string;
}

/** A page's line on the map, before what it offers: with what the page tells the assistant it is for, when it declares that. */
function mapHead(page: PageMeta, head: string): Pick<MapLine, 'head' | 'says'> {
  if (!page.agentDescription) return { head };
  const says = firstSentence(page.description);
  return { head: `${head}: ${says}`, says };
}

/**
 * Whether `parent` is open to every session `child` is open to (`routeGates`):
 * each route of the child has a route of the parent whose gates are among its
 * own. A page goes under another on the map only then, so a session that may
 * see it never finds it under a page it may not. Always, in a build with no
 * gates.
 */
function openWhenever(parent: PageMeta, child: PageMeta): boolean {
  const gatesOf = (page: PageMeta, route: string) => page.gates?.[route] ?? [];
  return child.routes.every(c => {
    const needs = new Set(gatesOf(child, c));
    return parent.routes.some(p => gatesOf(parent, p).every(g => needs.has(g)));
  });
}

/** The longest run of route segments two routes start with. */
function sharedSegments(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** What a page offers, grouped by where it is: "Edit: Remove, Expand; Select: Object", and "…" when it offers more. */
function capabilityText(capabilities: readonly Capability[], taken: number): string {
  const groups = new Map<string, string[]>();
  for (const c of capabilities.slice(0, taken)) groups.set(c.group, [...(groups.get(c.group) ?? []), c.title]);
  const text = [...groups.entries()].map(([group, titles]) => (group ? `${group}: ${titles.join(', ')}` : titles.join(', '))).join('; ');
  return taken < capabilities.length ? (text ? `${text} …` : '…') : text;
}

/**
 * The app's map: every page under its sidebar group, a page opened from
 * another indented under it with the controls that open it, the pages reached
 * only by address after them, and the app's frame. Each says what it offers,
 * fitted to `budget` characters: every page keeps its line, and what is left is
 * shared by how much each offers. The same for every page of a build.
 */
export function appMap(
  pages: readonly PageMeta[],
  frames: readonly PageMeta[],
  surfaces: readonly ManifestSurface[],
  links: ReturnType<typeof pageLinks>,
  nav: readonly NavEntry[],
  outside: readonly OutsidePage[],
  budget: number,
): KnowledgeEntry {
  return { title: APP_MAP_TITLE, content: appMapContent(appMapLines(pages, frames, surfaces, links, nav, outside, budget)) };
}

/**
 * The app's map line by line (`appMap`): a page's line names its page, so a
 * session that may not see a page (`routeGates`) is given the map without it
 * (`appMapContent`). A page is placed under another only when that page is
 * open whenever it is.
 */
export function appMapLines(
  pages: readonly PageMeta[],
  frames: readonly PageMeta[],
  surfaces: readonly ManifestSurface[],
  links: ReturnType<typeof pageLinks>,
  nav: readonly NavEntry[],
  outside: readonly OutsidePage[],
  budget: number,
): AppMapLine[] {
  const bySurface = new Map(pages.map(p => [p.surface, p]));
  const route = (p: PageMeta) => p.routes[0];

  // The sidebar's pages, in its order, under its groups.
  const groups: { group: string; roots: PageMeta[] }[] = [];
  const rooted = new Set<string>();
  for (const n of nav) {
    const page = pageForRoute(pages, n.route);
    const group = n.group || 'Main';
    let entry = groups.find(g => g.group === group);
    if (!entry) groups.push((entry = { group, roots: [] }));
    if (page && !rooted.has(page.surface)) {
      rooted.add(page.surface);
      entry.roots.push(page);
    }
  }

  // Every other page under the page nearest the sidebar that leads to it:
  // fewest steps, then the one whose route it continues, then the sidebar's order.
  const order = new Map<string, number>();
  const depth = new Map<string, number>();
  let frontier = groups.flatMap(g => g.roots.map(p => p.surface));
  frontier.forEach((s, i) => {
    depth.set(s, 0);
    order.set(s, i);
  });
  const parent = new Map<string, { from: string; via: PageLink[] }>();
  while (frontier.length) {
    const reached = new Map<string, { from: string; via: PageLink[] }[]>();
    for (const from of frontier) {
      for (const [to, via] of links.get(from) ?? []) {
        if (depth.has(to) || !bySurface.has(to)) continue;
        // Under a page only when that page is open whenever this one is.
        if (!openWhenever(bySurface.get(from)!, bySurface.get(to)!)) continue;
        reached.set(to, [...(reached.get(to) ?? []), { from, via }]);
      }
    }
    const next: string[] = [];
    for (const [to, candidates] of [...reached.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const target = bySurface.get(to)!;
      const best = [...candidates].sort((a, b) => {
        const pa = bySurface.get(a.from)!;
        const pb = bySurface.get(b.from)!;
        const sa = Math.max(...pa.routes.flatMap(r => target.routes.map(t => sharedSegments(r, t))));
        const sb = Math.max(...pb.routes.flatMap(r => target.routes.map(t => sharedSegments(r, t))));
        return sb - sa || order.get(a.from)! - order.get(b.from)!;
      })[0];
      parent.set(to, best);
      depth.set(to, depth.get(best.from)! + 1);
      next.push(to);
    }
    next.forEach((s, i) => order.set(s, order.size + i));
    frontier = next;
  }

  const capabilitiesFor = (p: PageMeta, frame = false) => capabilitiesOf(actionsOfPage(p as AppPage, surfaces, { frame }));
  const lines: MapLine[] = [];
  const childrenOf = (surface: string) =>
    [...parent.entries()]
      .filter(([, edge]) => edge.from === surface)
      .map(([to]) => bySurface.get(to)!)
      .sort((a, b) => a.title.localeCompare(b.title) || a.surface.localeCompare(b.surface));
  const place = (page: PageMeta, d: number, via: readonly PageLink[]) => {
    const indent = '  '.repeat(d);
    lines.push({
      page,
      depth: d,
      via,
      capabilities: capabilitiesFor(page),
      ...mapHead(page, `${indent}- ${page.title} ${route(page)}${via.length ? ` (from ${via[0].title})` : ''}`),
    });
    for (const child of childrenOf(page.surface)) place(child, d + 1, parent.get(child.surface)!.via);
  };
  const out: (string | MapLine)[] = [
    'Every page: sidebar groups, then their pages; a page opened from another is indented under it (from the control that opens it). After each, what it offers, by where it is (a menu, a tab), most telling first; "…": more.',
  ];
  // The headings among the lines: each heads the page lines after it.
  const headings = new Set<string>();
  for (const { group, roots } of groups) {
    if (!roots.length) continue;
    out.push(`${group}:`);
    headings.add(`${group}:`);
    const start = lines.length;
    for (const root of roots) place(root, 0, []);
    out.push(...lines.slice(start));
  }
  const unplaced = pages.filter(p => !depth.has(p.surface)).sort((a, b) => a.title.localeCompare(b.title) || a.surface.localeCompare(b.surface));
  if (unplaced.length) {
    out.push('Opened by address only:');
    headings.add('Opened by address only:');
    for (const page of unplaced) {
      const line: MapLine = { page, depth: 0, via: [], capabilities: capabilitiesFor(page), ...mapHead(page, `- ${page.title} ${route(page)}`) };
      lines.push(line);
      out.push(line);
    }
  }
  // The frame: what is on every page, once, whichever frame component holds it; a frame around some pages, by those pages.
  const everywhere = frames.filter(f => f.routes.includes('*'));
  if (everywhere.length) {
    const actions = surfaces.filter(s => s.kind !== 'navigation' && s.kind !== 'page' && (s.kind === 'shell' ? everywhere.some(f => f.surface === s.id) : s.routes.includes('*'))).flatMap(s => s.actions);
    const line: MapLine = { page: everywhere[0], depth: 0, via: [], capabilities: capabilitiesOf(actions), head: 'On every page (the app’s frame)', frame: true };
    lines.push(line);
    out.push(line);
  }
  for (const frame of frames.filter(f => !f.routes.includes('*'))) {
    const line: MapLine = { page: frame, depth: 0, via: [], capabilities: capabilitiesFor(frame, true), ...mapHead(frame, `Around ${frame.routes.join(', ')} (${frame.title})`), frame: true };
    lines.push(line);
    out.push(line);
  }
  const tail = [
    pages.some(p => p.query)
      ? `Go to any page by its address with [${toolName(NAVIGATE_ACTION_ID)}]; a page whose address takes a query opens already filtered, in one call. An item's page (its route has an :id) opens from the page above it.`
      : `Go to any page by its address with [${toolName(NAVIGATE_ACTION_ID)}]. An item's page (its route has an :id) opens from the page above it.`,
    ...(outside.length
      ? [
          `You are not on these pages, so you cannot act on them or take the person to them: ${outside
            .flatMap(o => o.routes.map(r => ({ route: r, reason: o.reason })))
            .sort((a, b) => a.route.localeCompare(b.route))
            .map(o => `${o.route} (${o.reason})`)
            .join(', ')}.`,
        ]
      : []),
  ];

  // Fit: the fixed text first; then the first capability of every page whose
  // first makes something or starts work, in the map's order; then one more at
  // a time to the page furthest below its share, a share growing with how much
  // the page offers.
  const fixed =
    out.reduce<number>((n, part) => n + (typeof part === 'string' ? part.length : part.head.length) + 1, 0) +
    tail.reduce((n, t) => n + t.length + 1, 0);
  const taken = new Map<MapLine, number>(lines.map(l => [l, 0]));
  /** What joins the head and what the page offers: after the page's own sentence, a space. */
  const joint = (l: MapLine) => (l.says !== undefined ? ' ' : ': ');
  const lineLength = (l: MapLine, n: number) => {
    const text = capabilityText(l.capabilities, n);
    return text ? text.length + joint(l).length : 0;
  };
  let used = fixed + lines.reduce((n, l) => n + lineLength(l, 0), 0);
  const grow = (l: MapLine): boolean => {
    const n = taken.get(l)!;
    if (n >= l.capabilities.length) return false;
    const cost = lineLength(l, n + 1) - lineLength(l, n);
    if (used + cost > budget) return false;
    used += cost;
    taken.set(l, n + 1);
    return true;
  };
  // Every page whose most telling capability makes something or starts work names it.
  for (const l of lines) if (l.capabilities[0] && l.capabilities[0].rank <= 1) grow(l);
  // Then by how much each page offers that makes something or starts work: a studio before a settings page.
  const weight = (l: MapLine) => l.capabilities.filter(c => c.rank <= 2).length + 1;
  for (;;) {
    const candidates = lines
      .filter(l => taken.get(l)! < l.capabilities.length && l.capabilities[taken.get(l)!].rank <= 5)
      .sort((a, b) => (taken.get(a)! + 1) / weight(a) - (taken.get(b)! + 1) / weight(b) || lines.indexOf(a) - lines.indexOf(b));
    if (!candidates.some(grow)) break;
  }
  // A page that offers nothing a person names is said by its description's first sentence, while there is room.
  const text = new Map<MapLine, string>();
  for (const l of lines) {
    if (l.capabilities.length) {
      text.set(l, capabilityText(l.capabilities, taken.get(l)!));
      continue;
    }
    // Its head says it already.
    if (l.says !== undefined) continue;
    const sentence = firstSentence(l.page.description);
    if (used + sentence.length + 2 <= budget) {
      used += sentence.length + 2;
      text.set(l, sentence);
    }
  }
  const asLine = (part: string | MapLine): AppMapLine => {
    if (typeof part === 'string') return headings.has(part) ? { kind: 'heading', text: part } : { kind: 'text', text: part };
    const offers = text.get(part);
    if (part.frame) return { kind: 'text', text: offers ? `${part.head}${joint(part)}${offers}` : part.head };
    return {
      kind: 'page',
      surface: part.page.surface,
      depth: part.depth,
      title: part.page.title,
      route: route(part.page),
      ...(part.via.length ? { from: part.via[0].title } : {}),
      ...(part.says !== undefined ? { says: part.says } : {}),
      ...(offers ? { offers } : {}),
    };
  };
  return [...out.map(asLine), ...tail.map(t => ({ kind: 'text' as const, text: t }))];
}
