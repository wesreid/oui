/**
 * What a call's result says when its turn was stopped before the call ended
 * (ADR-0252 §2.2). Every call the model made keeps exactly one result, so the
 * stored conversation is one a model accepts, and a later turn reads what
 * became of each call instead of guessing.
 */
import type { ToolExecutionResult } from '../tools/types.js';

/** The call never left the worker: nothing ran. */
export function stoppedNotRun(what: string): ToolExecutionResult {
  return {
    success: false,
    error: `Not run: the turn was stopped before "${what}" was sent. Nothing was changed by it.`,
    data: { stopped: true, notRun: true },
  };
}

/** The request went out, tabs answered that they got it, and none took it: it did not run. */
export function stoppedNotTaken(what: string): ToolExecutionResult {
  return {
    success: false,
    error: `Not run: "${what}" was sent, and no open page took it before the turn was stopped. Nothing was changed by it.`,
    data: { stopped: true, notRun: true },
  };
}

/** The call was sent to the page and no answer came back before the turn ended. */
export function stoppedOutcomeUnknown(what: string): ToolExecutionResult {
  return {
    success: false,
    error:
      `"${what}" was sent to the page, and the turn was stopped before its answer arrived. It may have run: ` +
      'its outcome is unknown. Read what the page shows before doing anything that depends on it.',
    data: { stopped: true, sent: true, outcome: 'unknown' },
  };
}

/** A tool was running when the turn was stopped, and did not finish in time to say what it did. */
export function stoppedWhileRunning(what: string): ToolExecutionResult {
  return {
    success: false,
    error: `"${what}" was running when the turn was stopped. It did not finish in time to report: its outcome is unknown.`,
    data: { stopped: true, sent: true, outcome: 'unknown' },
  };
}

/** A read of the page that the stop cut short: nothing was changed, and nothing was learned. */
export function stoppedBeforeAnswer(what: string): ToolExecutionResult {
  return {
    success: false,
    error: `The turn was stopped before ${what} was answered. Nothing was changed.`,
    data: { stopped: true, notRun: true },
  };
}

/** The text of a result, as a stored tool message carries it. */
export function resultText(result: ToolExecutionResult): string {
  return JSON.stringify({ success: false, error: result.error, ...(result.data as Record<string, unknown>) });
}
