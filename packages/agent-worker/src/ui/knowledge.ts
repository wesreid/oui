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
 */
import type { ResolvedKnowledge } from '@ouispec/bindings';

/** The context key a UI client uses for its knowledge. */
export const CLIENT_KNOWLEDGE_KEY = 'uiKnowledge';

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

/** The knowledge as a prompt section: every entry, then every workflow with its numbered steps. */
export function renderClientKnowledge(knowledge: ClientKnowledge): string {
  const sections: string[] = [];
  if (knowledge.entries.length > 0) {
    sections.push(
      '## Platform Knowledge (Context-Aware)\n\n' + knowledge.entries.map((e) => `### ${e.title}\n${e.content}`).join('\n\n'),
    );
  }
  if (knowledge.workflows.length > 0) {
    sections.push(
      '## Active Workflows\n\n' +
        knowledge.workflows
          .map((w) => `### ${w.name}\nTrigger: ${w.trigger}\nSteps:\n${w.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
          .join('\n\n'),
    );
  }
  return sections.join('\n\n');
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
