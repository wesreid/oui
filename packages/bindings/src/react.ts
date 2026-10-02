/**
 * React side of the binding (ADR-0220 §2.2): how a design-system control
 * registers its real handler, and how a room registers its catalog.
 *
 * A control calls `useAgentBinding` with its `agent` prop, its kind, its live
 * props and the function its own gesture calls. Without a provider (the
 * showcase, a test, any app with no assistant) nothing registers and the
 * control behaves exactly as before.
 */

import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';

import { isAgentBinding, isNonAgent, type AgentProp } from './binding.js';
import { deriveValueSchema, type AnyControlKind, type SchemaProps } from './controls.js';
import type { BindingRegistry, ControlHandle, RoomHandle } from './registry.js';
import type { RoomCatalogData, RoomProblem, RoomResult } from './room.js';

const RegistryContext = createContext<BindingRegistry | null>(null);

export interface AgentBindingProviderProps {
  registry: BindingRegistry;
  children?: ReactNode;
}

/** Makes one binding registry available to every bound control below it. */
export function AgentBindingProvider({ registry, children }: AgentBindingProviderProps) {
  return createElement(RegistryContext.Provider, { value: registry }, children);
}

/** The registry from the nearest provider, or null when there is none. */
export function useAgentBindingRegistry(): BindingRegistry | null {
  return useContext(RegistryContext);
}

/** What a control's handler may return: nothing (it worked), or a result saying what happened. */
export type BindingRunResult = RoomResult | void;

export interface AgentBindingSpec {
  /** The control's `agent` prop, as the page passed it. */
  agent: AgentProp | undefined | null;
  kind: AnyControlKind;
  /** What the control is called on screen, from its own props. */
  title: string;
  /** The live props its schema is derived from. */
  schemaProps?: SchemaProps;
  /** Its current value, for the page's observation. */
  value?: unknown;
  /** It cannot be used right now. */
  disabled?: boolean;
  /** Does what the person's gesture does. */
  run: (input: { value?: unknown }) => BindingRunResult | Promise<BindingRunResult>;
}

/** Register one bound control for as long as it is mounted. */
export function useAgentBinding(spec: AgentBindingSpec): void {
  useAgentBindings([spec]);
}

/**
 * Register several bound controls at once: a composite's slots, or the
 * entries of a toolbar, menu or selection bar. The list may change length
 * between renders.
 */
export function useAgentBindings(specs: readonly AgentBindingSpec[]): void {
  const registry = useContext(RegistryContext);
  const specsRef = useRef(specs);
  specsRef.current = specs;

  const signature = specs
    .map(s => (isAgentBinding(s.agent) ? `${s.agent.id}\u0000${s.agent.item?.key ?? ''}\u0000${s.kind}` : ''))
    .join('\u0001');

  const handles = useRef<(ControlHandle | null)[]>([]);

  useEffect(() => {
    if (!registry) return;
    const current = specsRef.current;
    handles.current = current.map((spec, index) => {
      const agent = spec.agent;
      if (!isAgentBinding(agent)) return null;
      return registry.registerControl({
        id: agent.id,
        kind: spec.kind,
        title: agent.title ?? spec.title,
        valueSchema: deriveValueSchema(spec.kind, spec.schemaProps),
        item: agent.item,
        value: spec.value,
        disabled: spec.disabled,
        run: input => runSafely(() => specsRef.current[index].run(input)),
      });
    });
    return () => {
      for (const h of handles.current) h?.unregister();
      handles.current = [];
    };
  }, [registry, signature]);

  // Keep what the registry knows about each control current: its title,
  // schema, row, value and whether it can be used.
  useEffect(() => {
    specs.forEach((spec, index) => {
      const handle = handles.current[index];
      if (!handle || !isAgentBinding(spec.agent)) return;
      handle.update({
        title: spec.agent.title ?? spec.title,
        valueSchema: deriveValueSchema(spec.kind, spec.schemaProps),
        item: spec.agent.item,
        value: spec.value,
        disabled: spec.disabled,
      });
    });
  });
}

