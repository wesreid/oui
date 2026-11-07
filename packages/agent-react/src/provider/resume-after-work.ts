/**
 * Resuming after work: the provider's decision to start a turn by itself when
 * work the assistant started (a job, an export) finished after the turn that
 * started it had ended, so the assistant reports the outcome in the same chat.
 *
 * The tab's OUI runtime tells each settlement (`config.settledWork`, wired to
 * oui-spec's `runtime.onSettled`) once the realtime server holds the work's
 * final answer. This module decides, from the turn that started the work and
 * the tab's state, whether that outcome needs a turn of its own:
 *
 * - Only for a turn of the open conversation that this tab ran, and that has
 *   ended by itself: answered, handed back for time, failed, or out of time.
 *   Never for a turn the person stopped (a stop means stop), one their newer
 *   message superseded (the newer turn read the page), one a person on the
 *   staff took over, or one that ended waiting for the person's approval.
 * - Not while a turn runs or starts (its page state, or its `ui_wait`, carries
 *   the outcome), while a conversation loads, while an approval card or a
 *   choice waits on the person, or while a person on the staff holds the
 *   conversation. The open conversation's turns are forgotten when it changes,
 *   so work of a conversation the person left, or of one before a new one,
 *   resumes nothing.
 * - Work that ends close together (`RESUME_GATHER_MS` after the last) is
 *   reported in one turn, up to `RESUME_MAX_REQUESTS` requests.
 * - At most `RESUME_MAX_IN_A_ROW` turns in a row before the person writes
 *   again: a resumed turn may start more work, bounded.
 *
 * Every decision is logged: resumed, or not and why. Each is checked when the
 * work ends and again when the turn would start, since the tab may have moved
 * on while it gathered.
 */
import {
  RESUME_GATHER_MS,
  RESUME_MAX_IN_A_ROW,
  RESUME_MAX_REQUESTS,
  type SettledWork,
  type TurnEndReason,
  type TurnStoppedReason,
} from '@ouispec/agent-core';

/** How a turn this tab ran ended. */
export type TabTurnEnd =
  /** By itself: answered, asked something, handed back for time, or bounded. */
  | { kind: 'ended'; reason?: TurnEndReason }
  /** With an error. */
  | { kind: 'failed' }
  /** On the stop path: by the person, by a newer message, by a person on the staff, or by its deadline. */
  | { kind: 'stopped'; reason: TurnStoppedReason };

/** What the tab is doing, read when a decision is made. */
export interface TabResumeState {
  /** The open conversation, or null. */
  conversationId: string | null;
  /** A turn of the tab runs, or is starting. */
  turnBusy: boolean;
  /** A conversation is loading: the open one may be about to change. */
  loading: boolean;
  /** An approval card waits on the person. */
  approvalWaiting: boolean;
  /** A choice the assistant offered waits on the person. */
  choiceWaiting: boolean;
  /** A person on the staff holds the conversation. */
  heldByStaff: boolean;
}

export interface WorkResumerDeps {
  state(): TabResumeState;
  /** Start the resumed turn for these requests. */
  resume(requestIds: string[]): void;
  log(message: string, data: Record<string, unknown>): void;
}

export interface WorkResumer {
  /** A turn of the tab has its id: `conversationId` is the conversation it runs in. */
  turnStarted(turnId: string, conversationId: string): void;
  /** How a turn of the tab ended. The first end recorded stands: a stop the person asked for is not undone by a late completion. */
  turnEnded(turnId: string, end: TabTurnEnd): void;
  /** The person wrote: the count of turns resumed in a row starts again. */
  personWrote(): void;
  /** The open conversation changed: its turns, the work gathered and the count are forgotten. */
  conversationChanged(): void;
  /** Work ended, and the realtime server holds its outcome. */
  settled(work: SettledWork): void;
  /** Drop the work gathered and not yet started: the tab stopped listening for settlements. */
  dispose(): void;
}

/** How many of the open conversation's turns are remembered: far more than can still have work running. */
const TURNS_REMEMBERED = 64;

