/**
 * UI tools: the page's actions as the worker runs them.
 *
 * The page sends an index of what it offers. Each action of the index is a
 * tool here, run by sending an OUI action request to the client that sent the
 * turn and waiting for its answer: the model gets what really
 * happened — the action's result or error — and what the page offers and shows
 * afterwards. An action's definition is fetched from the page when it is
 * needed (`oui.describe`), and what did not fit an answer is read from it
 * (`oui.read`).
 *
 * The model is not given one tool per action: it is given the index, and four
 * tools to work it with (`ui_act`, `ui_describe`, `ui_read`, `ui_wait`). The per-action
 * tools built here are what `ui_act` runs, so every check a tool call goes
 * through — input, quota, policy, approval — sees the action itself.
 */
import { stoppedBeforeAnswer, stoppedNotRun, stoppedNotTaken, stoppedOutcomeUnknown, stoppedWhileWaiting } from '../stop/results.js';
import { randomUUID } from 'node:crypto';
import { AGENT_UI_TOOLS } from '@ouispec/agent-core';
import {
  jsonBytes,
  OUI_DESCRIBE_ACTION,
  OUI_READ_ACTION,
  OUI_RUNTIME_SURFACE,
  type OUIAction,
  type OUIActionIndexEntry,
  type OUIActionRequest,
  type OUIActionResult,
  type OUIFit,
} from 'oui-spec/spec';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import type { UIActionChannel } from './channel.js';
import { boundObservations, DEFAULT_PAGE_STATE_CHARS, observationSchemas } from './observations.js';
import { answerCutNotes, DEFAULT_ANSWER_DATA_CHARS, fitAnswerData } from './answer-fit.js';
import { describeSchema } from './outline.js';
import {
  definitionKey,
  indexDiff,
  indexText,
  isFullSurface,
  isSurfaceIndex,
  pageActions,
  pageFromIndex,
  pageFromSurfaces,
  type HeldDefinitions,
  type PageAction,
  type PageSurface,
} from './page-index.js';
import { liftAnswerImage } from './answer-image.js';
import { createUISequence, type UISequence } from './ui-sequence.js';

/** The tool that runs one action of the page. Built by the orchestrator, which unwraps it to the action's own tool. */
export const UI_ACT_TOOL = AGENT_UI_TOOLS.act;
/** The tool that says what actions take. */
export const UI_DESCRIBE_TOOL = AGENT_UI_TOOLS.describe;
/** The tool that reads part of the page's state. */
export const UI_READ_TOOL = AGENT_UI_TOOLS.read;
/** The tool that waits for work an action started that was still running when its call answered. */
export const UI_WAIT_TOOL = AGENT_UI_TOOLS.wait;

/**
 * Work an action of this turn started that was still running when its call
 * answered: what `ui_wait` waits for. Kept by the call's request id, whose
 * final answer the page sends once the work has ended.
 */
export interface RunningWork {
  action: PageAction;
  requestId: string;
  /** The job's id, as the call's answer gave it, when it gave one. */
  jobId?: string;
  /** When the action was sent: its own limit runs from then. */
  startedAt: number;
}

/** The turn's running work, by request id, in the order it started. */
export type RunningWorkLog = Map<string, RunningWork>;

/**
 * Whether the worker can see the page. It cannot after an
 * answer that came without the page's state, or no answer at all; a read that
 * succeeds restores it. While it cannot, nothing that changes the page runs:
 * a change is refused, and after two refused in a row the turn's UI work is
 * over, so the model says what it could not confirm instead of trying again.
 */
export interface PageSight {
  /** Why the page cannot be seen, or null when it can. */
  blind(): string | null;
  lost(why: string): void;
  seen(): void;
  /**
   * Called for a call that would change the page: null when it may run, or
   * why it may not. Each refusal is counted; the second in a row stops the
   * turn's UI work for good.
   */
  refuseChange(): { error: string; stopped: boolean } | null;
  /** How many changes were refused this turn. */
  refusals(): number;
  /** Whether the turn's UI work was stopped. */
  stopped(): boolean;
}

/** After this many changes refused in a row, the turn changes nothing more in the page. */
export const BLIND_REFUSALS_BEFORE_STOP = 2;

export function createPageSight(): PageSight {
  let why: string | null = null;
  let inARow = 0;
  let total = 0;
  let stopped = false;
  const STOPPED =
    'Not run: the page still cannot be seen, so nothing more is changed in it this turn. ' +
    'Tell the user plainly what you did, what you could not confirm, and what they can check on their screen.';
  return {
    blind: () => why,
    lost: (reason) => {
      why = reason;
    },
    seen: () => {
      why = null;
      inARow = 0;
    },
    refuseChange() {
      if (stopped) {
        total++;
        return { error: STOPPED, stopped: true };
      }
      if (!why) return null;
      inARow++;
      total++;
      if (inARow >= BLIND_REFUSALS_BEFORE_STOP) stopped = true;
      return {
        error:
          `Not run: you cannot see the page (${why}). Read it first, with ${AGENT_UI_TOOLS.read} or an action that only reads; ` +
          'then run this again if it is still needed. Never change the page to find out what it shows.',
        stopped: false,
      };
    },
    refusals: () => total,
    stopped: () => stopped,
  };
}

type UILog = (level: 'info' | 'warn', message: string, data: Record<string, unknown>) => void;

