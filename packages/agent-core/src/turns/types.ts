/**
 * Stopping a turn (ADR-0252): the shapes the tab, the realtime server, the
 * worker and a host's API exchange when a person stops a running turn, or
 * sends a new message that supersedes it.
 *
 * A stop is a request kept by the realtime server. The worker has no socket:
 * it asks for the request, as it asks for UI answers and approvals.
 */

/** The client event a user's socket sends to stop its own running turn. */
export const TURN_STOP_EVENT = 'agent:turn_stop';

/**
 * Why a turn was stopped:
 * - `user_stop`: the person pressed Stop.
 * - `superseded`: a newer message arrived in the conversation, and it runs instead.
 */
export type TurnStopReason = 'user_stop' | 'superseded';

export const TURN_STOP_REASONS: readonly TurnStopReason[] = ['user_stop', 'superseded'];

export function isTurnStopReason(value: unknown): value is TurnStopReason {
  return typeof value === 'string' && (TURN_STOP_REASONS as readonly string[]).includes(value);
}

/**
 * What the tab sends with `TURN_STOP_EVENT`. A stop from a socket is always
 * the person's own (`user_stop`). `room` is the turn's room, which the tab
 * joined with the turn's room token: being in it is what shows the turn is
 * this user's.
 */
export interface TurnStopPayload {
  turnId: string;
  room: string;
}

/**
 * The server's answer to `TURN_STOP_EVENT`.
 * - `requested`: the stop is recorded; the turn's worker hears it and ends the turn.
 * - `already`: a stop was recorded before this one; that one stands.
 */
export type TurnStopResult =
  | { ok: true; stop: 'requested' | 'already' }
  | { ok: false; reason: 'not_in_turn_room' | 'invalid' | 'unavailable' };

/** The stop the realtime server keeps for a turn, written once. */
export interface TurnStopRecord {
  turnId: string;
  /** The user who asked, or on whose behalf the host asked. */
  by: string;
  reason: TurnStopReason;
  /** Epoch ms, by the store's clock. */
  at: number;
}

/**
 * How long the server keeps a stop: far longer than any turn runs, so a worker
 * that was slow to start, or whose watch failed and retried, still hears it.
 */
export const TURN_STOP_RECORD_TTL_MS = 30 * 60_000;

/**
 * A stopped turn's mark on its last stored assistant message. A later turn's
 * history says, after that message's text, that the turn was stopped there.
 */
export interface TurnStoppedMarker {
  reason: TurnStopReason;
  /** Epoch ms. */
  at: number;
}

/**
 * The line a stopped turn leaves in the conversation: what a later turn's
 * model reads after the stopped message's text, and the whole text of a
 * stopped message that has none (a model provider refuses an empty text
 * block, so a stopped turn that produced nothing still says this).
 */
export function turnStoppedNote(marker: Pick<TurnStoppedMarker, 'reason'>): string {
  return marker.reason === 'superseded'
    ? '[This turn was stopped here because the person sent a new message. Calls marked "not run" did not run.]'
    : '[The person stopped this turn here. Calls marked "not run" did not run.]';
}
