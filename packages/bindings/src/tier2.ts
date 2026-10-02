/**
 * Tier 2 (ADR-0226 §2.3): what a mapping of a third-party design system
 * means, as the generator reads it and the bound wrappers run it.
 *
 * - `tier2ControlTable`: the control table a mapping makes, which the bound
 *   module ships and the generator reads exactly as it reads a tier 1 table.
 * - `tier2Parts`: where a control's root and items are exported.
 * - `mappedOptions`: a control's options from the prop its mapping names.
 * - `tier2CallbackArgs`: the arguments the app's callback gets when the
 *   assistant sets a value, built from `valueFrom`.
 *
 * Pure and dependency-free: the generator reads it in plain Node, and the
 * React wrappers (`@ouispec/bindings/react`) run the same code.
 */
import type { ControlDescriptor, ControlOption, ControlTableFile, OptionsSource, Tier2Control, Tier2Mapping } from '@ouispec/contract';

/** The kinds that take no value, so their mapping needs no `valueFrom`. */
const VALUELESS = new Set(['button', 'dialog']);

/** Whether a mapped control's binding runs with a value. */
export function tier2TakesValue(control: Tier2Control): boolean {
  return !VALUELESS.has(control.kind);
}

/**
 * Where a mapped control is exported: its root (the export that takes the
 * callbacks; the control's own name when it has no parts) and, for a compound
 * control, its item. Each is an export of the package or one member of one.
 */
export function tier2Parts(name: string, control: Tier2Control): { root: string; item?: string } {
  return { root: control.parts?.root.export ?? name, ...(control.parts?.item ? { item: control.parts.item.export } : {}) };
}

/**
 * How the generator reads one mapped control where a page uses it: its
 * mapping as a control table entry. A tabs or dialog control whose mapping
 * names the prop that shows it is a container of that state, as a tier 1
 * table declares one, so what it shows is reached through it.
 */
export function tier2Descriptor(control: Tier2Control): ControlDescriptor {
  const container =
    control.controlled && (control.kind === 'tabs' || control.kind === 'dialog')
      ? { container: { kind: control.kind, stateProp: control.controlled } }
      : {};
  return {
    kind: control.kind,
    callbacks: [...control.callbacks],
    titleProps: [...(control.titleProps ?? [])],
    ...(control.schemaProps ? { schemaProps: { ...control.schemaProps } } : {}),
    ...(control.options ? { options: { ...control.options } } : {}),
    ...(control.defaults ? { defaults: { ...control.defaults } } : {}),
    ...container,
  };
}

/** The control table a mapping makes: one entry per mapped control, under its name. */
export function tier2ControlTable(mapping: Tier2Mapping): ControlTableFile {
  const table: Record<string, ControlDescriptor> = {};
  for (const [name, control] of Object.entries(mapping.controls)) table[name] = tier2Descriptor(control);
  return table as ControlTableFile;
}

/**
 * A control's options from the value of the prop its mapping names: each
 * entry an object with the named value and title keys, a string or number
 * (its own title), or a group (an object with an `items` array of entries,
 * and no value of its own). `null` when any entry cannot be read, so a
 * schema is never narrower than the control.
 */
export function mappedOptions(source: OptionsSource, raw: unknown): ControlOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ControlOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      out.push({ value: entry, title: String(entry) });
      continue;
    }
    if (!entry || typeof entry !== 'object') return null;
    const rec = entry as Record<string, unknown>;
    const value = rec[source.value];
    if (value === undefined && Array.isArray(rec.items)) {
      const group = mappedOptions(source, rec.items);
      if (!group) return null;
      out.push(...group);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const title = rec[source.title];
    out.push({
      value,
      title: typeof title === 'string' && title.trim() ? title : String(value),
      ...(rec.disabled === true ? { disabled: true } : {}),
    });
  }
  return out;
}

/**
 * What a binding hands a callback where the third-party component would hand
 * it an event: shaped like one, so a handler that calls `preventDefault`
 * runs, and `isTrusted: false`, as for any event a script makes.
 */
export interface AgentEvent {
  readonly type: 'oui-agent';
  readonly isTrusted: false;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  persist(): void;
  [key: string]: unknown;
}

/** A fresh event-shaped argument (`AgentEvent`). */
export function agentEvent(): AgentEvent {
  let prevented = false;
  return {
    type: 'oui-agent',
    isTrusted: false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
    persist() {},
  };
}

/**
 * The arguments the app's callback gets when the assistant runs a mapped
 * control. A control that takes a value gets it where `valueFrom` says the
 * third-party component puts it: at its argument position, or at `path`
 * inside an event-shaped argument there; every argument before it is an
 * event-shaped argument. A button or a dialog gets one event-shaped argument.
 */
export function tier2CallbackArgs(control: Tier2Control, value: unknown): unknown[] {
  if (!tier2TakesValue(control) || !control.valueFrom) return [agentEvent()];
  const { arg, path } = control.valueFrom;
  const args: unknown[] = [];
  for (let i = 0; i < arg; i++) args.push(agentEvent());
  if (!path) {
    args.push(value);
    return args;
  }
  const event = agentEvent();
  const keys = path.split('.');
  let node: Record<string, unknown> = event;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value;
    else {
      const next: Record<string, unknown> = {};
      node[key] = next;
      node = next;
    }
  });
  args.push(event);
  return args;
}
