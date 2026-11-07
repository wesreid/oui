/**
 * A turn resumed after work: the person's tab started it by itself because
 * work the assistant started in an earlier turn (a job, an export) finished
 * after that turn had ended (the turn payload's `resume`, agent-core
 * `ResumeContinuation`).
 *
 * The tab names the requests whose work ended. Each is the id of the tool call
 * that ran the action (a UI action's request id is its call's id), so a
 * request is taken only when this conversation's history holds that call: a
 * client never reads another conversation's results. The orchestrator then
 * reads each one's final answer from the realtime server and gives it to the
 * model as the call's later result, in place of "still running", stored under
 * the call's own id so later turns read the outcome too.
 */
import { AGENT_UI_TOOLS } from '@ouispec/agent-core';
import type { TurnHistoryMessage } from '../types.js';

/**
 * How long a resumed turn waits for a request's final answer. The tab resumes
 * only once the realtime server has acknowledged it, so it is there already;
 * the wait covers a read that races the store.
 */
export const RESUME_READ_WAIT_MS = 3_000;

/** A call of the conversation whose work ended after its turn. */
export interface ResumedCall {
  /** The request the tab named: the id the call's final answer is kept under. */
  requestId: string;
  /**
   * The call's id in the history: the request's own, or, for an approved call
   * that followed the person's decision as a call of its own,
   * `{requestId}-approved`.
   */
  callId: string;
  /** The tool its result is stored under: `ui_act` for an action of the page. */
  name: string;
  /** The action the call ran. */
  actionId: string;
  /** The job's id, as the call's answer gave it, when it gave one. */
  jobId?: string;
  /** The approval the call ran on, as its result says it, kept on its later result. */
  approval?: unknown;
}

/** Why a request a resumed turn named is left out. */
export type ResumeIgnoredReason =
  /** No call of this conversation has its id. */
  | 'not_in_history'
  /** Its call's latest result is already its outcome, not "still running". */
  | 'already_reported';

/** What a resumed turn did with the requests it named: in its logs, its usage, and `recordTurnComplete`. */
export interface ResumedTurn {
  /** The requests the tab named, in its order. */
  requestIds: string[];
  /** Those whose outcome the model was given as their call's later result. */
  reported: string[];
  /** Those whose final answer could not be read (no longer kept, or never received). */
  unreadable: string[];
  /** Those left out, and why. */
  ignored: Array<{ requestId: string; reason: ResumeIgnoredReason }>;
}

/** A tool call as the history stores it: its name and its arguments, parsed. */
export function storedToolCall(tc: { id: string; function?: { name: string; arguments: string | Record<string, unknown> } }): {
  name: string;
  args: Record<string, unknown>;
} {
  const flat = tc as unknown as { name?: string; arguments?: unknown };
  const name = tc.function && typeof tc.function === 'object' ? tc.function.name : (flat.name ?? 'unknown');
  const raw = tc.function && typeof tc.function === 'object' ? tc.function.arguments : flat.arguments;
  let args: Record<string, unknown> = {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the call is read with no arguments.
  }
  return { name, args };
}

/** The JSON object a stored result holds, or null when it holds none. */
function storedObject(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The calls of `history` the requests name, each once, and the requests left
 * out with why. A call is taken while its latest stored result says its work
 * is still running (or it has none stored): one whose outcome is already in
 * the conversation is not reported again.
 */
export function resumedCalls(
  history: readonly TurnHistoryMessage[],
  requestIds: readonly string[],
): { calls: ResumedCall[]; ignored: ResumedTurn['ignored'] } {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const latest = new Map<string, string>();
  for (const m of history) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) calls.set(tc.id, storedToolCall(tc));
    else if (m.role === 'tool' && m.tool_call_id) latest.set(m.tool_call_id, m.content);
  }
  const found: ResumedCall[] = [];
  const ignored: ResumedTurn['ignored'] = [];
  for (const requestId of new Set(requestIds)) {
    const callId = calls.has(requestId) ? requestId : calls.has(`${requestId}-approved`) ? `${requestId}-approved` : null;
    if (!callId) {
      ignored.push({ requestId, reason: 'not_in_history' });
      continue;
    }
    const stored = storedObject(latest.get(callId));
    if (latest.has(callId) && stored?.status !== 'running') {
      ignored.push({ requestId, reason: 'already_reported' });
      continue;
    }
    const call = calls.get(callId)!;
    const action = call.name === AGENT_UI_TOOLS.act && typeof call.args.action === 'string' && call.args.action ? call.args.action : call.name;
    const jobId = (stored?.result as { jobId?: unknown } | undefined)?.jobId ?? stored?.jobId;
    found.push({
      requestId,
      callId,
      name: call.name,
      actionId: action,
      ...(typeof jobId === 'string' && jobId ? { jobId } : {}),
      ...(stored?.approval !== undefined ? { approval: stored.approval } : {}),
    });
  }
  return { calls: found, ignored };
}

/** The note that opens a resumed turn's model input, said as the turn's message. */
export const resumedNote = (text: string) => `<resumed>${text}</resumed>`;

/**
 * What the model is told a resumed turn is, in place of a message: nobody
 * wrote; work it started in an earlier turn finished after that turn ended;
 * each outcome is now its call's result; tell the person what came of it, in
 * plain words, after checking the page; go on if their request needed it.
 * Work is named by its declared title (`titleOf`) where the page gives one.
 */
export function resumeNote(
  reported: ReadonlyArray<Pick<ResumedCall, 'actionId'>>,
  unreadable: ReadonlyArray<Pick<ResumedCall, 'actionId'>>,
  titleOf: (actionId: string) => string | undefined,
): string {
  const named = (calls: ReadonlyArray<Pick<ResumedCall, 'actionId'>>) =>
    calls
      .map(({ actionId }) => {
        const title = titleOf(actionId);
        return title ? `"${title}" (${actionId})` : `"${actionId}"`;
      })
      .join(', ');
  const all = [...reported, ...unreadable];
  const one = all.length === 1;
  const parts = [
    `Nobody wrote anything: this turn started by itself because work you started in an earlier turn of this conversation ` +
      `finished after that turn had ended: ${named(all)}.`,
  ];
  if (reported.length > 0) {
    parts.push(
      reported.length === 1 && one
        ? 'Its outcome is now the result of the call that started it, above, in place of "still running".'
        : `The outcome of ${named(reported)} is now the result of the call that started ${reported.length === 1 ? 'it' : 'each'}, above, in place of "still running".`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `The outcome of ${named(unreadable)} could not be read (it is no longer kept, or never arrived): ` +
        'check what the page shows before you say anything about it, and say plainly if you cannot tell.',
    );
  }
  parts.push(
    `Tell the person in this chat, briefly and in plain words, what came of ${one ? 'it' : 'each'}: check what the page shows ` +
      'before you claim anything, and never claim more than the result and the page show. Speak of the work by what it does, ' +
      'not by its id. If their earlier request needed this outcome to go on, go on with it.',
  );
  return resumedNote(parts.join(' '));
}
