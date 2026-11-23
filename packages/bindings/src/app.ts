/**
 * The app as a whole, read from its generated manifest: which surfaces each
 * page holds, what each page offers as a person would name it, how pages lead
 * to each other, and the way from one page to another.
 *
 * One implementation for every reader: the generator writes the app's map and
 * the descriptions it derives with it, and the tab's lookup (`lookup.ts`)
 * answers the assistant's app-wide search with it, so the map, a page's
 * description and a search result never disagree. Every rule here is generic:
 * none names a feature.
 */
import type { ManifestAction, ManifestSurface, ReachStep } from '@ouispec/contract';

import { toolName } from './binding.js';
import { effectKind, requiresApproval } from './effect.js';
import type { JsonSchema } from './json-schema.js';
import { NAVIGATE_ACTION_ID, routeMatcher } from './manifest.js';
import { ROOM_RUN_COMMAND_ID, ROOM_SET_PROPERTIES_ID } from './room.js';

/** A page as the app-wide readers see it: its surface, its routes and its title. */
export interface AppPage {
  surface: string;
  routes: readonly string[];
  title: string;
}

/** One step of the way a person reaches a capability, in words, with the tool that takes it. */
export function describeStep(step: ReachStep): string {
  switch (step.kind) {
    case 'route':
      return `on ${step.title} (${step.path})`;
    case 'tab':
      return `on the "${step.title}" tab (select it with ${toolName(step.binding)})`;
    case 'dialog':
      return `in the "${step.title}" dialog${step.openedBy.length ? ` (open it with ${step.openedBy.map(toolName).join(' or ')})` : ''}`;
    case 'menu':
      return `in the ${step.title} menu`;
    case 'panel':
      return `in the ${step.title}${step.openedBy.length ? ` (it shows after ${step.openedBy.map(toolName).join(' or ')})` : ''}`;
    case 'room':
      return step.where;
  }
}

/** Whether a route takes an id: it is one item's page, reached by opening the item. */
export function routeTakesId(route: string): boolean {
  return route.split('/').some(segment => segment.startsWith(':'));
}

