/**
 * UI tools: one tool per action of every surface the client has mounted.
 *
 * Calling one sends an OUI action request to the client that sent the turn
 * and waits for its answer (ADR-0209 D2). The model gets what really happened
 * — the action's result or error — and what the page offers afterwards.
 */
import type { OUIAction, OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import type { UIActionChannel } from './channel.js';
import { boundObservations } from './observations.js';
import { createUISequence, type UISequence } from './ui-sequence.js';

export interface UIToolDependencies {
  channel: UIActionChannel;
  /** How long to wait for the client's answer. */
  resultTimeoutMs: number;
  /** The surfaces the model's current tools were built from. */
  currentSurfaces(): readonly OUISurface[];
  /** Called with every answer, before the model sees it. */
  onResult(result: OUIActionResult): void;
  /** Largest observation payload returned to the model, in characters. */
  maxObservationChars?: number;
  /**
   * When the turn must stop waiting for work an action started, so the model
   * still has time to answer: epoch ms. An action that is still running then is
   * reported as running, never as done. Unbounded when not given.
   */
  waitDeadline?: () => number;
  /**
   * The turn's UI action queue, shared by every set of UI tools built during the
   * turn, so the actions run one at a time in the order they were called. A new
   * one is made for these tools when none is given.
   */
  sequence?: UISequence;
}

export interface UIToolCollision {
  actionId: string;
  keptSurface: string;
  droppedSurface: string;
}

const DEFAULT_MAX_OBSERVATION_CHARS = 6_000;
/**
 * When to send a request again while no tab has received it (dispatchUntilAnswered):
 * after 1 s, then 2, 4, and every 8 s.
 */
export const FIRST_RESEND_AFTER_MS = 1_000;
export const MAX_RESEND_AFTER_MS = 8_000;
/**
 * When to send a request a tab received again, if its answer has not come: by
 * then longer than the tab waits before answering a repeat (oui-spec's
 * `reanswerAfterMs`, 8 s), so the repeat recovers an answer that was lost.
 */
export const RECEIVED_RESEND_AFTER_MS = 10_000;
/** How long to wait for an async action's outcome when it declares no limit of its own. */
export const DEFAULT_JOB_WAIT_MS = 5 * 60_000;

/** Build the UI tools for a set of surfaces. The first surface to declare an action id keeps it. */
export function buildUITools(
  surfaces: readonly OUISurface[],
  deps: UIToolDependencies,
): { tools: RegisteredTool[]; collisions: UIToolCollision[] } {
  const tools: RegisteredTool[] = [];
  const owner = new Map<string, string>();
  const collisions: UIToolCollision[] = [];
  const sequence = deps.sequence ?? createUISequence();

  for (const surface of surfaces) {
    for (const action of surface.actions) {
      const kept = owner.get(action.id);
      if (kept !== undefined) {
        collisions.push({ actionId: action.id, keptSurface: kept, droppedSurface: surface.id });
        continue;
      }
      owner.set(action.id, surface.id);
      tools.push(uiTool(surface, action, deps, sequence));
    }
  }
  return { tools, collisions };
}

function uiTool(
  surface: OUISurface,
  action: OUIAction,
  deps: UIToolDependencies,
  sequence: UISequence,
): RegisteredTool {
  return {
    name: action.id,
    kind: 'ui',
    description: describe(surface, action),
    inputSchema: (action.input ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    // The approval card's words and whether a call needs approval come from
    // the declaration (ADR-0228 §2.1–2.2). `confirm` marks a destructive
    // action, or one that changes what the person works in: either asks.
    ...(action.title ? { title: action.title } : { title: action.description }),
    consequence: action.description,
    ...(action.effect !== undefined ? { effect: action.effect } : {}),
    ...(action.confirm ? { destructive: true } : {}),
    execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      // In the place the orchestrator took when the model's call arrived, or,
      // called directly, in a place taken now (ui-sequence.ts).
      const slot = ctx.uiSlot ?? sequence.reserve();
      return slot.run(() => runAction(surface, action, deps, sequence, input, ctx));
    },
  };
}

async function runAction(
  surface: OUISurface,
  action: OUIAction,
  deps: UIToolDependencies,
  sequence: UISequence,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const requestId = ctx.toolCallId;
  const room = ctx.socketRoom;
  if (!requestId || !room) {
    throw new Error(`[agent-sdk] UI tool ${action.id} needs the tool call id and the turn's room`);
  }

  // The page as the actions before this one left it.
  const before = sequence.latestSurfaces() ?? deps.currentSurfaces();

  // The surfaces the worker holds, so the answer repeats them only if they changed (oui-spec §7.3.4).
  const knownSurfaces = sequence.knownHash();
  const request: OUIActionRequest = {
    requestId,
    surfaceId: surface.id,
    actionId: action.id,
    params: input,
    timestamp: Date.now(),
    ...(ctx.approval ? { approval: ctx.approval } : {}),
    ...(knownSurfaces ? { knownSurfaces } : {}),
  };
  const answered = await dispatchUntilAnswered(deps, room, request, ctx);

  if (!answered.result) {
    const within = `within ${Math.round(deps.resultTimeoutMs / 1000)}s`;
    const sent = `${answered.sends} time${answered.sends === 1 ? '' : 's'}`;
    return {
      success: false,
      error:
        (answered.received
          ? `The page received "${action.id}" but its answer did not arrive ${within} (the request was sent ${sent}). ` +
            'It may have run: check what the page shows before trying again.'
          : answered.receipts
            ? `No open page received "${action.id}" ${within} (sent ${sent}): the person's page may be closed or offline. ` +
              'It did not run there. Tell the user the page is not responding.'
            : `The page did not answer "${action.id}" ${within}, though the request was sent to it ${sent}. ` +
              'It may or may not have run: check what the page shows before trying again, and tell the user if it is not responding.'),
    };
  }

  const result = withSurfaces(answered.result, sequence);
  deps.onResult(result);

  // Work that outlives the call (a GPU job, an export) was only started: wait
  // for its outcome, so the model tells the person it is done only once it is.
  const final = result.success && result.interim ? await awaitOutcome(action, deps, requestId, ctx) : null;
  const outcome = final && final !== 'running' ? withSurfaces(final, sequence) : final;
  if (outcome && outcome !== 'running') deps.onResult(outcome);
  const answer = outcome && outcome !== 'running' ? outcome : result;
  const data = {
    ...forModel(answer, before, deps.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS, surface.id),
    ...(outcome === 'running' ? { status: 'running', note: stillRunningNote(action) } : {}),
  };
  return answer.success
    ? { success: true, data }
    : { success: false, data, error: answer.error?.message ?? `"${action.id}" failed` };
}

/**
 * Send the request to the turn's room, and send it again only while it may not
 * have reached the page (oui-spec §7.3.7).
 *
 * A room delivers only to the sockets in it when the event is sent. The tab
 * joins the turn's room once it learns the room from the send-message answer,
 * while the worker may already be running the turn: the turn after an
 * approval runs its approved call at once, before any model round, and the
 * first send can reach nobody. So while no tab has received the request it is
 * sent again, backing off (1, 2, 4, then every 8 s).
 *
 * Once a tab has received it (the realtime service's receipts), its answer is
 * waited for, not asked for again: on dev (2026-10-02 09:11Z) a fixed 2 s
 * re-send made the tab answer every copy, the copies of a large answer queued
 * on its one socket, and the next request's answer missed its window though
 * its action had run. It is sent again only after RECEIVED_RESEND_AFTER_MS of
 * silence, in case the answer was lost; the tab then answers the repeat once.
 */
async function dispatchUntilAnswered(
  deps: UIToolDependencies,
  room: string,
  request: OUIActionRequest,
  ctx: ToolExecutionContext,
): Promise<{ result: OUIActionResult | null; sends: number; received: boolean; receipts: boolean }> {
  const deadline = Date.now() + deps.resultTimeoutMs;
  let sends = 0;
  let received = false;
  let receipts = false;
  let backoff = FIRST_RESEND_AFTER_MS;
  for (;;) {
    const receipt = await deps.channel.dispatch(room, request);
    sends++;
    if (receipt) {
      receipts = true;
      if (receipt.accepted > 0) received = true;
    }
    const left = deadline - Date.now();
    const wait = received ? RECEIVED_RESEND_AFTER_MS : backoff;
    const result = await deps.channel.awaitResult(request.requestId, {
      userId: ctx.userId,
      timeoutMs: Math.max(0, Math.min(wait, left)),
      signal: ctx.abortSignal,
    });
    if (result || Date.now() >= deadline || ctx.abortSignal?.aborted) return { result, sends, received, receipts };
    if (!received) backoff = Math.min(backoff * 2, MAX_RESEND_AFTER_MS);
  }
}

/**
 * An answer with the surfaces it stands for: those it carries, or those the
 * worker holds under the hash it reports (an answer repeats surfaces only when
 * they changed). Recorded as the page's surfaces from now on.
 */
function withSurfaces(result: OUIActionResult, sequence: UISequence): OUIActionResult {
  const surfaces = sequence.resolve(result);
  sequence.record(surfaces, result.surfacesHash);
  return surfaces && !result.surfaces ? { ...result, surfaces } : result;
}

/**
 * The final answer to a started action: its outcome once the work is done or
 * has failed, or `'running'` when it has not finished by its own limit (its
 * polling's `maxDurationMs`) or by when the turn must stop waiting.
 */
async function awaitOutcome(
  action: OUIAction,
  deps: UIToolDependencies,
  requestId: string,
  ctx: ToolExecutionContext,
): Promise<OUIActionResult | 'running'> {
  const until = Math.min(
    Date.now() + (action.polling?.maxDurationMs ?? DEFAULT_JOB_WAIT_MS),
    deps.waitDeadline?.() ?? Infinity,
  );
  const timeoutMs = until - Date.now();
  if (timeoutMs <= 0) return 'running';
  const final = await deps.channel.awaitResult(requestId, {
    userId: ctx.userId,
    timeoutMs,
    signal: ctx.abortSignal,
    final: true,
  });
  // No answer in time, or a relay that only keeps first answers handing back the acknowledgment.
  if (!final || final.interim) return 'running';
  return final;
}

function stillRunningNote(action: OUIAction): string {
  return (
    `"${action.id}" started and has not finished yet, so it is not done: tell the person it is still running, ` +
    'never that it is done. Its status and result appear in the page state when it finishes.'
  );
}

function describe(surface: OUISurface, action: OUIAction): string {
  let desc = `[UI · ${surface.name}] ${action.description}`;
  if (action.usage) desc += `\n\nWhen to use: ${action.usage}`;
  if (action.preconditions) desc += `\n\nPreconditions: ${action.preconditions}`;
  if (action.async) {
    desc +=
      '\n\nAsync: waits for the work to finish and returns its outcome; if it is still running when the wait ends, ' +
      'it says so (status "running"), and the outcome appears in the page state when it finishes.';
    if (action.estimatedDuration) desc += ` Estimated duration: ${action.estimatedDuration}.`;
  }
  return desc;
}

/**
 * What the model sees: the outcome, and what the page offers now. Tool changes
 * are named so the model knows the page it is on, not just that something
 * happened.
 */
function forModel(
  result: OUIActionResult,
  before: readonly OUISurface[],
  maxObservationChars: number,
  actingSurfaceId: string,
) {
  const after = result.surfaces ?? before;
  const beforeActions = new Set(before.flatMap((s) => s.actions.map((a) => a.id)));
  const afterActions = new Set(after.flatMap((s) => s.actions.map((a) => a.id)));

  const added = [...afterActions].filter((id) => !beforeActions.has(id));
  const removed = [...beforeActions].filter((id) => !afterActions.has(id));

  return {
    ...(result.data !== undefined ? { result: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.interim ? { status: 'started' } : {}),
    ...(result.settled === false
      ? { note: 'The page was still loading when this was reported; what it offers may still change.' }
      : {}),
    ...(result.delivery?.trimmed ? { delivery: deliveryNote(result.delivery) } : {}),
    page: {
      surfaces: after.map((s) => s.name),
      ...(added.length ? { toolsAdded: added } : {}),
      ...(removed.length ? { toolsRemoved: removed } : {}),
    },
    ...(result.observations && Object.keys(result.observations).length
      ? { state: boundObservations(result.observations, maxObservationChars, actingSurfaceId) }
      : {}),
  };
}



/**
 * What the model is told about an answer the tab had to trim to deliver
 * (oui-spec §7.3.6): the outcome is what happened, and what it lacks.
 */
function deliveryNote(delivery: NonNullable<OUIActionResult['delivery']>): string {
  const lacks = delivery.omitted.map((field) => (field === 'data' ? 'what the action returned' : `the page's ${field}`));
  return (
    `The page ran this, and its outcome here is what happened, but its full answer was refused on the way ` +
    `(${delivery.reason}), so it came without ${lacks.join(', ')}. ` +
    "Don't assume what the page shows: read its state from the next action's answer before relying on it."
  );
}