export interface UIToolDependencies {
  channel: UIActionChannel;
  /** How long to wait for the client's answer. */
  resultTimeoutMs: number;
  /** What the page offers now, as the turn knows it. */
  currentPage(): readonly PageSurface[];
  /** Called with every answer, and the page it stands for when that is known, before the model sees it. */
  onResult(result: OUIActionResult, page: readonly PageSurface[] | undefined): void;
  /** Largest observation payload returned to the model, in characters. */
  maxObservationChars?: number;
  /** How much of an action's result the model is given, in characters of JSON. Default 24,000 (answer-fit.ts). */
  maxAnswerDataChars?: number;
  /**
   * When the turn must stop waiting for work an action started, so the model
   * still has time to answer: epoch ms. An action that is still running then is
   * reported as running, never as done. Unbounded when not given.
   */
  waitDeadline?: () => number;
  /**
   * The longest a call waits for the outcome of work its action started, in ms;
   * `DEFAULT_JOB_WAIT_MS` when not given. Never longer than the action's own
   * limit or `waitDeadline`.
   */
  jobWaitMs?: number;
  /**
   * The turn's UI action queue, shared by every set of UI tools built during the
   * turn, so the actions run one at a time in the order they were called. A new
   * one is made for these tools when none is given.
   */
  sequence?: UISequence;
  /** The definitions the turn already holds, added to as they are fetched. */
  held?: HeldDefinitions;
  /**
   * The work the turn's actions started that was still running when their
   * calls answered, shared by every set of UI tools built during the turn, so
   * `ui_wait` finds work started before the page last changed.
   */
  running?: RunningWorkLog;
  /** Whether the page can be seen, shared by the turn. */
  sight?: PageSight;
  /** Where each answer's size is reported. */
  log?: UILog;
}

export interface UIToolCollision {
  actionId: string;
  keptSurface: string;
  droppedSurface: string;
}

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
/**
 * The longest a UI tool waits, in the call, for the outcome of work an action
 * started (a GPU job, an export): `UIToolDependencies.jobWaitMs` by default.
 *
 * Work that ends within it is reported done in the call. Work that does not is
 * reported still running, and the turn goes on and ends (or waits for it with
 * `ui_wait`): when it ends after the turn, the person's tab resumes the
 * conversation with a turn that reports it (orchestrator.ts `resume`), and
 * otherwise its outcome reaches the conversation through the page state, where
 * the app's job tracker lists it, in the next turn. The call never waits on the action's own limit (its
 * `maxDurationMs`), which can be many minutes for a job queued behind a live
 * conversation: a turn held open that long could not be stopped or answered.
 */
export const DEFAULT_JOB_WAIT_MS = 20_000;
/** The most actions one `ui_describe` call describes. */
export const MAX_DESCRIBED_ACTIONS = 8;

interface Shared {
  deps: UIToolDependencies;
  sequence: UISequence;
  held: HeldDefinitions;
  sight: PageSight;
  running: RunningWorkLog;
}

/**
 * Build the UI tools for a page: one per action, which `ui_act` runs, and the
 * three the model calls itself to learn what actions take, to read the page,
 * and to wait for work an action started. The first surface to offer an
 * action id keeps it.
 */
export function buildUITools(
  page: readonly PageSurface[],
  deps: UIToolDependencies,
): { tools: RegisteredTool[]; collisions: UIToolCollision[]; describe: RegisteredTool; read: RegisteredTool; wait: RegisteredTool } {
  const shared: Shared = {
    deps,
    sequence: deps.sequence ?? createUISequence(),
    held: deps.held ?? new Map(),
    sight: deps.sight ?? createPageSight(),
    running: deps.running ?? new Map(),
  };
  const { actions, collisions } = pageActions(page);
  return {
    tools: actions.map((action) => actionTool(action, shared)),
    collisions,
    describe: describeTool(shared),
    read: readTool(shared),
    wait: waitTool(shared),
  };
}

/** The tool for one action of the page: what `ui_act` runs. */
function actionTool(action: PageAction, shared: Shared): RegisteredTool {
  const { surface, entry } = action;
  const tool: RegisteredTool = {
    name: entry.id,
    kind: 'ui',
    description: `[UI · ${surface.name}] ${entry.description}`,
    // Stands in until the definition is fetched: `resolveInputSchema` puts the
    // real one here, with the action's whole description, so what reads the
    // tool after (the approval card's labels and its words) reads the
    // declaration itself and not its line in the index.
    inputSchema: { type: 'object' },
    resolveInputSchema: async (ctx) => {
      const definition = await definitionOf(action, shared, ctx);
      tool.inputSchema = (definition.input ?? { type: 'object', properties: {} }) as Record<string, unknown>;
      tool.title = definition.title ?? definition.description;
      tool.consequence = definition.description;
      return tool.inputSchema;
    },
    // The approval card's words and whether a call needs approval come from
    // the declaration. `confirm` marks a destructive
    // action, or one that changes what the person works in: either asks.
    title: entry.title ?? entry.description,
    consequence: entry.description,
    ...(entry.effect !== undefined ? { effect: entry.effect } : {}),
    ...(entry.confirm ? { destructive: true } : {}),
    execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      // In the place the orchestrator took when the model's call arrived, or,
      // called directly, in a place taken now (ui-sequence.ts).
      const slot = ctx.uiSlot ?? shared.sequence.reserve();
      return slot.run(async () => {
        // Checked here, in the action's place in the turn's order, and not when
        // the model's call arrived: of two changes called in one response, the
        // first's answer decides whether the second may run.
        // A stopped turn sends nothing more: said first, since why it did not run is the stop.
        if (ctx.stop?.reason()) return stoppedNotRun(entry.id);
        const refusal = entry.effect === 'view' ? null : shared.sight.refuseChange();
        if (refusal) {
          shared.deps.log?.('warn', 'UI action refused: the page cannot be seen', { action: entry.id, stopped: refusal.stopped });
          return {
            success: false,
            error: refusal.error,
            data: { notRun: true, ...(refusal.stopped ? { uiStopped: true } : { blind: true }) },
          };
        }
        return runAction(action, shared, input, ctx);
      });
    },
  };
  return tool;
}

