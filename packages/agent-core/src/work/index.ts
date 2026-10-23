/**
 * The assistant's work as a person reads it: its calls, grouped into runs and
 * named by what each action is called on screen. One definition, read by every
 * view of a turn: the live status a panel or a pill shows, the steps a
 * transcript lists, and a replay of a stored session.
 */
import { displayedToolCall } from '../protocol/index.js';

/** The assistant's own bookkeeping and reading of the page: never shown as work. */
export const AGENT_HIDDEN_WORK_TOOLS: readonly string[] = ['note', 'ui_describe', 'ui_read', 'ui_guide'];

/** Tools that put a choice card in front of the person: a card, not work. */
export const AGENT_CHOICE_TOOLS: readonly string[] = ['present_options', 'confirm_action', 'request_user_decision'];

/** One kind of action in a run of the assistant's work, and how many times it was taken. */
export interface AgentWorkStep {
  label: string;
  count: number;
}

/** A message of a conversation, as far as its work is concerned. */
export interface AgentWorkMessage {
  role: string;
  content?: unknown;
  toolCall?: { name: string; arguments?: Record<string, unknown>; status?: string };
}

/** Work done without a word or a card in between: its steps, in the order each label first appeared. */
export interface AgentWorkRun {
  /** Index of the run's first call in the messages it was read from. */
  from: number;
  /** Index of its last call. */
  to: number;
  steps: AgentWorkStep[];
  /** The step its last call belongs to. */
  last: AgentWorkStep;
}

export interface AgentWorkOptions {
  /** A tool's name → what its action is called on screen: `vector_studio_add_shape` → "Draw a shape". */
  toolLabels?: Readonly<Record<string, string>>;
  /** Tools never shown as work. Default `AGENT_HIDDEN_WORK_TOOLS`. */
  hiddenTools?: readonly string[];
}

/** Words that name what a tool does, for a name that ends in its verb (`vector_studio_appearance_set`). */
const VERBS = new Set([
  'add', 'align', 'animate', 'apply', 'close', 'copy', 'create', 'delete', 'describe', 'draw', 'duplicate', 'ease',
  'export', 'find', 'group', 'guide', 'import', 'inspect', 'list', 'make', 'move', 'new', 'open', 'paste', 'play',
  'query', 'read', 'remove', 'rename', 'resize', 'rotate', 'save', 'scale', 'select', 'set', 'snapshot', 'stop',
  'ungroup', 'update',
]);

/**
 * What a tool without a label is called on screen, from its name: the room's
 * prefix dropped (the first two words of a longer name, the first of a
 * two-word one, never a verb), and the verb first.
 * `vector_studio_set_keyframe` → "Set keyframe", `vector_studio_rename` →
 * "Rename", `vector_studio_version_save` → "Save version",
 * `ui_describe` → "Describe".
 */
export function humanizeToolName(name: string): string {
  const words = name.split(/[_\-.\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0) return name;
  const prefixMax = words.length >= 3 ? 2 : words.length - 1;
  let start = 0;
  while (start < prefixMax && !VERBS.has(words[start])) start++;
  let kept = words.slice(start);
  if (kept.length === 2 && !VERBS.has(kept[0]) && VERBS.has(kept[1])) kept = [kept[1], kept[0]];
  const phrase = kept.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** What a step of work reads as: "Draw a shape · 12", or the label alone for one action. */
export function formatWorkStep(step: AgentWorkStep): string {
  return step.count > 1 ? `${step.label} · ${step.count}` : step.label;
}

/**
 * The label a call is shown as, or null when it is not work: bookkeeping,
 * reading the page, a choice card, or an action that failed and so changed
 * nothing. An `act` call is the action it ran.
 */
export function workLabel(
  call: { name: string; arguments?: Record<string, unknown>; status?: string },
  options: AgentWorkOptions = {},
): string | null {
  if (call.status === 'error') return null;
  const { name } = displayedToolCall(call);
  if (AGENT_CHOICE_TOOLS.includes(name)) return null;
  if ((options.hiddenTools ?? AGENT_HIDDEN_WORK_TOOLS).includes(name)) return null;
  return options.toolLabels?.[name] ?? humanizeToolName(name);
}

/** Whether a message says something: text of its own, not only a call. */
export function hasWords(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (part) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' && (part as { text: string }).text.trim().length > 0,
    );
  }
  return false;
}

/**
 * The runs of work in `messages`: calls taken without the person or the
 * assistant saying anything, or a card being offered, in between. Within a run
 * the calls are counted by label. Calls that are not work (`workLabel`) neither
 * count nor end a run.
 */
export function agentWorkRuns(messages: readonly AgentWorkMessage[], options: AgentWorkOptions = {}): AgentWorkRun[] {
  const runs: AgentWorkRun[] = [];
  let run: AgentWorkRun | null = null;
  messages.forEach((message, i) => {
    const call = message.toolCall;
    const name = call ? displayedToolCall(call).name : null;
    const breaks =
      (message.role === 'user' && !call) || hasWords(message.content) || (name !== null && AGENT_CHOICE_TOOLS.includes(name));
    if (breaks) run = null;
    if (!call) return;
    const label = workLabel(call, options);
    if (label === null) return;
    if (!run) {
      run = { from: i, to: i, steps: [], last: { label, count: 0 } };
      runs.push(run);
    }
    const current: AgentWorkRun = run;
    let step = current.steps.find((s) => s.label === label);
    if (!step) {
      step = { label, count: 0 };
      current.steps.push(step);
    }
    step.count += 1;
    current.to = i;
    current.last = step;
  });
  return runs;
}

/**
 * What the assistant is doing now, as one line: the step of its latest call,
 * when that call is the last thing the turn has done (no words or card since).
 * `messages` are the turn's own, from the person's message on.
 */
export function currentWorkStep(messages: readonly AgentWorkMessage[], options: AgentWorkOptions = {}): AgentWorkStep | null {
  const runs = agentWorkRuns(messages, options);
  const last = runs.at(-1);
  if (!last) return null;
  for (let i = last.to + 1; i < messages.length; i++) {
    const m = messages[i];
    if ((m.role === 'user' && !m.toolCall) || hasWords(m.content)) return null;
    if (m.toolCall && AGENT_CHOICE_TOOLS.includes(displayedToolCall(m.toolCall).name)) return null;
  }
  return last.last;
}