/** The page a route or an address is on: its exact route first, then the one whose pattern matches. */
export function pageForRoute<P extends AppPage>(pages: readonly P[], to: string): P | undefined {
  const clean = to.split(/[?#]/)[0] || '/';
  return pages.find(p => p.routes.includes(clean)) ?? pages.find(p => p.routes.some(r => routeMatcher(r).test(clean)));
}

/** What a surface is to a page that holds it. */
export type PagePart = 'own' | 'shared' | 'room' | 'frame';

/**
 * The surfaces a page holds, each with what it is to the page: its own, the
 * components it shares with other pages, the rooms on it, and the app's frame
 * around it. The navigation surface is every page's and no page's: left out.
 */
export function surfacesOfPage(
  page: AppPage,
  surfaces: readonly ManifestSurface[],
): { surface: ManifestSurface; part: PagePart }[] {
  const out: { surface: ManifestSurface; part: PagePart }[] = [];
  for (const s of surfaces) {
    if (s.id === page.surface) {
      out.push({ surface: s, part: 'own' });
      continue;
    }
    if (s.kind === 'page' || s.kind === 'navigation') continue;
    const everywhere = s.routes.includes('*');
    const here = everywhere || s.routes.some(r => page.routes.includes(r));
    if (!here) continue;
    // What is on every page is the frame's, whatever registers it.
    out.push({ surface: s, part: s.kind === 'shell' || everywhere ? 'frame' : s.kind === 'room' ? 'room' : 'shared' });
  }
  return out;
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/** One action as a person names what a page offers. */
export interface Capability {
  title: string;
  /** Its tool name. */
  tool: string;
  /** Where on the page a person finds it: a room's menu, a tab, a panel; '' for the page itself. */
  group: string;
  /** How much it stands for what the page does: 0 is most (`actionRank`). */
  rank: number;
}

const FIELD_CONTROLS = new Set(['text', 'number', 'toggle', 'choice', 'date', 'color', 'font', 'tabs']);

/** Whether an action is a room's generic entry for setting its fields or running its commands. */
export function isRoomPlumbing(action: ManifestAction): boolean {
  return (
    action.source === 'room-action' &&
    (action.id.endsWith(`/action/${ROOM_SET_PROPERTIES_ID}`) || action.id.endsWith(`/action/${ROOM_RUN_COMMAND_ID}`))
  );
}

/** Titles that make something: they say what a page is for. */
const MAKING = /^(add|build|compose|create|design|draw|edit|generate|import|insert|make|new|place|produce|publish|record|render|upload)\b/i;
/** Titles of upkeep, which every page has and which say little about any: listed last. */
const UPKEEP =
  /^(apply|archive|back|cancel|choose|clear|close|confirm|copy|delete|deselect|dismiss|done|duplicate|exit|hide|load more|more|move|next|ok|open|previous|redo|refresh|remove|rename|reset|restore|retry|save|search|select|show|sort|try again|undo|unarchive|unlink)\b/i;

/**
 * How much an action stands for what its page does, by one rule: work it
 * starts (0); a room's editing actions and controls that make something (1);
 * other changes it saves and a room's other actions (2); openers and buttons
 * (3); navigation (4); fields, which belong to the capability they set (5).
 * An action of upkeep (delete, cancel, refresh, …) comes after all of those,
 * unless it starts work.
 */
export function actionRank(action: ManifestAction): number {
  const kind = action.effect === undefined ? undefined : effectKind(action.effect);
  if (kind === 'job') return 0;
  const field = !!action.control && FIELD_CONTROLS.has(action.control);
  const base =
    action.source === 'room-action'
      ? kind === 'edit'
        ? 1
        : 2
      : !field && MAKING.test(action.title)
        ? 1
        : kind === 'mutate' || kind === 'transaction'
          ? 2
          : kind === 'navigate'
            ? 4
            : field
              ? 5
              : 3;
  return UPKEEP.test(action.title.trim()) ? base + 6 : base;
}

/**
 * Where on its page a person finds an action, as a group name: the first part
 * of a room action's menu path ("Edit" for "Edit › Remove"), or the tab it is
 * on; '' for the page itself.
 */
export function actionGroup(action: ManifestAction): string {
  for (const step of action.reach) {
    if (step.kind === 'room') {
      // A menu or panel's name: a short head ("Edit", "Layers panel"), not a sentence about a gesture.
      const head = step.where.split(/ › |: |, | \(/)[0].trim().replace(/ menu$/i, '');
      return head.split(/\s+/).length <= 3 ? head : '';
    }
    if (step.kind === 'tab') return step.title;
  }
  return '';
}

/** Whether an action is inside a dialog: the dialog's opener stands for it. */
function insideDialog(action: ManifestAction): boolean {
  return action.reach.some(step => step.kind === 'dialog');
}

/**
 * What a set of actions offers, most telling first: each capability once by
 * title (whatever its case), the actions inside a dialog and a room's generic
 * entries left out. Ties keep the order the actions were given in.
 */
export function capabilitiesOf(actions: readonly ManifestAction[]): Capability[] {
  const best = new Map<string, { capability: Capability; index: number }>();
  actions.forEach((action, index) => {
    if (action.source === 'navigation' || insideDialog(action) || isRoomPlumbing(action)) return;
    const title = action.title.trim();
    if (!title) return;
    const key = title.toLowerCase();
    const capability: Capability = { title, tool: action.name, group: actionGroup(action), rank: actionRank(action) };
    const before = best.get(key);
    if (!before || capability.rank < before.capability.rank) best.set(key, { capability, index: before?.index ?? index });
  });
  return [...best.values()]
    .sort((a, b) => a.capability.rank - b.capability.rank || a.index - b.index)
    .map(b => b.capability);
}

/** The actions a page offers, its own first, then its shared parts and rooms; the frame's only when asked for. */
export function actionsOfPage(
  page: AppPage,
  surfaces: readonly ManifestSurface[],
  { frame = false }: { frame?: boolean } = {},
): ManifestAction[] {
  const order: Record<PagePart, number> = { own: 0, room: 1, shared: 2, frame: 3 };
  return surfacesOfPage(page, surfaces)
    .filter(p => frame || p.part !== 'frame')
    .sort((a, b) => order[a.part] - order[b.part])
    .flatMap(p => p.surface.actions);
}

/** A list in words: "a, b and c". */
export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How many capabilities a derived description names. */
export const DESCRIPTION_CAPABILITIES = 5;

/**
 * A page's description, derived from what it offers when the page declares
 * none: "Offers Remove, Generative Fill and Expand, among 261 actions." Null
 * when it offers nothing a person would name.
 */
export function describedByActions(actions: readonly ManifestAction[]): string | null {
  const capabilities = capabilitiesOf(actions);
  if (!capabilities.length) return null;
  const named = capabilities.slice(0, DESCRIPTION_CAPABILITIES).map(c => c.title);
  const total = actions.filter(a => a.source !== 'navigation').length;
  return `Offers ${listed(named)}${total > named.length ? `, among ${total} actions` : ''}.`;
}

// ─── How pages lead to each other ────────────────────────────────────────────

/** One control that leads from a page to another. */
export interface PageLink {
  title: string;
  tool: string;
  /** One per row: the control opens the row it is used on. */
  itemized: boolean;
}

/** From each page's surface, the pages its controls lead to, by surface, with the controls that do. */
export type PageLinks = Map<string, Map<string, PageLink[]>>;

/**
 * How pages lead to each other: the navigate effects of the controls on each
 * page (its own, its shared parts and its rooms). The frame leads everywhere
 * from everywhere, so it says nothing about where a page is reached from.
 */
export function pageLinks(pages: readonly AppPage[], surfaces: readonly ManifestSurface[]): PageLinks {
  const links: PageLinks = new Map();
  for (const page of pages) {
    for (const action of actionsOfPage(page, surfaces)) {
      const effect = action.effect;
      if (!effect || typeof effect !== 'object' || effect.kind !== 'navigate') continue;
      const target = pageForRoute(pages, effect.to);
      if (!target || target.surface === page.surface) continue;
      const byTarget = links.get(page.surface) ?? new Map<string, PageLink[]>();
      const via = byTarget.get(target.surface) ?? [];
      if (!via.some(v => v.tool === action.name)) via.push({ title: action.title, tool: action.name, itemized: !!action.itemized });
      byTarget.set(target.surface, via);
      links.set(page.surface, byTarget);
    }
  }
  return links;
}

/** One step of the way to a page. */
export type WayStep =
  | { kind: 'navigate'; page: AppPage; path: string }
  | { kind: 'open'; from: AppPage; to: AppPage; via: PageLink[] };

/**
 * The shortest way from the page the person is on to another: nothing when it
 * is the same page; a page whose route takes no id is gone to by its address;
 * an item's page is opened from a page that leads to it, itself reached the
 * same way. Null when nothing leads to it.
 */
export function wayTo(
  from: AppPage | null,
  to: AppPage,
  pages: readonly AppPage[],
  links: PageLinks,
): WayStep[] | null {
  if (from && from.surface === to.surface) return [];
  const direct = to.routes.find(r => !routeTakesId(r));
  if (direct) return [{ kind: 'navigate', page: to, path: direct }];
  // Backwards from the page, over the controls that lead to it, until the
  // page the person is on or a page reached by its address.
  const bySurface = new Map(pages.map(p => [p.surface, p]));
  const into = new Map<string, { from: string; via: PageLink[] }[]>();
  for (const [source, targets] of links) {
    for (const [target, via] of targets) into.set(target, [...(into.get(target) ?? []), { from: source, via }]);
  }
  const next = new Map<string, { to: string; via: PageLink[] }>();
  const seen = new Set([to.surface]);
  let frontier = [to.surface];
  while (frontier.length) {
    const found: string[] = [];
    const after: string[] = [];
    for (const surface of frontier) {
      for (const edge of [...(into.get(surface) ?? [])].sort((a, b) => a.from.localeCompare(b.from))) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        next.set(edge.from, { to: surface, via: edge.via });
        const page = bySurface.get(edge.from);
        if (!page) continue;
        if ((from && edge.from === from.surface) || page.routes.some(r => !routeTakesId(r))) found.push(edge.from);
        else after.push(edge.from);
      }
    }
    if (found.length) {
      // The page the person is on, when it is one of them: no address to go to first.
      const start = from && found.includes(from.surface) ? from.surface : found[0];
      const steps: WayStep[] = [];
      const startPage = bySurface.get(start)!;
      if (!from || start !== from.surface) {
        steps.push({ kind: 'navigate', page: startPage, path: startPage.routes.find(r => !routeTakesId(r))! });
      }
      let at = start;
      while (at !== to.surface) {
        const hop = next.get(at)!;
        steps.push({ kind: 'open', from: bySurface.get(at)!, to: bySurface.get(hop.to)!, via: hop.via });
        at = hop.to;
      }
      return steps;
    }
    frontier = after;
  }
  return null;
}

/** A way's steps in words the assistant follows, naming each tool. */
export function wayWords(steps: readonly WayStep[]): string[] {
  return steps.map(step =>
    step.kind === 'navigate'
      ? `Go to ${step.page.title} (${step.path}) with ${toolName(NAVIGATE_ACTION_ID)}.`
      : `On ${step.from.title}, open ${step.to.title} with ${step.via
          .slice(0, 3)
          .map(v => `${v.title} [${v.tool}]${v.itemized ? ' on the row you want (item)' : ''}`)
          .join(' or ')}.`,
  );
}

// ─── What an action needs first ──────────────────────────────────────────────

/** Words that say a control or an input is about pictures. */
const PICTURE_WORDS = /\b(picture|image|photo)s?\b/i;

/** The schemas directly inside one: its properties, its items and its alternatives. */
function schemaParts(schema: JsonSchema): JsonSchema[] {
  return [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ];
}

/** Whether an action's input takes a file the person attached (`format: oui-attachment`) somewhere in it. */
export function takesAttachment(input: JsonSchema | undefined): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.format === 'oui-attachment') return true;
  return schemaParts(input).some(takesAttachment);
}

/** The media types an attachment input accepts, wherever it is in the input. */
export function attachmentMediaTypes(input: JsonSchema | undefined): string[] {
  if (!input || typeof input !== 'object') return [];
  const own = input.format === 'oui-attachment' ? (input['x-oui-attachment']?.mediaTypes ?? []) : [];
  return [...new Set([...own, ...schemaParts(input).flatMap(attachmentMediaTypes)])];
}

/**
 * Whether an action takes a picture: an attached file whose types are
 * pictures (or that takes any file on a control of pictures), or an input
 * whose alternatives point at pictures by id. Read from the declarations only.
 */
export function takesPicture(action: ManifestAction): boolean {
  const types = attachmentMediaTypes(action.input);
  if (types.some(t => t.startsWith('image/'))) return true;
  // A file of any type, on a control whose own words are about pictures.
  if (!types.length && takesAttachment(action.input) && PICTURE_WORDS.test(`${action.title} ${action.description}`)) return true;
  return pictureSources(action).length > 0;
}

/**
 * The pictures an action's input says it takes besides an attached file: each
 * property that names a picture by id, with its own description ("A library
 * picture, by id"), wherever it is in the input.
 */
export function pictureSources(action: ManifestAction): string[] {
  const out: string[] = [];
  const visit = (schema: JsonSchema | undefined, depth: number) => {
    if (!schema || typeof schema !== 'object' || depth > 4) return;
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const description = typeof prop.description === 'string' ? prop.description : '';
      if (/Id$/.test(name) && PICTURE_WORDS.test(description)) out.push(`${name}: ${description}`.trim());
      visit(prop, depth + 1);
    }
    if (schema.items) visit(schema.items, depth + 1);
    for (const alt of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) visit(alt, depth + 1);
  };
  visit(action.input, 0);
  return [...new Set(out)];
}