// ─── Definitions ─────────────────────────────────────────────────────────────

/** Thrown when an action's definition cannot be had: the model is told why. */
export class DefinitionUnavailable extends Error {}

/**
 * The definitions of `wanted`, from what the turn holds and, for the rest,
 * from the page (`oui.describe`). An action the page no longer offers is left
 * out of the result.
 */
async function definitionsOf(
  wanted: readonly PageAction[],
  shared: Shared,
  ctx: ToolExecutionContext,
): Promise<Map<PageAction, OUIAction>> {
  const found = new Map<PageAction, OUIAction>();
  let missing = wanted.filter((a) => {
    const held = shared.held.get(definitionKey(a.surface.id, a.entry));
    if (held) found.set(a, held);
    return !held;
  });
  // A frame carries so many definitions; the page defers the rest, which are asked for again.
  for (let round = 0; missing.length > 0 && round < wanted.length; round++) {
    const room = ctx.socketRoom;
    if (!room) throw new Error('[agent-sdk] Describing a UI action needs the turn’s room');
    // A stopped turn asks the page nothing more.
    if (ctx.stop?.reason()) throw new DefinitionUnavailable(stoppedBeforeAnswer('what the action takes').error!);
    const request: OUIActionRequest = {
      requestId: `describe-${randomUUID()}`,
      surfaceId: OUI_RUNTIME_SURFACE,
      actionId: OUI_DESCRIBE_ACTION,
      params: { actions: missing.map((a) => ({ surface: a.surface.id, action: a.entry.id })) },
      timestamp: Date.now(),
      turnId: ctx.turnId,
    };
    const answered = await dispatchUntilAnswered(shared.deps, room, request, ctx);
    if (!answered.result && ctx.stop?.reason()) {
      throw new DefinitionUnavailable(stoppedBeforeAnswer('what the action takes').error!);
    }
    if (!answered.result) {
      // A page that does not answer cannot be seen either: nothing is changed in it until it is read.
      shared.sight.lost('the page is not answering');
      throw new DefinitionUnavailable(
        'The page did not answer when asked what its actions take. It may be closed or offline: tell the user the page is not responding.',
      );
    }
    if (!answered.result.success) {
      throw new DefinitionUnavailable(
        `The page could not say what its actions take: ${answered.result.error?.message ?? 'it gave no reason'}`,
      );
    }
    const data = (answered.result.data ?? {}) as { definitions?: Array<{ surface: string; action: OUIAction }> };
    const before = missing.length;
    for (const { surface, action: definition } of data.definitions ?? []) {
      const asked = missing.find((a) => a.surface.id === surface && a.entry.id === definition.id);
      if (!asked) continue;
      shared.held.set(definitionKey(surface, asked.entry), definition);
      found.set(asked, definition);
    }
    const deferred = new Set(
      ((answered.result.data as { deferred?: Array<{ surface: string; action: string }> })?.deferred ?? []).map(
        (d) => `${d.surface}\u0000${d.action}`,
      ),
    );
    missing = missing.filter((a) => !found.has(a) && deferred.has(`${a.surface.id}\u0000${a.entry.id}`));
    if (missing.length === before) break;
  }
  return found;
}

async function definitionOf(action: PageAction, shared: Shared, ctx: ToolExecutionContext): Promise<OUIAction> {
  const definition = (await definitionsOf([action], shared, ctx)).get(action);
  if (!definition) {
    throw new DefinitionUnavailable(
      `"${action.entry.id}" is no longer on the page. Read the page's index for what it offers now.`,
    );
  }
  return definition;
}

// ─── ui_describe ─────────────────────────────────────────────────────────────

