/**
 * The clock of each model call in a turn: what a person
 * waits for is mostly the number of calls and what each one writes, so each
 * call's times are logged beside its tokens.
 *
 * Times are in milliseconds:
 * - `firstTokenMs`, from the request to its first token of any kind (reasoning,
 *   text, or a tool call's input); null when it produced none;
 * - `durationMs`, from the request to its end;
 * - `sinceLastMs`, from the end of the call before it (the turn's start, for the
 *   first) to this one's request: the turn's tools and the worker's own work
 *   between calls.
 */

/** The parts of a model's stream that are tokens it produced (ai's `LanguageModelV3StreamPart` types). */
export const MODEL_OUTPUT_PARTS: ReadonlySet<string> = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call']);

export interface CallClock {
  startedAt: number;
  firstTokenMs: number | null;
  durationMs: number | null;
  sinceLastMs: number;
}

/** What one call's stream reports to its clock. */
export interface RunningClock {
  /** A part of the stream arrived: the first output part sets the time to the first token, `finish` ends the call. */
  saw(type: string): void;
  /** The stream closed: the call ends now unless its `finish` part ended it already. */
  ended(): void;
}

/** Starts the next call's clock in `clocks`. `turnStartedAt` is when the turn began; `now` is the clock read. */
export function startCallClock(clocks: CallClock[], turnStartedAt: number, now: () => number = Date.now): RunningClock {
  const startedAt = now();
  const before = clocks[clocks.length - 1];
  const lastEnd = before ? before.startedAt + (before.durationMs ?? 0) : turnStartedAt;
  const clock: CallClock = { startedAt, firstTokenMs: null, durationMs: null, sinceLastMs: Math.max(0, startedAt - lastEnd) };
  clocks.push(clock);
  const end = () => {
    if (clock.durationMs === null) clock.durationMs = now() - startedAt;
  };
  return {
    saw(type) {
      if (clock.firstTokenMs === null && MODEL_OUTPUT_PARTS.has(type)) clock.firstTokenMs = now() - startedAt;
      if (type === 'finish') end();
    },
    ended: end,
  };
}

/** A call's times for its `Step completed` line; null fields when the model has no clock. */
export function stepClockFields(clock: CallClock | undefined): { firstTokenMs: number | null; durationMs: number | null; sinceLastCallMs: number | null } {
  return { firstTokenMs: clock?.firstTokenMs ?? null, durationMs: clock?.durationMs ?? null, sinceLastCallMs: clock ? clock.sinceLastMs : null };
}

/** A turn's times for its `Turn usage` line. */
export interface TurnTiming {
  /** From the turn's start to its first model call's first token; null when none produced one. */
  firstTokenMs: number | null;
  /** From the turn's start to the first text the person could read; null when it wrote none. */
  firstTextMs: number | null;
  /** The model calls' time, one after another. */
  modelMs: number;
  /** The time between calls: tools and the worker's work. */
  betweenCallsMs: number;
  /** Each call's time, in order. */
  callMs: number[];
}

/** Sums a turn's call clocks. */
export function turnTiming(clocks: readonly CallClock[], turnStartedAt: number, firstTextMs: number | null): TurnTiming {
  const firstWithToken = clocks.find((c) => c.firstTokenMs !== null);
  return {
    firstTokenMs: firstWithToken ? firstWithToken.startedAt - turnStartedAt + (firstWithToken.firstTokenMs as number) : null,
    firstTextMs,
    modelMs: clocks.reduce((n, c) => n + (c.durationMs ?? 0), 0),
    betweenCallsMs: clocks.reduce((n, c, i) => n + (i === 0 ? 0 : c.sinceLastMs), 0),
    callMs: clocks.map((c) => c.durationMs ?? 0),
  };
}