/** What an action needs before it runs, in words, as far as its declaration knows. */
export function actionNeeds(action: ManifestAction, page: AppPage | null, room?: ManifestSurface): string[] {
  const needs: string[] = [];
  const itemRoute = page?.routes.find(routeTakesId);
  if (page && itemRoute && page.routes.every(routeTakesId)) needs.push(`an open item: ${page.title} shows one (${itemRoute})`);
  if (action.itemized) needs.push('a row of its list: name it with item');
  for (const step of action.reach) {
    if (step.kind === 'tab') needs.push(`the "${step.title}" tab selected (${toolName(step.binding)})`);
    if (step.kind === 'dialog')
      needs.push(`the "${step.title}" dialog open${step.openedBy.length ? ` (${step.openedBy.map(toolName).join(' or ')})` : ''}`);
    if (step.kind === 'panel')
      needs.push(`the ${step.title} showing${step.openedBy.length ? ` (${step.openedBy.map(toolName).join(' or ')})` : ''}`);
  }
  const kind = action.effect === undefined ? undefined : effectKind(action.effect);
  if (room && action.source === 'room-action' && kind !== 'selection' && /\bselect(ed|ion)\b/i.test(action.description)) {
    const selecting = room.actions
      .filter(a => a.effect !== undefined && effectKind(a.effect) === 'selection' && /^select\b/i.test(a.title))
      .map(a => `${a.title} [${a.name}]`)
      .slice(0, 5);
    needs.push(`a selection in the ${room.title}${selecting.length ? `: make one with ${selecting.join(', ')}, or another of its selection actions` : ''}`);
  }
  if (requiresApproval(action.effect, action.destructive) || action.confirm) needs.push("the person's approval of the call");
  if (takesAttachment(action.input)) needs.push('a file the person attached to the conversation, by its id, where it takes a file');
  return needs;
}