function describeTool(shared: Shared): RegisteredTool {
  return {
    name: UI_DESCRIBE_TOOL,
    kind: 'ui',
    effect: 'view',
    description:
      'Says what actions of the page take: each action’s full description and its input, as a JSON Schema when it is small, ' +
      'or in outline when it is large. An outline names how to open each part: call again with that one action and `path`. ' +
      'A part opened by its path is given whole; a list too long for one answer says how many rows it has and where the next begin (`from`). ' +
      `Describe an action before the first time you use it, unless its line in the index already says everything it takes. Up to ${MAX_DESCRIBED_ACTIONS} actions a call.`,
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_DESCRIBED_ACTIONS,
          description: 'The ids of the actions, as the page’s index gives them.',
        },
        path: {
          type: 'string',
          description:
            'With one action: the part of its input to open, as an outline named it. A property ("style.fill"), ' +
            'a union member ("effect=glow"), a list’s items ("stops.[]").',
        },
        from: {
          type: 'integer',
          minimum: 1,
          description: 'With one action: the row to start at, when an answer said its rows continue ("call again with from: 81").',
        },
      },
      required: ['actions'],
      additionalProperties: false,
      sideEffects: false,
    },
    async execute(input, ctx) {
      const ids = input.actions as string[];
      const path = typeof input.path === 'string' ? input.path : '';
      const from = typeof input.from === 'number' ? input.from : undefined;
      if ((path || from) && ids.length !== 1) {
        return { success: false, error: 'A path or a row to start at reads part of one action’s input: name one action with it.' };
      }
      const offered = new Map(pageActions(shared.deps.currentPage()).actions.map((a) => [a.entry.id, a]));
      const wanted = ids.flatMap((id) => offered.get(id) ?? []);
      const unknown = ids.filter((id) => !offered.has(id));
      let definitions: Map<PageAction, OUIAction>;
      try {
        definitions = await definitionsOf(wanted, shared, ctx);
      } catch (err) {
        if (err instanceof DefinitionUnavailable) return { success: false, error: err.message };
        throw err;
      }
      const described = wanted.flatMap((action) => {
        const definition = definitions.get(action);
        if (!definition) {
          unknown.push(action.entry.id);
          return [];
        }
        const view = describeSchema(definition.input as Record<string, unknown> | undefined, { path, from });
        return [
          {
            action: definition.id,
            ...(definition.title ? { title: definition.title } : {}),
            surface: action.surface.name,
            description: definition.description,
            ...(definition.usage ? { whenToUse: definition.usage } : {}),
            ...(definition.preconditions ? { preconditions: definition.preconditions } : {}),
            ...(definition.effect === 'transaction' || definition.confirm ? { needsApproval: true } : {}),
            ...(definition.async
              ? { waitsForItsWork: definition.estimatedDuration ? `yes, about ${definition.estimatedDuration}` : 'yes' }
              : {}),
            ...('error' in view
              ? { error: view.error }
              : view.whole
                ? { [path ? 'part' : 'input']: JSON.parse(view.text) as unknown }
                : { [path ? 'partOutline' : 'inputOutline']: view.text }),
          },
        ];
      });
      const notOffered = unknown.length
        ? { notOnThePage: unknown, note: 'These are not actions of the page as it is now: read the index for what it offers.' }
        : {};
      return described.length > 0 || unknown.length === 0
        ? { success: true, data: { actions: described, ...notOffered } }
        : { success: false, error: `None of these is an action of the page as it is now: ${unknown.join(', ')}. Read the index for what it offers.` };
    },
  };
}

// ─── ui_read ─────────────────────────────────────────────────────────────────

function readTool(shared: Shared): RegisteredTool {
  return {
    name: UI_READ_TOOL,
    kind: 'ui',
    effect: 'view',
    description:
      'Reads part of the page’s state: an observation of a surface, or the part of it at `path`. For a list it returns ' +
      'rows from `offset`, `limit` at a time, with the total and where the next page begins. Use it for what the page ' +
      'state says was cut or left out, and to see the page again after an answer came without its state. ' +
      'When a surface has its own tools to query or inspect its rows, prefer those: they find rows by what they are.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', description: 'The surface’s id, as the page state gives it.' },
        observation: { type: 'string', description: 'The observation’s id.' },
        path: { type: 'string', description: 'A JSON Pointer into the value ("/lists/rows"). Leave out for the whole value.' },
        offset: { type: 'integer', minimum: 0, description: 'For a list: the first row to return. Default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'For a list: how many rows. Default 50.' },
      },
      required: ['surface', 'observation'],
      additionalProperties: false,
      sideEffects: false,
    },
    execute(input, ctx) {
      const slot = ctx.uiSlot ?? shared.sequence.reserve();
      return slot.run(async () => {
        const room = ctx.socketRoom;
        if (!room) throw new Error('[agent-sdk] Reading the page needs the turn’s room');
        // A stopped turn asks the page nothing more.
        if (ctx.stop?.reason()) return stoppedBeforeAnswer('the read');
        const request: OUIActionRequest = {
          requestId: ctx.toolCallId ?? `read-${randomUUID()}`,
          surfaceId: OUI_RUNTIME_SURFACE,
          actionId: OUI_READ_ACTION,
          params: input,
          timestamp: Date.now(),
          turnId: ctx.turnId,
        };
        const answered = await dispatchUntilAnswered(shared.deps, room, request, ctx);
        if (!answered.result && ctx.stop?.reason()) return stoppedBeforeAnswer('the read');
        if (!answered.result) {
          shared.sight.lost('the page did not answer a read');
          return {
            success: false,
            error: 'The page did not answer. It may be closed or offline: tell the user the page is not responding.',
          };
        }
        const result = answered.result;
        if (!result.success) return { success: false, error: result.error?.message ?? 'The page could not read that.' };
        // The page answered with what it holds: it can be seen again.
        shared.sight.seen();
        return { success: true, data: result.data };
      });
    },
  };
}

// ─── ui_wait ─────────────────────────────────────────────────────────────────

