/**
 * A turn hands back before its time runs out.
 *
 * The turn's deadline stops it wherever it is: what it had
 * done is kept, and the person is shown that it ran out of time, with nothing
 * said about what was done. In one session a turn
 * building six logo concepts in the vector studio drew all six and took a
 * snapshot of each; the deadline came four seconds into the step that would
 * have looked at them and answered, and the person saw only "ran out of time".
 *
 * A step limit already ends a turn with an answer: the host's policy makes its
 * last step say what is done and offer to continue. Time now does the same.
 * Before each step the worker asks whether a step as long as the longest this
 * turn has taken, and then a step to answer, still fit before the deadline. When
 * they do not, this step is the last: the model says what is done and what is
 * left, and offers to continue. The deadline stays the hard stop for a step that
 * runs longer than any before it.
 */

/** Kept back for the step that hands the turn back: reading the turn and saying what is done. */
export const DEFAULT_HAND_BACK_RESERVE_MS = 30_000;

/** What the model is told at the step that hands the turn back for time. */
export function timeHandBackNote(canOfferChoices: boolean): string {
  return (
    'This turn is almost out of time, so this is its last step. Tell the user plainly what is done and what is ' +
    'left, from what the page state confirms, then ' +
    (canOfferChoices ? 'offer to continue with present_options.' : 'say they can ask you to continue.') +
    ' Do not give any other reason for stopping.'
  );
}

export interface StepTiming {
  /** Time left before the turn's deadline, in ms. */
  remainingMs: number;
  /** The longest step of this turn so far, its calls included, in ms. 0 before the first step ends. */
  longestStepMs: number;
  /** The time kept back for the hand-back step, in ms. */
  reserveMs: number;
  /** Whether this step must hand the turn back. */
  handBack: boolean;
}

export interface StepClock {
  /** Called as each step starts: how long the step before it took, and whether this one is the last. */
  stepStarting(now?: number): StepTiming;
}

/**
 * The turn's step clock. A step lasts from its start to the next step's start,
 * so the time its calls took (a UI action, a job it waited on) is part of it.
 *
 * The reserve is never more than a quarter of the turn's time, so a short
 * deadline still leaves its first steps to work.
 */
export function createStepClock(options: { deadlineAt: number; turnDeadlineMs: number; reserveMs?: number }): StepClock {
  const reserveMs = Math.max(0, Math.min(options.reserveMs ?? DEFAULT_HAND_BACK_RESERVE_MS, options.turnDeadlineMs / 4));
  let lastStartedAt: number | null = null;
  let longestStepMs = 0;
  return {
    stepStarting(now = Date.now()) {
      if (lastStartedAt !== null) longestStepMs = Math.max(longestStepMs, now - lastStartedAt);
      lastStartedAt = now;
      const remainingMs = options.deadlineAt - now;
      return { remainingMs, longestStepMs, reserveMs, handBack: remainingMs < longestStepMs + reserveMs };
    },
  };
}
