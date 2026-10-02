/**
 * The knowledge generated from the same declarations as the surfaces
 * (ADR-0220 §2.5): what each page offers, how to reach it, its parameters,
 * the relationships its types imply, and the task recipes the UI implies.
 *
 * The recipe templates below are the only prose written here. They are
 * generic — none names a feature — and each is instantiated only from what
 * the declarations say. A task only a room knows is a recipe the room
 * declares; none is inferred from what its entries are called.
 */

import {
  isKeyframeable,
  NAVIGATE_ACTION_ID,
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
} from '@ouispec/bindings';

import { describeStep, type PageMeta } from './assemble.js';
import type { ApiOperation, NavEntry } from './inputs.js';
import { resolveRecipe, roomToolName } from './recipes.js';

const CREATE_VERB = /^(add|create|draw|new|place|insert|make)\b/i;

export function generateKnowledge(
  surfaces: readonly ManifestSurface[],
  pages: readonly PageMeta[],
  frames: readonly PageMeta[],
  catalogs: readonly RoomCatalogData[],
  nav: readonly NavEntry[],
  api: ReadonlyMap<string, ApiOperation>,
): { overview: KnowledgeEntry; pages: PageKnowledge[]; frames?: PageKnowledge[] } {
  const byId = new Map(surfaces.map(s => [s.id, s]));
  const byRoom = new Map(catalogs.map(c => [`room:${c.room}`, c]));

  // Which pages lead to which, from navigate effects.
  const leadsTo = new Map<string, Set<string>>();
  for (const page of pages) {
    const actions = [page.surface, ...page.shared].flatMap(id => byId.get(id)?.actions ?? []);
    for (const a of actions) {
      if (a.effect && typeof a.effect === 'object' && a.effect.kind === 'navigate') {
        const target = pageForRoute(pages, a.effect.to);
        if (target && target.surface !== page.surface) {
          const set = leadsTo.get(page.surface) ?? new Set();
          set.add(target.surface);
          leadsTo.set(page.surface, set);
        }
      }
    }
  }

  const overview = overviewEntry(pages, nav);
  const out: PageKnowledge[] = pages.map(page => {
    const own = byId.get(page.surface)!;
    const shared = page.shared.map(id => byId.get(id)!).filter(Boolean);
    const rooms = page.rooms
      .map(id => ({ surface: byId.get(id)!, catalog: byRoom.get(id)! }))
      .filter(r => r.surface && r.catalog);
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
        content: `${page.title} (${page.routes.join(', ')})${page.nav ? `, in the sidebar under ${page.nav}` : ''}: ${firstSentence(page.description)}`,
      },
      detail: {
        title: `${page.title} (${page.routes.join(', ')})`,
        content: detail(page, controls, rooms, api),
      },
      relationships: relationships(page, controls, rooms, pages, api),
      recipes: recipes(page, controls, rooms),
      adjacent: [...adjacent].sort(),
    };
  });
  // The frame: what it offers and where, on every page it frames. No recipes of
  // its own: its controls take part in the pages' tasks.
  const frameKnowledge: PageKnowledge[] = frames.map(frame => {
    const own = byId.get(frame.surface);
    const controls = own ? [...own.actions] : [];
    return {
      surface: frame.surface,
      routes: frame.routes,
      summary: { title: frame.title, content: `${frame.title}: ${firstSentence(frame.description)}` },
      detail: { title: frame.title, content: detail(frame, controls, [], api) },
      relationships: null,
      recipes: [],
      adjacent: [],
    };
  });
  return frameKnowledge.length ? { overview, pages: out, frames: frameKnowledge } : { overview, pages: out };
}

function pageForRoute(pages: readonly PageMeta[], to: string): PageMeta | undefined {
  return (
    pages.find(p => p.routes.includes(to)) ?? pages.find(p => p.routes.some(r => routeRegex(r).test(to)))
  );
}

function routeRegex(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split('/')
      .map(s => (s.startsWith(':') ? '[^/]+' : s))
      .join('/')}$`,
  );
}

function overviewEntry(pages: readonly PageMeta[], nav: readonly NavEntry[]): KnowledgeEntry {
  const lines: string[] = [];
  const groups = [...new Set(nav.map(n => n.group))];
  for (const group of groups) {
    const entries = nav.filter(n => n.group === group);
    lines.push(group ? `${group}:` : 'Main:');
    for (const n of entries) {
      const page = pages.find(p => p.routes.includes(n.route));
      lines.push(`- ${n.label} (${n.route})${page ? ` — ${firstSentence(page.description)}` : ''}`);
    }
  }
  const unlisted = pages.filter(p => !nav.some(n => p.routes.includes(n.route))).length;
  lines.push(
    `${unlisted} more pages are reached from these or by address; the page you are on is described in full below, and moving to another page gives you its tools.`,
    `Go to any page by its address with [${toolName(NAVIGATE_ACTION_ID)}]; its path lists every page.`,
  );
  return { title: 'The app’s pages', content: lines.join('\n') };
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
          hidden
            ? `- ${a.title} [${a.name}]: ${bindingDescription(a)}${params(a.input)}${effectNote(a, api)}`
            : `- ${a.title} [${a.name}]${effectNote(a, api)}`,
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
    lines.push('', `${catalog.title} (on this page): ${catalog.description}`);
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
      // would spend the context budget twice (ADR-0167).
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