/** The running work a wait names: by its job id, by its action, or the work started last; or why there is none. */
function runningWorkOf(running: RunningWorkLog, input: Record<string, unknown>): RunningWork | string {
  const jobId = typeof input.jobId === 'string' ? input.jobId : '';
  const actionId = typeof input.action === 'string' ? input.action : '';
  const all = [...running.values()];
  const found = jobId
    ? all.find((w) => w.jobId === jobId)
    : actionId
      ? all.filter((w) => w.action.entry.id === actionId).at(-1)
      : all.at(-1);
  if (found) return found;
  const still = all.map((w) => (w.jobId ? `${w.action.entry.id} (job ${w.jobId})` : w.action.entry.id));
  return (
    (jobId || actionId
      ? `Nothing this turn started is still running as ${jobId ? `job "${jobId}"` : `"${actionId}"`}. `
      : 'Nothing this turn started is still running. ') +
    (still.length
      ? `What is: ${still.join(', ')}.`
      : 'Work that ended in its own call was reported there; work started in an earlier turn is in the page state.')
  );
}

/** When a wait for running work ends: its action's own limit, or when the turn must answer, whichever is first. */
function waitEndsAt(work: RunningWork, deps: UIToolDependencies): { at: number; why: 'limit' | 'turn' } {
  const limit = work.startedAt + (work.action.entry.maxDurationMs ?? Infinity);
  // A host that sets no deadline is never held longer than its in-call wait.
  const turn = deps.waitDeadline?.() ?? Date.now() + jobWaitOf(deps);
  return limit < turn ? { at: limit, why: 'limit' } : { at: turn, why: 'turn' };
}

/**
 * `ui_wait`: waits for work an action of this turn started that was still
 * running when its call answered, and answers as that call would have once the
 * work ended. The model chooses to wait when the rest of the request needs the
 * outcome; the turn's own deadline bounds the wait, and a stop ends it.
 */
function waitTool(shared: Shared): RegisteredTool {
  return {
    name: UI_WAIT_TOOL,
    kind: 'ui',
    effect: 'view',
    description:
      'Waits for work an action started that was still running when its call answered (a job, an export), until it ends, ' +
      'and answers as that action would have: its outcome, what the page offers now and what it shows. Use it when the ' +
      'rest of the request needs the outcome: to check what was made, or to act on it. It waits until the work ends, ' +
      'its own limit passes, or the turn must answer, whichever is first; work still running then is reported running, ' +
      'never done. Name the work by `jobId`, as its answer gave it, or by `action`; with neither, the work started last.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job’s id, as the answer that started it gave it.' },
        action: { type: 'string', description: 'The action that started it, by id: its latest run still going.' },
      },
      additionalProperties: false,
      sideEffects: false,
    },
    execute(input, ctx) {
      const slot = ctx.uiSlot ?? shared.sequence.reserve();
      return slot.run(async () => {
        const found = runningWorkOf(shared.running, input);
        if (typeof found === 'string') return { success: false, error: found };
        const { action, requestId, jobId } = found;
        const id = action.entry.id;
        if (ctx.stop?.reason()) return stoppedWhileWaiting(id);
        // What the model last saw of the page: an answer says what changed since.
        const before = shared.sequence.latestSurfaces() ?? shared.deps.currentPage();
        const ends = waitEndsAt(found, shared.deps);
        const timeoutMs = ends.at - Date.now();
        const final =
          timeoutMs > 0
            ? await shared.deps.channel.awaitResult(requestId, { userId: ctx.userId, timeoutMs, signal: ctx.abortSignal, final: true })
            : null;
        if (!final && ctx.stop?.reason()) return stoppedWhileWaiting(id);
        // No answer in time, or a relay that only keeps first answers handing back the acknowledgment.
        if (!final || final.interim) {
          return {
            success: true,
            data: { action: id, ...(jobId ? { jobId } : {}), status: 'running', note: stillRunningAfterWaitNote(id, ends.why) },
          };
        }
        shared.running.delete(requestId);
        const outcome = withPage(final, shared);
        shared.deps.onResult(outcome.result, outcome.page);
        return answerFor(action, shared, outcome, before, settledWorkOf(id, jobId));
      });
    },
  };
}

/** What a settled answer to started work names beside its outcome: the action, and its job when it had one. */
function settledWorkOf(actionId: string, jobId: string | undefined): Record<string, unknown> {
  return { action: actionId, ...(jobId ? { jobId } : {}) };
}

/**
 * The answer to a call whose work ended after the call's turn had ended, in
 * the words `ui_wait` gives once work ends: its outcome and what the page showed
 * when it ended, naming the action and its job. For the turn resumed after
 * that work (orchestrator.ts), as the call's later result.
 *
 * It records nothing of the turn's: the page it ended on is older than the
 * page the resumed turn was sent from, so what the page offers is reported as
 * `page` (the turn's own) and not as a change, and whether the page can be seen
 * is the turn's snapshot's to say. An action the page no longer offers is named
 * by its id.
 */
export function laterAnswerFor(
  final: OUIActionResult,
  call: { actionId: string; jobId?: string },
  page: readonly PageSurface[],
  limits: Pick<UIToolDependencies, 'maxObservationChars' | 'maxAnswerDataChars'> = {},
): ToolExecutionResult {
  const action = pageActions(page).actions.find((a) => a.entry.id === call.actionId) ?? {
    surface: { id: '', name: '', description: '', index: [] },
    entry: { id: call.actionId, description: '', input: '', definitionHash: '' },
  };
  return renderAnswer(action, limits, { result: final, page: undefined }, page, settledWorkOf(call.actionId, call.jobId));
}

