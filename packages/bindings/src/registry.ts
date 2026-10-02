/**
 * The tab's record of what is mounted right now (ADR-0220 §2.2): every bound
 * control with its real handler, and every room with its catalog and context.
 *
 * Controls register when they mount and leave when they unmount, so the
 * registry is exactly what a person could use on screen. An adapter
 * (`./oui`) turns it, with the build's generated manifest, into the tab's OUI
 * surfaces.
 *
 * Plain TypeScript: no React, no OUI runtime.
 */

import type { AgentItem } from './binding.js';
import type { AnyControlKind } from './controls.js';
import type { JsonSchema } from './json-schema.js';
import type { RoomCatalogData, RoomProblem, RoomResult } from './room.js';

/** One mounted bound control. */
export interface ControlRegistration {
  /** The binding id. */
  id: string;
  kind: AnyControlKind;
  /** What the control is called on screen. */
  title: string;
  /** The live schema of its value (no `item`), derived from its live props; null for a button or dialog. */
  valueSchema: JsonSchema | null;
  /** Which row, when it is one of a list's. */
  item?: AgentItem;
  /** Its current value, for the page's observation. */
  value?: unknown;
  /** It cannot be used right now; its action is not offered. */
  disabled?: boolean;
  /** Does what the person's gesture does, with `value` for a field. */
  run(input: { value?: unknown }): RoomResult | Promise<RoomResult>;
}

/** One mounted room. */
export interface RoomRegistration {
  /** The room's catalog (a `RoomCatalog` is one): which room it is, and what it declares. */
  catalog: RoomCatalogData;
  /** Runs one of the catalog's actions by id, through the room's own entry — as the room's controller does. */
  run(actionId: string, input: Record<string, unknown>): RoomResult | Promise<RoomResult>;
}

/** What changed: what can be done (`structure`), or only what the page shows (`values`). */
export type RegistryChange = 'structure' | 'values';

export interface ControlHandle {
  /** New live facts about the control. A change of title, schema, row or disabled changes what can be done. */
  update(patch: Partial<Omit<ControlRegistration, 'id' | 'kind' | 'run'>>): void;
  unregister(): void;
}

export interface RoomHandle {
  /** The current value of one of the catalog's observations. */
  setObservation(id: string, value: unknown): void;
  /** The room's problems, as its banners show them. */
  setProblems(problems: readonly RoomProblem[]): void;
  unregister(): void;
}

/** Problems a page shows that are not a room's: an asset that failed to load, a render that failed. */
export interface ProblemHandle {
  set(problems: readonly RoomProblem[]): void;
  unregister(): void;
}

/**
 * What a page shows that is not a control: a clip's model and seed, a job's
 * cost. Read-only facts, by label, reported in the page state so the
 * assistant reads what the person reads.
 */
export interface ShownFacts {
  /** The binding id of the display that shows them. */
  id: string;
  /** Its heading, as the page shows it. */
  title: string;
  /** Each fact's value as text, by its label. */
  facts: Readonly<Record<string, string>>;
  /** Which row of a list it describes, when it is one of many. */
  item?: AgentItem;
}

export interface FactsHandle {
  set(value: ShownFacts): void;
  unregister(): void;
}

export interface BindingRegistry {
  registerControl(registration: ControlRegistration): ControlHandle;
  registerRoom(registration: RoomRegistration): RoomHandle;
  /** Problems shown on the page, by the binding id of the page area that shows them. */
  registerProblems(source: string): ProblemHandle;
  /** Facts a page shows, by display. */
  registerFacts(): FactsHandle;
  /** Every shown display's facts, oldest first. */
  facts(): readonly ShownFacts[];
  /** Every mounted control, oldest first. */
  controls(): readonly ControlRegistration[];
  /** Every mounted room, with its observation values and problems. */
  rooms(): readonly {
    registration: RoomRegistration;
    observations: Readonly<Record<string, unknown>>;
    problems: readonly RoomProblem[];
  }[];
  /** Every page problem, by source. */
  problems(): Readonly<Record<string, readonly RoomProblem[]>>;
  subscribe(listener: (change: RegistryChange) => void): () => void;
}

