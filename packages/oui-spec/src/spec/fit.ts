/**
 * Fitting what a client sends to a byte budget (§7.3.9).
 *
 * A frame larger than its receiver accepts is refused whole, and the agent
 * then knows nothing of the page. So the client shortens what it sends before
 * it sends it: the longest lists first, then long texts, then whole values,
 * and it says where it cut, so the rest can be read (`oui.read`, §7.3.10).
 *
 * The cuts are made by rule, in a fixed order, so the same state under the
 * same budget is always shortened the same way.
 */
import { jsonBytes } from "./index-form.js";
import type { OUIFitCut, OUIObservationSnapshot } from "./types.js";

/** Rows a list keeps at each step of fitting, until the whole fits. */
export const FIT_LIST_STEPS = [200, 50, 20, 5, 0] as const;
/** Characters a text keeps once lists alone did not make the whole fit. */
export const FIT_TEXT_CHARS = 2_000;

/** One step into a JSON Pointer (RFC 6901). */
export function pointerStep(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** The steps of a JSON Pointer; "" is no steps. Throws on a pointer that does not start with "/". */
export function pointerSteps(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/"))
    throw new Error(
      `"${pointer}" is not a JSON Pointer: it must be "" or start with "/"`,
    );
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The value a pointer names inside `value`, or `undefined` when nothing is there. */
export function atPointer(value: unknown, pointer: string): unknown {
  let at: unknown = value;
  for (const step of pointerSteps(pointer)) {
    if (Array.isArray(at)) {
      at = /^(0|[1-9]\d*)$/.test(step) ? at[Number(step)] : undefined;
    } else if (at && typeof at === "object") {
      at = Object.prototype.hasOwnProperty.call(at, step)
        ? (at as Record<string, unknown>)[step]
        : undefined;
    } else return undefined;
    if (at === undefined) return undefined;
  }
  return at;
}

interface Slot {
  /** The object or array holding the value. */
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  surface: string;
  observation: string;
  path: string;
}

/** Every array and string inside the observations, each with where it sits. */
function slots(
  observations: OUIObservationSnapshot,
  want: "list" | "text",
): Slot[] {
  const found: Slot[] = [];
  const walk = (
    holder: Slot["holder"],
    key: string | number,
    surface: string,
    observation: string,
    path: string,
  ) => {
    const value = (holder as Record<string | number, unknown>)[key];
    if (Array.isArray(value)) {
      if (want === "list")
        found.push({ holder, key, surface, observation, path });
      value.forEach((_, i) =>
        walk(value, i, surface, observation, pointerStep(path, i)),
      );
    } else if (value && typeof value === "object") {
      for (const k of Object.keys(value))
        walk(
          value as Record<string, unknown>,
          k,
          surface,
          observation,
          pointerStep(path, k),
        );
    } else if (typeof value === "string" && want === "text") {
      found.push({ holder, key, surface, observation, path });
    }
  };
  for (const surface of Object.keys(observations)) {
    for (const observation of Object.keys(observations[surface])) {
      walk(observations[surface], observation, surface, observation, "");
    }
  }
  return found;
}

/**
 * `observations` within `budget` bytes of JSON, and where they were cut.
 * Returned as they are when they already fit; otherwise a copy is shortened:
 * 1. every list longer than a step of `FIT_LIST_STEPS` is cut to it, a step at
 *    a time, until the whole fits;
 * 2. then every text longer than `FIT_TEXT_CHARS` is cut to that;
 * 3. then whole observation values are left out, the largest first.
 */
export function fitObservations(
  observations: OUIObservationSnapshot,
  budget: number,
): { observations: OUIObservationSnapshot; cuts: OUIFitCut[] } {
  if (jsonBytes(observations) <= budget) return { observations, cuts: [] };

  const fitted = JSON.parse(
    JSON.stringify(observations),
  ) as OUIObservationSnapshot;
  // One cut per place: a list cut twice is reported once, with its first length.
  const cuts = new Map<string, OUIFitCut>();
  const note = (
    slot: Slot,
    kind: OUIFitCut["kind"],
    total: number,
    kept: number,
  ) => {
    const id = `${slot.surface}\u0000${slot.observation}\u0000${slot.path}`;
    const prior = cuts.get(id);
    cuts.set(id, {
      surface: slot.surface,
      observation: slot.observation,
      path: slot.path,
      kind,
      total: prior ? prior.total : total,
      kept,
    });
  };
  const fits = () => jsonBytes(fitted) <= budget;

  for (const rows of FIT_LIST_STEPS) {
    for (const slot of slots(fitted, "list")) {
      const list = (slot.holder as Record<string | number, unknown>)[
        slot.key
      ] as unknown[];
      if (list.length <= rows) continue;
      note(slot, "list", list.length, rows);
      list.length = rows;
    }
    // A cut inside a row that an outer list then dropped is no longer there to read.
    for (const [id, cut] of cuts) {
      if (
        cut.kind === "list" &&
        atPointer(fitted[cut.surface]?.[cut.observation], cut.path) ===
          undefined
      )
        cuts.delete(id);
    }
    if (fits()) return { observations: fitted, cuts: [...cuts.values()] };
  }

  for (const slot of slots(fitted, "text")) {
    const text = (slot.holder as Record<string | number, unknown>)[
      slot.key
    ] as string;
    if (text.length <= FIT_TEXT_CHARS) continue;
    note(slot, "text", text.length, FIT_TEXT_CHARS);
    (slot.holder as Record<string | number, unknown>)[slot.key] = text.slice(
      0,
      FIT_TEXT_CHARS,
    );
  }
  if (fits()) return { observations: fitted, cuts: [...cuts.values()] };

  const values = Object.keys(fitted)
    .flatMap((surface) =>
      Object.keys(fitted[surface]).map((observation) => ({
        surface,
        observation,
        bytes: jsonBytes(fitted[surface][observation]),
      })),
    )
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        a.surface.localeCompare(b.surface) ||
        a.observation.localeCompare(b.observation),
    );
  for (const { surface, observation, bytes } of values) {
    if (fits()) break;
    for (const [id, cut] of cuts) {
      if (cut.surface === surface && cut.observation === observation)
        cuts.delete(id);
    }
    fitted[surface][observation] = null;
    cuts.set(`${surface}\u0000${observation}\u0000`, {
      surface,
      observation,
      path: "",
      kind: "value",
      total: bytes,
      kept: 0,
    });
  }
  return { observations: fitted, cuts: [...cuts.values()] };
}
