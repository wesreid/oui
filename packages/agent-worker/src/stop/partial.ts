/**
 * What a stopped turn stores (ADR-0252 §2.3): the steps it finished, the step
 * it was in, and a marker on its last assistant message.
 *
 * It is built from what the worker itself recorded as the turn ran: the text
 * it streamed, the steps it saw end, and the calls its tools were asked to
 * run. Nothing here reads the model stream's own results, which do not
 * survive an abort, so it is the same whatever way the abort surfaces.
 */
import { turnStoppedNote, type TurnStoppedMarker } from '@ouispec/agent-core';
import type { TurnMessage } from '../types.js';
import { resultText, stoppedWhileRunning } from './results.js';
import { answerWithoutState } from '../ui/page-state-at-end.js';

/** A step the turn saw end: its text, and the calls the model made in it. */
export interface RecordedStep {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
}

/** A call a tool of the turn was asked to run, in the order the calls arrived. */
export interface RecordedCall {
  toolCallId: string;
  /** The tool as the model called it (`ui_act` for a page action). */
  toolName: string;
  input: unknown;
  /** Its result as the model would read it; null while it has not settled. */
  text: string | null;
}

const asArguments = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

/**
 * The stopped turn's messages, each call with exactly one result:
 * - a call that settled keeps the result it gave, which for a call the stop
 *   cut short already says so (not run, or sent with its outcome unknown);
 * - a call still unsettled when the grace ended is stored as running when the
 *   turn was stopped, its outcome unknown.
 *
 * The last assistant message carries the marker. A turn that produced no
 * text and no call still stores one assistant message, whose text is the
 * marker's line: a model provider refuses an empty text block, and the
 * conversation never holds two user messages with nothing between them.
 */
export function stoppedTurnMessages(recorded: {
  steps: readonly RecordedStep[];
  calls: readonly RecordedCall[];
  /** Every piece of reply text the turn streamed, in order. */
  streamedText: string;
  marker: TurnStoppedMarker;
}): TurnMessage[] {
  const { steps, calls, streamedText, marker } = recorded;
  const byId = new Map(calls.map((call) => [call.toolCallId, call]));
  const messages: TurnMessage[] = [];

  const push = (text: string, stepCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>) => {
    // Whitespace alone is no text: a provider refuses that block too.
    const content = text.trim() ? text : null;
    if (content === null && stepCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content,
      ...(stepCalls.length > 0
        ? { toolCalls: stepCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, arguments: asArguments(c.input) })) }
        : {}),
    });
    for (const call of stepCalls) {
      messages.push({
        role: 'tool',
        content: answerWithoutState(byId.get(call.toolCallId)?.text ?? resultText(stoppedWhileRunning(call.toolName))),
        toolCallId: call.toolCallId,
        name: call.toolName,
      });
    }
  };

  const finished = new Set<string>();
  let finishedText = 0;
  for (const step of steps) {
    push(step.text, step.toolCalls);
    finishedText += step.text.length;
    for (const call of step.toolCalls) finished.add(call.toolCallId);
  }
  // The step the turn was in: the text streamed since the last step ended, and
  // the calls no finished step holds.
  push(
    streamedText.length > finishedText ? streamedText.slice(finishedText) : '',
    calls.filter((call) => !finished.has(call.toolCallId)),
  );

  let last: TurnMessage | undefined;
  for (let i = messages.length - 1; i >= 0 && !last; i--) if (messages[i].role === 'assistant') last = messages[i];
  if (!last) {
    messages.push({ role: 'assistant', content: turnStoppedNote(marker), stopped: marker });
  } else {
    last.stopped = marker;
  }
  return messages;
}
