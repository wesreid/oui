/**
 * Which turns a long-running host is running, and whether it takes another.
 *
 * One set of slots per process: the container's `POST /turns` and the
 * live-call handler share it, so `maxConcurrentTurns` bounds every turn the
 * process runs, a turn id runs once at a time whichever route it came by,
 * and closing waits for all of them.
 */

/** Why a turn was not taken, as an HTTP status and a line. */
export interface TurnSlotRefusal {
  status: 409 | 503;
  error: string;
}

export interface TurnSlots {
  /** Turns running now. */
  running(): number;
  /** Whether `turnId` is running now. */
  has(turnId: string): boolean;
  /**
   * Takes a slot for `turnId` and runs `work` in it, or answers why not: the
   * turn is already running (409), or the host is at capacity or closing
   * (503). The slot is freed when `work` settles; what it throws is the
   * caller's to handle inside `work`, and is otherwise dropped.
   */
  take(turnId: string, work: () => Promise<unknown>): TurnSlotRefusal | null;
  /** Takes no more turns, and resolves once every running one has ended. */
  drain(): Promise<void>;
}

export function createTurnSlots(capacity: number): TurnSlots {
  if (!(Number.isInteger(capacity) && capacity > 0)) {
    throw new Error(`[agent-sdk] maxConcurrentTurns must be a positive integer, not ${capacity}`);
  }
  const inFlight = new Map<string, Promise<void>>();
  let closing = false;

  return {
    running: () => inFlight.size,
    has: (turnId) => inFlight.has(turnId),
    take(turnId, work) {
      if (inFlight.has(turnId)) return { status: 409, error: `turn ${turnId} is already running` };
      if (closing || inFlight.size >= capacity) return { status: 503, error: closing ? 'shutting down' : 'at capacity' };
      const run = Promise.resolve()
        .then(work)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => inFlight.delete(turnId));
      inFlight.set(turnId, run);
      return null;
    },
    async drain() {
      closing = true;
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
