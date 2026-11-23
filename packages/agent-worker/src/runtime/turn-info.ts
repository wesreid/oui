/**
 * Which turn a host's hook is called for: its id, how it reached the
 * runtime, how the person entered its message, and where they approve.
 *
 * Every hook that acts on one turn is given this one description
 * (`beforeTurn`, `filterEvent`, the turn policy, `approvals.preview`,
 * `approvals.validateBeforeApproval`), so a host decides by the turn itself
 * rather than by a label it threads through on its own.
 */
import type { ApprovalChannel } from '@ouispec/agent-core';
import { readClientMessageInput } from '../prompt/spoken-input.js';

/**
 * How a turn reached the runtime: `lambda` (the SQS adapter), `container`
 * (`POST /turns`), `live-call` (the live-call handler), or what a host that
 * calls `runner.run` itself names it (`TurnHost.channel`, default `direct`).
 */
export type AgentTurnChannel = 'lambda' | 'container' | 'live-call' | 'direct' | (string & {});

/** The channel of a turn whose host named none. */
export const DEFAULT_TURN_CHANNEL = 'direct';

/** How the person entered the turn's message: `voice` when spoken and transcribed, else `text`. */
export type AgentTurnInputMode = 'voice' | 'text';

/** The turn a hook is called for. */
export interface AgentTurnInfo {
  /** The turn's id. */
  id: string;
  channel: AgentTurnChannel;
  inputMode: AgentTurnInputMode;
  /**
   * The language the person's message was recognised in (a BCP 47 tag), when
   * it was spoken and the recogniser said. Null otherwise.
   */
  language: string | null;
  /**
   * Where the person is, for approvals: `ui` (the card) or a conversation
   * channel (`chat`, `sms`, `voice`, `phone`), where a call is read back and
   * the next message confirms it. The turn payload's `channel`; `ui` when it
   * names none.
   */
  approvalChannel: ApprovalChannel;
  /**
   * The context the client sent with the turn (the turn payload's `context`), as
   * it came, or null when it sent none. A host reads its own keys from it, such
   * as a preference that changes how its policy hands a turn back. It is the
   * client's word: a host validates what it reads.
   */
  context: Readonly<Record<string, unknown>> | null;
  /**
   * Which automatic continuation this turn is: `context.autoContinue` when the
   * client started the turn itself to carry on the work of the turns before it
   * (1 for the first, 2 for the next), else 0, a turn the person started.
   */
  autoContinue: number;
}

/** Which automatic continuation a turn's context says it is: a positive integer, else 0. */
export function autoContinueOf(context: Readonly<Record<string, unknown>> | null | undefined): number {
  const n = context?.autoContinue;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The description of a turn: its id, how it reached the runtime, how its
 * message was entered (its context's `input`), where the person approves, its
 * context, and whether the client started it to continue on its own.
 */
export function turnInfoOf(
  turn: { turnId: string; context?: Record<string, unknown> | null },
  channel: AgentTurnChannel | undefined,
  approvalChannel?: ApprovalChannel,
): AgentTurnInfo {
  const context = turn.context && typeof turn.context === 'object' && !Array.isArray(turn.context) ? turn.context : null;
  const input = readClientMessageInput(context);
  return {
    id: turn.turnId,
    channel: typeof channel === 'string' && channel ? channel : DEFAULT_TURN_CHANNEL,
    inputMode: input?.mode === 'voice' ? 'voice' : 'text',
    language: input?.language ?? null,
    approvalChannel: approvalChannel ?? 'ui',
    context,
    autoContinue: autoContinueOf(context),
  };
}
