/**
 * A turn's UI actions run one at a time, in the order the model called them.
 *
 * The model often asks for several UI actions in one response: fill a field,
 * fill another, press the form's button. Each is a tool call, and tool calls
 * from one response run concurrently, so a button press could reach the page
 * before the fields were filled and find the button still disabled. UI actions
 * act on one page, so they queue: each is dispatched only once the one before
 * has answered, whether it succeeded or failed, and each result shows the page
 * as the actions before it left it.
 *
 * The order is taken when the model's call arrives, not when the action is
 * ready to dispatch. Whatever runs first (the orchestrator's input check, the
 * host's tool policy, the "tool call started" emit) may finish in any order, so
 * the caller reserves its place synchronously, before any `await`, and runs
 * the action on that place later (`reserve`). On dev a name and a prompt called
 * in that order ran prompt-first because the queue was joined only after those
 * awaits.
 *
 * One sequence per turn, shared by every set of UI tools built during it (the
 * tools are rebuilt when the page changes). Host tools are not queued.
 *
 * The sequence also holds what the page offers, by the client's hash of it
 * (oui-spec §7.3.4): a request says which the worker holds (`knownSurfaces`),
 * and the tab's answer then carries it only when it changed. An answer without
 * it is resolved here, from the hash it reports.
 */
import type { PageSurface } from './page-index.js';

/** One place in a turn's UI order, taken when the call arrived. */
export interface UISlot {
  /**
   * Run the action in this place: once every place taken before it has
   * finished. The place is finished when the action settles, succeeded or not.
   * Call it at most once.
   */
  run<T>(step: () => Promise<T>): Promise<T>;
  /**
   * Give the place up without running anything (the call was refused before it
   * reached the page). Does nothing once `run` has been called: then the place
   * is finished only when the action settles, so a caller that stops waiting
   * (a timeout) cannot let the next action reach the page early.
   */
  release(): void;
}

export interface UISequence {
  /** Take the next place in the order now, synchronously. Every place must be run or released. */
  reserve(): UISlot;
  /** Take the next place and run a UI action in it: `reserve().run(step)`. */
  run<T>(step: () => Promise<T>): Promise<T>;
  /** The surfaces on screen after the last answered action, or null before any has answered. */
  latestSurfaces(): readonly PageSurface[] | null;
  /**
   * The hash of the surfaces the worker holds for the page — the snapshot's,
   * or the last answer's — sent as a request's `knownSurfaces`; null when the
   * page's surfaces are not known for certain, so the tab sends them all.
   */
  knownHash(): string | null;
  /**
   * The surfaces an answer stands for: those it carries, else those held under
   * the hash it reports, else undefined (an answer from a tab that sends
   * neither, or a hash the worker never held).
   */
  resolve(answer: { page?: PageSurface[]; surfacesHash?: string }): PageSurface[] | undefined;
  /**
   * Record the surfaces an answer (or the turn's snapshot) reported, with
   * their hash. An answer whose surfaces cannot be resolved makes the page's
   * surfaces unknown: the next request names none, and the tab sends them.
   */
  record(surfaces: readonly PageSurface[] | undefined, hash?: string): void;
}

/** How many surface sets the sequence keeps by hash: the page, and the few it was just on. */
const HELD_SURFACE_SETS = 8;

export function createUISequence(): UISequence {
  let tail: Promise<void> = Promise.resolve();
  let latest: readonly PageSurface[] | null = null;
  let latestHash: string | null = null;
  // Surface sets by hash, oldest first, at most HELD_SURFACE_SETS.
  const held = new Map<string, PageSurface[]>();
  const hold = (hash: string, surfaces: PageSurface[]) => {
    held.delete(hash);
    held.set(hash, surfaces);
    while (held.size > HELD_SURFACE_SETS) held.delete(held.keys().next().value as string);
  };

  function reserve(): UISlot {
    const before = tail;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // The next place waits for this one, and so for every place before it,
    // even when this one is released without running.
    tail = before.then(() => finished);
    let used = false;
    return {
      run<T>(step: () => Promise<T>): Promise<T> {
        if (used) throw new Error('[agent-sdk] a UI slot runs one action');
        used = true;
        const next = before.then(step);
        // A failed action does not hold up the ones after it.
        next.then(finish, finish);
        return next;
      },
      release() {
        if (used) return;
        used = true;
        finish();
      },
    };
  }

  return {
    reserve,
    run: (step) => reserve().run(step),
    latestSurfaces: () => latest,
    knownHash: () => latestHash,
    resolve(answer) {
      if (answer.page) return answer.page;
      return answer.surfacesHash ? held.get(answer.surfacesHash) : undefined;
    },
    record(surfaces, hash) {
      if (surfaces) {
        latest = surfaces;
        latestHash = hash ?? null;
        if (hash) hold(hash, [...surfaces]);
      } else if (hash !== undefined && held.has(hash)) {
        // Unchanged, or back to a set held before: that set is the page now.
        latest = held.get(hash)!;
        latestHash = hash;
        hold(hash, held.get(hash)!);
      } else {
        // What the page offers now is not known for certain: ask for it whole.
        latestHash = null;
      }
    },
  };
}
