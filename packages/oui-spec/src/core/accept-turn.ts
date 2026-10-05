import type { OUIActionRequest } from "../spec/types.js";

/**
 * An `accept` rule for a client whose agent works in turns, one at a time
 * (§7.3.1): a request runs only for the turn the client is running now.
 *
 * - A request that names its turn (`turnId`) is accepted when that is the
 *   client's current turn. A request sent late by a turn the person stopped,
 *   or that a newer message superseded, names a turn that is no longer
 *   current, and is refused: it does not run under the newer instruction.
 * - A request that names no turn comes from an agent runtime that does not
 *   send one (an older worker, during a rollout). It is accepted while a turn
 *   is in progress, which is the rule a client had before requests named
 *   their turn. It is never refused only for naming none.
 *
 * `currentTurn` returns the id of the turn the client is running, or null
 * when it runs none.
 */
export function acceptCurrentTurn(
  currentTurn: () => string | null,
): (request: OUIActionRequest) => boolean {
  return (request) => {
    const current = currentTurn();
    if (current === null) return false;
    if (request.turnId === undefined) return true;
    return request.turnId === current;
  };
}