function stillRunningAfterWaitNote(id: string, why: 'limit' | 'turn'): string {
  return (
    `"${id}" is still running, so it is not done: never say it is done. ` +
    (why === 'turn'
      ? 'The wait ended because the turn must answer now: tell the person it is still running and what is left. '
      : 'It has passed its own limit, so the page stops following it: tell the person it did not finish in the time it is given. ') +
    'Its status and result appear in the page state with the person’s next message.'
  );
}

// ─── Running an action ───────────────────────────────────────────────────────

async function runAction(
  action: PageAction,
  shared: Shared,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { deps, sequence, sight } = shared;
  const { surface, entry } = action;
  const requestId = ctx.toolCallId;
  const room = ctx.socketRoom;
  if (!requestId || !room) {
    throw new Error(`[agent-sdk] UI tool ${entry.id} needs the tool call id and the turn's room`);
  }

  // A stopped turn sends nothing more: an action that was waiting its place in
  // the turn's UI order has not reached the page, and now never does.
  if (ctx.stop?.reason()) return stoppedNotRun(entry.id);

  // The page as the actions before this one left it.
  const before = sequence.latestSurfaces() ?? deps.currentPage();

  // What the worker holds of the page, so the answer repeats it only if it changed (oui-spec §7.3.4).
  const knownSurfaces = sequence.knownHash();
  const request: OUIActionRequest = {
    requestId,
    surfaceId: surface.id,
    actionId: entry.id,
    params: input,
    timestamp: Date.now(),
    // The id and hash the tab checks against its grant; a receipt is never sent to a browser.
    ...(ctx.approval ? { approval: { approvalId: ctx.approval.approvalId, argsHash: ctx.approval.argsHash } } : {}),
    ...(knownSurfaces ? { knownSurfaces } : {}),
    // The tab runs a request only for its current turn (oui-spec §7.3.1).
    turnId: ctx.turnId,
  };
  let answered = await dispatchUntilAnswered(deps, room, request, ctx);

  // The turn was stopped while the request was out.
  if (!answered.result && ctx.stop?.reason()) {
    // Tabs answered that they got it, and none took it: it did not run.
    if (answered.receipts && !answered.received) return stoppedNotTaken(entry.id);
    // The page may be running it. One last look, on the stop's own signal (the
    // turn's is aborted), so an action that did run has its answer stored and
    // the next turn does not do it again.
    const late = await deps.channel.awaitResult(requestId, {
      userId: ctx.userId,
      timeoutMs: ctx.stop.graceMs,
      signal: ctx.stop.graceSignal(),
    });
    if (!late) {
      sight.lost(`the turn was stopped before the page answered "${entry.id}"`);
      return stoppedOutcomeUnknown(entry.id);
    }
    answered = { ...answered, result: late };
  }

  if (!answered.result) {
    const within = `within ${Math.round(deps.resultTimeoutMs / 1000)}s`;
    const sent = `${answered.sends} time${answered.sends === 1 ? '' : 's'}`;
    // It may have run, and what the page shows now is unknown.
    if (answered.received || !answered.receipts) sight.lost(`the page did not answer "${entry.id}"`);
    return {
      success: false,
      error:
        (answered.received
          ? `The page received "${entry.id}" but its answer did not arrive ${within} (the request was sent ${sent}). ` +
            'It may have run: read what the page shows before doing anything else.'
          : answered.receipts
            ? `No open page received "${entry.id}" ${within} (sent ${sent}): the person's page may be closed or offline. ` +
              'It did not run there. Tell the user the page is not responding.'
            : `The page did not answer "${entry.id}" ${within}, though the request was sent to it ${sent}. ` +
              'It may or may not have run: read what the page shows before doing anything else, and tell the user if it is not responding.'),
    };
  }

  const first = withPage(answered.result, shared);
  deps.onResult(first.result, first.page);

  // Work that outlives the call (a GPU job, an export) was only started: wait
  // for its outcome, so the model tells the person it is done only once it is.
  const final = first.result.success && first.result.interim ? await awaitOutcome(entry, deps, requestId, ctx) : null;
  const outcome = final && final !== 'running' ? withPage(final, shared) : null;
  if (outcome) deps.onResult(outcome.result, outcome.page);
  if (final !== 'running') return answerFor(action, shared, outcome ?? first, before);
  // Still going: `ui_wait` can wait for it, by its job id or by its action.
  const jobId = (first.result.data as { jobId?: unknown } | undefined)?.jobId;
  shared.running.set(requestId, { action, requestId, startedAt: request.timestamp, ...(typeof jobId === 'string' && jobId ? { jobId } : {}) });
  return answerFor(action, shared, first, before, { status: 'running', note: stillRunningNote(entry) });
}

/**
 * The tool result for an action's answer: what the model reads of it (the
 * outcome, what the page offers now where that changed, and what it shows),
 * with a picture it carries lifted out as a picture. Whether the page can be
 * seen follows from it.
 */
