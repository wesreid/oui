/**
 * Which turn a host's hook is called for: its id, how it reached the
 * runtime, and how the person entered its message.
 *
 * Every hook that acts on one turn is given this one description
 * (`beforeTurn`, `filterEvent`, the turn policy, `approvals.preview`,
 * `approvals.validateBeforeApproval`), so a host decides by the turn itself
 * rather than by a label it threads through on its own.
 */
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
}

/** The description of a turn: its id, its channel, and how its message was entered (its context's `input`). */
export function turnInfoOf(
  turn: { turnId: string; context?: Record<string, unknown> | null },
  channel: AgentTurnChannel | undefined,
): AgentTurnInfo {
  const input = readClientMessageInput(turn.context ?? null);
  return {
    id: turn.turnId,
    channel: typeof channel === 'string' && channel ? channel : DEFAULT_TURN_CHANNEL,
    inputMode: input?.mode === 'voice' ? 'voice' : 'text',
    language: input?.language ?? null,
  };
}