/** Why a turn's end gives no resume, or null when it does. */
function endRefusal(end: TabTurnEnd): string | null {
  if (end.kind === 'stopped') {
    switch (end.reason) {
      case 'user_stop':
        return 'the person stopped the turn that started it';
      case 'superseded':
        return "the person's newer message superseded the turn that started it, and the newer turn read the page";
      case 'taken_over':
        return 'a person on the staff took the conversation over during the turn that started it';
      default:
        // Out of time is the turn's failure, not the person's choice.
        return null;
    }
  }
  if (end.kind === 'ended' && end.reason === 'awaiting_approval') return "the turn that started it ended waiting for the person's approval";
  return null;
}

/** Why the tab's state gives no resume now, or null when it does. */
function stateRefusal(state: TabResumeState): string | null {
  if (state.turnBusy) return "a turn is running or starting: its page state carries the outcome";
  if (state.loading) return 'a conversation is loading';
  if (state.approvalWaiting) return 'an approval card waits on the person';
  if (state.choiceWaiting) return 'a choice waits on the person';
  if (state.heldByStaff) return 'a person on the staff holds the conversation';
  return null;
}

export function createWorkResumer(deps: WorkResumerDeps): WorkResumer {
  const turns = new Map<string, { conversationId: string; end: TabTurnEnd | null }>();
  let gathered: SettledWork[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inARow = 0;

  const stopGathering = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Why this work's outcome gets no turn of its own now, or null when it does. */
  function refusal(work: SettledWork): string | null {
    if (!work.turnId) return 'the request named no turn';
    const turn = turns.get(work.turnId);
    const state = deps.state();
    if (!turn || turn.conversationId !== state.conversationId) return 'it was not started by a turn this tab ran in the open conversation';
    if (!turn.end) return 'the turn that started it has not ended: its page state, or its wait, carries the outcome';
    return endRefusal(turn.end) ?? stateRefusal(state) ?? (inARow >= RESUME_MAX_IN_A_ROW ? `${RESUME_MAX_IN_A_ROW} turns were already resumed in a row without a message from the person` : null);
  }

  const described = (work: SettledWork) => ({ requestId: work.requestId, turnId: work.turnId ?? null, action: work.actionId, success: work.success });

  function start() {
    timer = null;
    const batch = gathered;
    gathered = [];
    if (batch.length === 0) return;
    // The tab may have moved on while the work gathered: each is judged again now.
    const ready = batch.filter((work) => {
      const why = refusal(work);
      if (why) deps.log(`Not resuming after work: ${why}`, described(work));
      return !why;
    });
    if (ready.length === 0) return;
    inARow += 1;
    const requestIds = ready.map((w) => w.requestId);
    deps.log('Resuming after work that finished after its turn ended', {
      requestIds,
      turnIds: [...new Set(ready.map((w) => w.turnId))],
      inARow,
    });
    deps.resume(requestIds);
  }

  return {
    turnStarted(turnId, conversationId) {
      if (turns.has(turnId)) return;
      turns.set(turnId, { conversationId, end: null });
      if (turns.size > TURNS_REMEMBERED) turns.delete(turns.keys().next().value as string);
    },
    turnEnded(turnId, end) {
      const turn = turns.get(turnId);
      if (turn && !turn.end) turn.end = end;
    },
    personWrote() {
      inARow = 0;
    },
    conversationChanged() {
      stopGathering();
      if (gathered.length) deps.log('Not resuming after work: the open conversation changed', { requestIds: gathered.map((w) => w.requestId) });
      gathered = [];
      turns.clear();
      inARow = 0;
    },
    settled(work) {
      const why = refusal(work);
      if (why) {
        deps.log(`Not resuming after work: ${why}`, described(work));
        return;
      }
      if (gathered.some((w) => w.requestId === work.requestId)) return;
      gathered.push(work);
      stopGathering();
      // A full turn's worth goes at once; otherwise more work may still end.
      if (gathered.length >= RESUME_MAX_REQUESTS) start();
      else timer = setTimeout(start, RESUME_GATHER_MS);
    },
    dispose() {
      stopGathering();
      gathered = [];
    },
  };
}