async function runSafely(run: () => BindingRunResult | Promise<BindingRunResult>): Promise<RoomResult> {
  try {
    // A callback typed `() => void` may still return something (an array's
    // `push` returns its length); only a real result says what happened.
    const result: unknown = await run();
    return isRoomResult(result) ? result : { ok: true };
  } catch (err) {
    return { ok: false, code: 'FAILED', message: err instanceof Error ? err.message : String(err) };
  }
}

function isRoomResult(value: unknown): value is RoomResult {
  return !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean';
}

export interface UseRoomRegistrationOptions {
  /** Runs one of the catalog's actions by id, through the room's own entry (the room controller's `run`). */
  run: (actionId: string, input: Record<string, unknown>) => RoomResult | Promise<RoomResult>;
  /** The current values of the catalog's observations, by id. */
  observations: Readonly<Record<string, unknown>>;
  /** What the room's banners show is wrong. */
  problems: readonly RoomProblem[];
  /** Register only while true. Default true. */
  active?: boolean;
}

/** Register a room's catalog for as long as the room is mounted. */
export function useRoomRegistration(catalog: RoomCatalogData, options: UseRoomRegistrationOptions): void {
  const registry = useContext(RegistryContext);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const handle = useRef<RoomHandle | null>(null);
  const active = options.active ?? true;

  useEffect(() => {
    if (!registry || !active) return;
    handle.current = registry.registerRoom({
      catalog,
      run: (id, input) => optionsRef.current.run(id, input),
    });
    return () => {
      handle.current?.unregister();
      handle.current = null;
    };
  }, [registry, catalog, active]);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const [id, value] of Object.entries(options.observations)) h.setObservation(id, value);
    h.setProblems(options.problems);
  });
}

/**
 * Report the problems a page area shows (an asset that failed to load, a
 * render that failed), under the binding id of the area that shows them.
 */
export function useAgentProblems(source: string, problems: readonly RoomProblem[]): void {
  const registry = useContext(RegistryContext);
  const handle = useRef<ReturnType<BindingRegistry['registerProblems']> | null>(null);
  useEffect(() => {
    if (!registry) return;
    handle.current = registry.registerProblems(source);
    return () => {
      handle.current?.unregister();
      handle.current = null;
    };
  }, [registry, source]);
  useEffect(() => {
    handle.current?.set(problems);
  });
}

/**
 * Reports what a display shows: its facts, by label, as text. The design
 * system's displays call this with their `agent` binding; a page reports its
 * own facts the same way.
 */
export function useAgentFacts(
  agent: AgentProp | undefined,
  title: string,
  facts: Readonly<Record<string, string | number | boolean | null | undefined>>,
): void {
  const registry = useContext(RegistryContext);
  const handle = useRef<ReturnType<BindingRegistry['registerFacts']> | null>(null);
  const bound = agent && !isNonAgent(agent) && isAgentBinding(agent) ? agent : null;
  useEffect(() => {
    if (!registry || !bound) return;
    handle.current = registry.registerFacts();
    return () => {
      handle.current?.unregister();
      handle.current = null;
    };
  }, [registry, !!bound]);
  useEffect(() => {
    if (!bound) return;
    const text: Record<string, string> = {};
    for (const [label, value] of Object.entries(facts)) {
      if (value !== null && value !== undefined && value !== '') text[label] = String(value);
    }
    handle.current?.set({
      id: bound.id,
      title: bound.title ?? title,
      facts: text,
      ...(bound.item ? { item: bound.item } : {}),
    });
  });
}

// Tier 2 (ADR-0226 §2.3): what the bound wrappers `oui generate` emits are built from.
export { boundCompound, boundControl, withMembers, type AgentAttribute } from './tier2-react.js';