function answerFor(
  action: PageAction,
  shared: Shared,
  answer: { result: OUIActionResult; page: PageSurface[] | undefined },
  before: readonly PageSurface[],
  extra: Record<string, unknown> = {},
): ToolExecutionResult {
  const { deps, sight } = shared;
  const { entry } = action;
  measure(deps, entry.id, answer.result);
  if (answer.result.delivery?.omitted.includes('observations')) {
    sight.lost(`the answer to "${entry.id}" came without the page's state (${answer.result.delivery.reason})`);
  } else {
    sight.seen();
  }
  return renderAnswer(action, deps, answer, before, extra);
}

/** What the model reads of an answer, `extra` beside it, with a picture it carries lifted out as a picture. Records nothing. */
function renderAnswer(
  action: PageAction,
  limits: Pick<UIToolDependencies, 'maxObservationChars' | 'maxAnswerDataChars'>,
  answer: { result: OUIActionResult; page: PageSurface[] | undefined },
  before: readonly PageSurface[],
  extra: Record<string, unknown>,
): ToolExecutionResult {
  const { surface, entry } = action;
  // A picture in the answer goes to the model as a picture, not as base64 text.
  const lifted = liftAnswerImage(answer.result.data);
  const shown: OUIActionResult = lifted.data === answer.result.data ? answer.result : { ...answer.result, data: lifted.data };
  const data = {
    ...forModel(shown, before, answer.page, limits.maxObservationChars ?? DEFAULT_PAGE_STATE_CHARS, surface.id, limits.maxAnswerDataChars ?? DEFAULT_ANSWER_DATA_CHARS),
    ...extra,
  };
  const image = lifted.image ? { image: lifted.image } : {};
  return answer.result.success
    ? { success: true, data, ...image }
    : { success: false, data, error: answer.result.error?.message ?? `"${entry.id}" failed`, ...image };
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
 * An answer with the page it stands for: the index it carries, the one derived
 * from the definitions it carries, or the one the worker holds under the hash
 * it reports (an answer repeats what the page offers only when that changed).
 * Recorded as the page from now on.
 */
function withPage(result: OUIActionResult, shared: Shared): { result: OUIActionResult; page: PageSurface[] | undefined } {
  const carried = Array.isArray(result.index) && result.index.every(isSurfaceIndex)
    ? pageFromIndex(result.index)
    : Array.isArray(result.surfaces) && result.surfaces.every(isFullSurface)
      ? pageFromSurfaces(result.surfaces, shared.held)
      : undefined;
  const page = shared.sequence.resolve({ ...(carried ? { page: carried } : {}), surfacesHash: result.surfacesHash });
  shared.sequence.record(page, result.surfacesHash);
  return { result, page };
}

/**
 * The final answer to a started action: its outcome once the work is done or
 * has failed, or `'running'` when it has not finished within the call's wait
 * (`jobWaitMs`), its own limit (its polling's `maxDurationMs`), or by when the
 * turn must stop waiting, whichever comes first.
 */
async function awaitOutcome(
  entry: OUIActionIndexEntry,
  deps: UIToolDependencies,
  requestId: string,
  ctx: ToolExecutionContext,
): Promise<OUIActionResult | 'running'> {
  const waitMs = Math.min(entry.maxDurationMs ?? Infinity, jobWaitOf(deps));
  const until = Math.min(Date.now() + waitMs, deps.waitDeadline?.() ?? Infinity);
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

/** The call's wait for a started action's outcome. */
export function jobWaitOf(deps: Pick<UIToolDependencies, 'jobWaitMs'>): number {
  const ms = deps.jobWaitMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_JOB_WAIT_MS;
}

/**
 * What the model is told of work still running when its call answered. The
 * model either waits for it now, or hands back saying it is still running.
 * When it ends after the turn, the person's tab starts a turn by itself so the
 * model reports it (a resumed turn) while their window is still open;
 * otherwise its outcome reaches the conversation in the page state of the
 * person's next message.
 */
export function stillRunningNote(entry: Pick<OUIActionIndexEntry, 'id'>): string {
  return (
    `"${entry.id}" started and has not finished yet, so it is not done: never say it is done. ` +
    `When the rest of the request needs its outcome (to check what it made, or to act on it), wait for it with ${UI_WAIT_TOOL}. ` +
    'Otherwise tell the person it is still running. If it finishes after this turn, you are brought back to report it ' +
    'in this chat while the person’s window is still open; otherwise its status and result appear in the page state ' +
    'with the person’s next message.'
  );
}

/** Report an answer's size by part, and whether it had to be shortened. */
function measure(deps: UIToolDependencies, actionId: string, result: OUIActionResult): void {
  if (!deps.log) return;
  const offered = result.index ?? result.surfaces;
  deps.log(result.delivery?.trimmed ? 'warn' : 'info', 'UI answer', {
    requestId: result.requestId,
    action: actionId,
    bytes: {
      total: jsonBytes(result),
      offered: jsonBytes(offered),
      observations: jsonBytes(result.observations),
      data: jsonBytes(result.data),
    },
    form: result.index ? 'index' : result.surfaces ? 'full' : 'unchanged',
    ...(offered ? { actions: (result.index ?? []).reduce((n, s) => n + s.index.length, 0) + (result.surfaces ?? []).reduce((n, s) => n + s.actions.length, 0) } : {}),
    ...(result.fit ? { fitted: { lists: result.fit.observations?.length ?? 0, dataLeftOut: !!result.fit.data } } : {}),
    ...(result.delivery?.trimmed ? { trimmed: result.delivery.omitted, refusedBecause: result.delivery.reason } : {}),
  });
}

/**
 * What the model sees: the outcome, what the page offers now where that
 * changed, and what it shows. A new surface comes with its index; an action
 * added to or removed from a surface is named, so the model knows the page it
 * is on, not just that something happened.
 */
function forModel(
  result: OUIActionResult,
  before: readonly PageSurface[],
  page: readonly PageSurface[] | undefined,
  maxObservationChars: number,
  actingSurfaceId: string,
  maxAnswerDataChars: number,
) {
  const after = page ?? before;
  const was = new Set(before.map((s) => s.id));
  const opened = after.filter((s) => !was.has(s.id));
  // Within the surfaces that stayed, what was added and what went.
  const stayed = (surfaces: readonly PageSurface[]) => surfaces.filter((s) => was.has(s.id) && after.some((a) => a.id === s.id));
  const { added, removed } = indexDiff(stayed(before), stayed(after));
  const closed = before.filter((s) => !after.some((a) => a.id === s.id)).map((s) => s.name);

  // What the action returned, within what a model should read of it (answer-fit.ts).
  const fitted = fitAnswerData(result.data, maxAnswerDataChars);

  return {
    ...(fitted.data !== undefined ? { result: fitted.data } : {}),
    ...(fitted.cuts.length ? { resultCut: answerCutNotes(fitted.cuts) } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.interim ? { status: 'started' } : {}),
    ...(result.settled === false
      ? { note: 'The page was still loading when this was reported; what it offers may still change.' }
      : {}),
    ...(result.delivery?.trimmed ? { delivery: deliveryNote(result.delivery) } : {}),
    ...(result.fit?.data ? { resultLeftOut: dataNote(result.fit.data) } : {}),
    page: {
      surfaces: after.map((s) => s.name),
      ...(opened.length ? { nowOffers: indexText(opened) } : {}),
      ...(closed.length ? { noLongerOnScreen: closed } : {}),
      ...(added.length ? { actionsAdded: added } : {}),
      ...(removed.length ? { actionsRemoved: removed } : {}),
    },
    ...(result.observations && Object.keys(result.observations).length
      ? {
          state: boundObservations(result.observations, maxObservationChars, actingSurfaceId, {
            schemas: observationSchemas(after),
            changed: changedRefs(result.data),
          }),
        }
      : {}),
    ...(result.fit?.observations?.length ? { notShown: fitNotes(result.fit.observations) } : {}),
  };
}

/**
 * The rows an action says it changed (a room result's `changed`), by what addresses
 * them: kept whole in the page state it comes with.
 */
function changedRefs(data: unknown): string[] {
  const changed = (data as { changed?: unknown } | null | undefined)?.changed;
  if (!Array.isArray(changed)) return [];
  return changed.flatMap((row) => {
    const ref = (row as { ref?: unknown } | null)?.ref;
    return typeof ref === 'string' ? [ref] : [];
  });
}

/** What the model is told about a result too large to send: it ran, and its result must be read another way. */
function dataNote(data: NonNullable<OUIFit['data']>): string {
  return (
    `The action ran, but what it returned was too large to send (${data.bytes} bytes; an answer carries ${data.limit}). ` +
    'Its outcome above stands. Read what it produced from the page state, or with a tool that returns it in parts.'
  );
}

/** What of the page's state the client left out to fit its answer, and how to read each part (oui-spec §7.3.9). */
export function fitNotes(cuts: NonNullable<OUIFit['observations']>): string[] {
  return cuts.map((cut) => {
    const where = `${cut.surface}.${cut.observation}${cut.path}`;
    const read = (extra: Record<string, unknown>) =>
      `${UI_READ_TOOL}(${JSON.stringify({ surface: cut.surface, observation: cut.observation, ...(cut.path ? { path: cut.path } : {}), ...extra })})`;
    if (cut.kind === 'list') {
      return `${where} has ${cut.total} rows; the page sent the first ${cut.kept}. Read more with ${read({ offset: cut.kept })}, or with the surface's own query tool.`;
    }
    if (cut.kind === 'text') {
      return `${where} is ${cut.total} characters; the page sent the first ${cut.kept}. Read it whole with ${read({})}.`;
    }
    return `${where} (${cut.total} bytes) was left out to fit the answer. Read it with ${read({})}.`;
  });
}

/**
 * What the model is told about an answer the tab had to trim to deliver
 * (oui-spec §7.3.6): the outcome is what happened, and what it lacks.
 */
function deliveryNote(delivery: NonNullable<OUIActionResult['delivery']>): string {
  const lacks = delivery.omitted.map((field) =>
    field === 'data'
      ? 'what the action returned'
      : field === 'observations'
        ? 'the page’s state'
        : 'what the page now offers',
  );
  const blind = delivery.omitted.includes('observations');
  return (
    `The page ran this, and its outcome here is what happened, but its full answer was refused on the way ` +
    `(${delivery.reason}), so it came without ${lacks.join(', ')}. ` +
    (blind
      ? `You cannot see the page now: read it (${UI_READ_TOOL}, or a surface's own read tools) before anything else. Nothing that changes the page runs until you have.`
      : 'The page state below is current.')
  );
}
