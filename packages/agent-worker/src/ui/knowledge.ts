/**
 * The client's knowledge, carried on the turn.
 *
 * A UI client's generator emits knowledge from the same code declarations as
 * its surfaces (ADR-0220, ADR-0226): the app's map, each page in full, how its
 * parts relate, and the recipes its controls imply. The tab resolves it for the
 * page the user is on (oui-bindings' `resolveKnowledge`) and sends it with the
 * turn under `uiKnowledge`, beside its surface snapshot under `oui`.
 *
 * The worker renders it into the system prompt after the host's own prompt, for
 * every host: a persona or a `systemPrompt` callback never sees it as context
 * and never has to render it.
 *
 * It is bounded, as the page's index is (ADR-0245): in session 24611234 the
 * video editor's knowledge was 117,000 characters, most of it a page detail
 * that repeats what the index already lists, in every model call of every
 * turn. What fits in `KNOWLEDGE_PROMPT_CHARS` is sent; the rest of an entry,
 * and a workflow's steps, are read with `ui_guide` when they are needed, and
 * the prompt says what is not shown and how to read it.
 */
import type { ResolvedKnowledge } from '@ouispec/bindings';
import type { RegisteredTool } from '../tools/types.js';

/** The context key a UI client uses for its knowledge. */
export const CLIENT_KNOWLEDGE_KEY = 'uiKnowledge';
/** The tool that reads the rest of the knowledge. */
export const KNOWLEDGE_TOOL = 'ui_guide';
/** The knowledge the system prompt carries at most, in characters. One constant. */
export const KNOWLEDGE_PROMPT_CHARS = 12_000;
/** An entry this size or smaller is never cut: a map, a frame, a neighbouring page's summary. */
const WHOLE_ENTRY_CHARS = 1_500;
/** What one `ui_guide` answer gives at most. */
export const KNOWLEDGE_PAGE_CHARS = 12_000;

/** What a UI client sends: the knowledge for the page the user is on. */
export type ClientKnowledge = ResolvedKnowledge;

/**
 * Read and validate the knowledge from a turn's context. Returns null when the
 * turn carries none (a client with no UI), and throws when it carries knowledge
 * that is malformed: a broken payload is a client bug that must not quietly
 * become "this client knows nothing".
 */
export function readClientKnowledge(context: Record<string, unknown> | null | undefined): ClientKnowledge | null {
  const raw = context?.[CLIENT_KNOWLEDGE_KEY];
  if (raw === undefined || raw === null) return null;
  const where = `context.${CLIENT_KNOWLEDGE_KEY}`;
  if (typeof raw !== 'object') throw new Error(`[agent-sdk] ${where} must be an object`);
  const { entries, workflows } = raw as Record<string, unknown>;
  if (!Array.isArray(entries)) throw new Error(`[agent-sdk] ${where}.entries must be an array`);
  if (!Array.isArray(workflows)) throw new Error(`[agent-sdk] ${where}.workflows must be an array`);
  entries.forEach((e, i) => {
    if (!isEntry(e)) throw new Error(`[agent-sdk] ${where}.entries[${i}] is not a knowledge entry (title, content)`);
  });
  workflows.forEach((w, i) => {
    if (!isWorkflow(w)) throw new Error(`[agent-sdk] ${where}.workflows[${i}] is not a workflow (name, trigger, steps[])`);
  });
  return { entries, workflows } as ClientKnowledge;
}

/** A workflow in full: its trigger and numbered steps. */
function workflowText(w: ClientKnowledge['workflows'][number]): string {
  return `Trigger: ${w.trigger}\nSteps:\n${w.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`;
}

/** `text` cut at a line end at most `max` characters in, never mid-line when a line end is near. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.lastIndexOf('\n', max);
  return text.slice(0, end > max / 2 ? end : max);
}

/**
 * The knowledge as a prompt section, within `maxChars`: every entry whole when
 * all of it fits, and every workflow with its steps. Over that, small entries
 * stay whole, a large one is cut at a line with a note saying how much is left
 * and how to read it, and the workflows are listed by name to be read one at a
 * time.
 */
