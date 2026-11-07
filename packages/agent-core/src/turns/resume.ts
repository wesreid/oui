/**
 * Resuming after work: the turn a tab starts by itself when work the assistant
 * started (a job, an export) finished after the turn that started it had
 * ended, so the assistant reports the outcome in the same chat.
 *
 * The tab's OUI runtime says when such work has ended and the realtime server
 * holds its final answer (`OUISettledWork`, oui-spec's `runtime.onSettled`).
 * The agent provider decides whether to resume (agent-react), and sends a turn
 * with no message that names the requests (`ResumeContinuation`). The worker
 * reads each request's final answer from the realtime server and gives it to
 * the model as the later result of the call that started the work.
 */
import type { OUISettledWork } from 'oui-spec/spec';

/**
 * Work an action started has ended and its final answer was received:
 * oui-spec's own type, told by `runtime.onSettled`.
 */
export type SettledWork = OUISettledWork;

/** The most requests one resumed turn names. */
export const RESUME_MAX_REQUESTS = 8;

/** The longest request id a resumed turn names: the realtime server keeps no longer one. */
export const RESUME_REQUEST_ID_MAX_CHARS = 200;

/**
 * The most turns a tab starts by itself in a row, before the person writes
 * again. A resumed turn may start more work, which may end after it too: that
 * is legitimate, and bounded.
 */
export const RESUME_MAX_IN_A_ROW = 3;

/**
 * How long a tab waits after work ends for more to end before it resumes:
 * work that ends within this of the last is reported in the same turn.
 */
export const RESUME_GATHER_MS = 1_500;

/**
 * What a resumed turn carries, on the message request the client sends
 * (`AgentClientConfig.sendMessage`) and on the turn payload the platform hands
 * the worker (`resume`): the requests whose work ended after the turn that
 * started it, 1 to `RESUME_MAX_REQUESTS` of them. A request id is the id of the
 * tool call that ran the action. The turn's `content` is empty: nobody wrote
 * anything, so no message of the person's is stored for it.
 */
export interface ResumeContinuation {
  requestIds: string[];
}

/** Why a value is not a resume continuation, or null when it is one. */
export function resumeRefusal(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'resume must be an object with requestIds';
  const ids = (value as { requestIds?: unknown }).requestIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RESUME_MAX_REQUESTS) {
    return `resume.requestIds must list 1 to ${RESUME_MAX_REQUESTS} request ids`;
  }
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= RESUME_REQUEST_ID_MAX_CHARS)) {
    return `each of resume.requestIds must be a non-empty string of at most ${RESUME_REQUEST_ID_MAX_CHARS} characters`;
  }
  return null;
}

/**
 * Where a tab's work comes from: what it subscribes to for each settlement.
 * Wire it to the tab's OUI runtime: `{ subscribe: (listener) => runtime.onSettled(listener) }`.
 */
export interface SettledWorkSource {
  /** Calls `listener` for each settlement from now on; returns the function that stops it. */
  subscribe(listener: (work: SettledWork) => void): () => void;
}