export function createBindingRegistry(): BindingRegistry {
  const controls: ControlRegistration[] = [];
  const rooms: {
    registration: RoomRegistration;
    observations: Record<string, unknown>;
    problems: readonly RoomProblem[];
  }[] = [];
  const pageProblems = new Map<string, readonly RoomProblem[]>();
  const shown: { value: ShownFacts | null }[] = [];
  const listeners = new Set<(change: RegistryChange) => void>();

  // Changes arrive in bursts (a page mounting fifty controls); listeners hear
  // one notification per burst, the strongest change in it.
  let pending: RegistryChange | null = null;
  const notify = (change: RegistryChange) => {
    const flush = pending === null;
    if (pending !== 'structure') pending = change;
    if (!flush) return;
    queueMicrotask(() => {
      const c = pending!;
      pending = null;
      for (const l of [...listeners]) l(c);
    });
  };

  return {
    registerControl(registration) {
      const entry: ControlRegistration = { ...registration };
      controls.push(entry);
      notify('structure');
      return {
        update(patch) {
          if (!controls.includes(entry)) return;
          const structural =
            ('title' in patch && patch.title !== entry.title) ||
            ('disabled' in patch && !!patch.disabled !== !!entry.disabled) ||
            ('item' in patch && !sameItem(patch.item, entry.item)) ||
            ('valueSchema' in patch &&
              JSON.stringify(patch.valueSchema) !== JSON.stringify(entry.valueSchema));
          const valueChanged = 'value' in patch && !Object.is(patch.value, entry.value);
          Object.assign(entry, patch);
          if (structural) notify('structure');
          else if (valueChanged) notify('values');
        },
        unregister() {
          const i = controls.indexOf(entry);
          if (i === -1) return;
          controls.splice(i, 1);
          notify('structure');
        },
      };
    },

    registerRoom(registration) {
      const entry = {
        registration,
        observations: {} as Record<string, unknown>,
        problems: [] as readonly RoomProblem[],
      };
      rooms.push(entry);
      notify('structure');
      return {
        setObservation(id, value) {
          if (Object.is(entry.observations[id], value)) return;
          entry.observations[id] = value;
          notify('values');
        },
        setProblems(problems) {
          if (JSON.stringify(problems) === JSON.stringify(entry.problems)) return;
          entry.problems = problems;
          notify('values');
        },
        unregister() {
          const i = rooms.indexOf(entry);
          if (i === -1) return;
          rooms.splice(i, 1);
          notify('structure');
        },
      };
    },

    registerProblems(source) {
      return {
        set(problems) {
          // Nothing changed, none before and none now included: a banner with nothing wrong says nothing.
          const before = pageProblems.get(source) ?? [];
          if (JSON.stringify(before) === JSON.stringify(problems)) return;
          if (problems.length) pageProblems.set(source, problems);
          else pageProblems.delete(source);
          notify('values');
        },
        unregister() {
          if (pageProblems.delete(source)) notify('values');
        },
      };
    },

    registerFacts() {
      const entry: { value: ShownFacts | null } = { value: null };
      shown.push(entry);
      return {
        set(value) {
          if (JSON.stringify(value) === JSON.stringify(entry.value)) return;
          entry.value = value;
          notify('values');
        },
        unregister() {
          const i = shown.indexOf(entry);
          if (i === -1) return;
          shown.splice(i, 1);
          if (entry.value) notify('values');
        },
      };
    },

    controls: () => controls,
    facts: () => shown.flatMap(e => (e.value ? [e.value] : [])),
    rooms: () => rooms,
    problems: () => Object.fromEntries(pageProblems),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sameItem(a: AgentItem | undefined, b: AgentItem | undefined): boolean {
  return a?.key === b?.key && a?.title === b?.title;
}