export function renderClientKnowledge(knowledge: ClientKnowledge, maxChars = KNOWLEDGE_PROMPT_CHARS): string {
  const entryHead = '## Platform Knowledge (Context-Aware)\n\n';
  const workflowHead = '## Active Workflows\n\n';
  const whole = (e: ClientKnowledge['entries'][number]) => `### ${e.title}\n${e.content}`;
  const wholeWorkflows = knowledge.workflows.map((w) => `### ${w.name}\n${workflowText(w)}`).join('\n\n');
  const sections = (entries: string[], workflows: string) =>
    [entries.length ? entryHead + entries.join('\n\n') : '', workflows ? workflowHead + workflows : '']
      .filter(Boolean)
      .join('\n\n');

  const all = sections(knowledge.entries.map(whole), wholeWorkflows);
  if (all.length <= maxChars) return all;

  // The workflows by name: each read whole with the tool.
  const named = knowledge.workflows.length
    ? `Each is read in full, with its steps, by \`${KNOWLEDGE_TOOL}\` with \`workflow\` set to its name.\n` +
      knowledge.workflows.map((w) => `- ${w.name}`).join('\n')
    : '';
  const workflowsSize = named ? workflowHead.length + named.length + 2 : 0;

  // The small entries whole; the large ones share what is left, each cut at a line.
  const small = knowledge.entries.filter((e) => whole(e).length <= WHOLE_ENTRY_CHARS);
  const large = knowledge.entries.filter((e) => whole(e).length > WHOLE_ENTRY_CHARS);
  const fixed = entryHead.length + small.reduce((n, e) => n + whole(e).length + 2, 0);
  const share = Math.max(0, Math.floor((maxChars - workflowsSize - fixed) / Math.max(large.length, 1)) - 200);
  const rendered = knowledge.entries.map((e) => {
    if (!large.includes(e)) return whole(e);
    const shown = cutAt(e.content, share);
    const rest = e.content.length - shown.length;
    return (
      `### ${e.title}\n${shown}` +
      (rest > 0
        ? `\n(${rest} more characters of "${e.title}" are not shown: \`${KNOWLEDGE_TOOL}\` with \`entry\` set to this title and \`from: ${shown.length}\` reads them.)`
        : '')
    );
  });
  return sections(rendered, named);
}

/**
 * Reads what the prompt leaves out of the client's knowledge: the rest of an
 * entry, a page at a time, or a workflow in full. It reads only what the turn's
 * client sent, so it changes nothing and needs no approval.
 */
export function knowledgeTool(knowledge: ClientKnowledge): RegisteredTool {
  const titles = knowledge.entries.map((e) => e.title);
  const names = knowledge.workflows.map((w) => w.name);
  const listed = (items: string[]) => items.slice(0, 40).map((t) => `"${t}"`).join(', ') + (items.length > 40 ? ', …' : '');
  return {
    name: KNOWLEDGE_TOOL,
    kind: 'ui',
    effect: 'view',
    description:
      'Reads the part of what the app knows about this page that your instructions do not show: the rest of a ' +
      'knowledge entry (`entry`, its title, and `from`, where to continue), or one workflow with its steps (`workflow`, its name). ' +
      'Your instructions say what is not shown and give the title or name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry: { type: 'string', description: 'A knowledge entry’s title, as your instructions give it.' },
        workflow: { type: 'string', description: 'A workflow’s name, as your instructions list it.' },
        from: { type: 'integer', minimum: 0, description: 'Where in the entry to begin. Default 0.' },
      },
    },
    async execute(input) {
      const workflow = typeof input.workflow === 'string' ? input.workflow.trim() : '';
      const entry = typeof input.entry === 'string' ? input.entry.trim() : '';
      if (workflow) {
        const found = knowledge.workflows.find((w) => w.name === workflow) ??
          knowledge.workflows.find((w) => w.name.toLowerCase() === workflow.toLowerCase());
        if (!found) return { success: false, error: `No workflow is named "${workflow}". Workflows: ${listed(names)}.` };
        return { success: true, data: { workflow: found.name, text: workflowText(found) } };
      }
      if (entry) {
        const found = knowledge.entries.find((e) => e.title === entry) ??
          knowledge.entries.find((e) => e.title.toLowerCase() === entry.toLowerCase());
        if (!found) return { success: false, error: `No knowledge entry has the title "${entry}". Entries: ${listed(titles)}.` };
        const from = typeof input.from === 'number' && input.from > 0 ? Math.min(input.from, found.content.length) : 0;
        const text = cutAt(found.content.slice(from), KNOWLEDGE_PAGE_CHARS);
        const next = from + text.length;
        return {
          success: true,
          data: {
            entry: found.title,
            from,
            total: found.content.length,
            text,
            ...(next < found.content.length ? { next } : {}),
          },
        };
      }
      return { success: false, error: 'Give an `entry` title or a `workflow` name.' };
    },
  };
}

/** The host's system prompt, followed by the knowledge the turn's client sent, if any. */
export function withClientKnowledge(systemPrompt: string, context: Record<string, unknown> | null | undefined): string {
  const knowledge = readClientKnowledge(context);
  const rendered = knowledge ? renderClientKnowledge(knowledge) : '';
  return rendered ? `${systemPrompt}\n\n${rendered}` : systemPrompt;
}

function isEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.title === 'string' && typeof e.content === 'string';
}

function isWorkflow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.name === 'string' &&
    typeof w.trigger === 'string' &&
    Array.isArray(w.steps) &&
    w.steps.every((s) => typeof s === 'string')
  );
}
