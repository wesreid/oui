/**
 * The bound wrappers `oui generate` emits for a tier 2 mapping (ADR-0226
 * §2.3) are built from these. Each wrapper accepts `agent`, registers the
 * mapped kind with the app's own callback through `useAgentBinding`, returns
 * that callback's result (§2.2 rule 3), reports the component's `disabled`
 * prop, and renders the third-party component unchanged: its props, its ref,
 * its static members.
 *
 * A bound export keeps the third-party component's own type, generics and
 * polymorphism included (a wrapper type cannot add a prop to a generic call
 * signature), and the bound module adds `agent` to JSX through
 * `AgentAttribute`, the way a styling library adds `css`.
 */
import {
  createContext,
  createElement,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from 'react';

import type { ControlOption, SchemaProps, Tier2Control } from '@ouispec/contract';

import type { AgentProp, AgentSlots } from './binding.js';
import { useAgentBinding, type BindingRunResult } from './react.js';
import { mappedOptions, tier2CallbackArgs } from './tier2.js';

/**
 * What the bound module lets JSX pass as `agent`: a binding, a `nonAgent`
 * reason, or a composite's slots (so a tier 1 composite's own `agent` type
 * still fits beside it). The generator holds every `agent` to the control it
 * is on.
 */
export type AgentAttribute = AgentProp | AgentSlots<string>;

const BOUND = Symbol.for('oui.tier2.bound');

/** React's own members of a component, never copied from the third-party one. */
const REACT_MEMBERS = new Set(['$$typeof', 'render', 'type', 'compare', 'displayName', 'propTypes', 'defaultProps', 'contextTypes', 'prototype', 'length', 'name', 'caller', 'arguments']);

type Props = Record<string, unknown>;

/** The visible text of rendered children, nested elements included. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** The first non-empty title the named props give; `children` is the element's text. */
function titleOf(titleProps: readonly string[] | undefined, props: Props): string {
  for (const prop of titleProps ?? []) {
    const value = prop === 'children' ? textOf(props.children as ReactNode) : props[prop];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      return String(value).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/** The props a value schema is derived from, as the mapping names them, over its defaults. */
function schemaPropsOf(control: Tier2Control, props: Props, options: ControlOption[] | null): SchemaProps {
  const out: Record<string, unknown> = { ...(control.defaults ?? {}) };
  for (const [key, prop] of Object.entries(control.schemaProps ?? {})) {
    if (typeof prop === 'string' && props[prop] !== undefined) out[key] = props[prop];
  }
  if (options) out.options = options;
  return out as SchemaProps;
}

/** One mapped control's binding, from the props the page gave it. */
function useMappedBinding(name: string, control: Tier2Control, props: Props, agent: AgentProp | undefined, items: ControlOption[] | null): void {
  const callback = control.callbacks[0];
  const options = items ?? (control.options ? mappedOptions(control.options, props[control.options.prop]) : null);
  useAgentBinding({
    agent,
    kind: control.kind,
    title: titleOf(control.titleProps, props),
    schemaProps: schemaPropsOf(control, props, options),
    value: control.controlled ? props[control.controlled] : undefined,
    disabled: props.disabled === true,
    run: ({ value }) => {
      const fn = props[callback];
      if (typeof fn !== 'function') {
        return { ok: false, code: 'NOT_WIRED', message: `${name} was given no ${callback}, so there is nothing for it to do` };
      }
      return fn(...tier2CallbackArgs(control, value)) as BindingRunResult;
    },
  });
}

/** Props with `agent` taken out, and the ref put back when there is one. */
function forwarded(rest: Props, ref: unknown): Props {
  return ref ? { ...rest, ref } : rest;
}

/** The wrapper named, marked as bound, with the third-party component's static members. */
function finish<C>(wrapper: object, original: unknown, name: string): C {
  (wrapper as { displayName?: string }).displayName = `Bound${name.replace(/\./g, '')}`;
  Object.defineProperty(wrapper, BOUND, { value: true });
  if (original && (typeof original === 'object' || typeof original === 'function')) {
    for (const key of Object.getOwnPropertyNames(original)) {
      if (REACT_MEMBERS.has(key) || key in wrapper) continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) Object.defineProperty(wrapper, key, descriptor);
    }
  }
  return wrapper as C;
}

/**
 * A bound control: the third-party `component`, registered under the
 * mapping's `kind` with the app's own callback. `name` is its export path, for
 * messages and its display name.
 */
export function boundControl<C>(component: C, name: string, control: Tier2Control): C {
  const Component = component as unknown as ElementType;
  const Bound = forwardRef<unknown, Props>(function Bound({ agent, ...rest }, ref) {
    useMappedBinding(name, control, rest, agent as AgentProp | undefined, null);
    return createElement(Component, forwarded(rest, ref));
  });
  return finish<C>(Bound, component, name);
}

interface ItemRegistry {
  set(key: object, option: ControlOption): void;
  delete(key: object): void;
}

/**
 * A compound control (Radix `Select.Root` / `Select.Item`, Mantine `Tabs` /
 * `Tabs.Tab`): the bound root registers the mapping's kind, and its options
 * are the items rendered under it, each reporting its `valueProp` and title
 * while it is mounted. Each compound has its own registry, so an item finds
 * its own root through any other compound between them.
 */
export function boundCompound<R, I>(root: R, item: I, name: string, control: Tier2Control): { root: R; item: I } {
  const part = control.parts?.item;
  if (!part) throw new Error(`${name} has no item part: bind it with boundControl`);
  const valueProp = part.valueProp ?? 'value';
  const itemTitleProps = part.titleProps ?? ['children'];
  const Items = createContext<ItemRegistry | null>(null);
  const RootComponent = root as unknown as ElementType;
  const ItemComponent = item as unknown as ElementType;

  const BoundRoot = forwardRef<unknown, Props>(function BoundRoot({ agent, ...rest }, ref) {
    const entries = useRef(new Map<object, ControlOption>());
    const [version, setVersion] = useState(0);
    const registry = useMemo<ItemRegistry>(
      () => ({
        set: (key, option) => {
          const current = entries.current.get(key);
          if (current && current.value === option.value && current.title === option.title && !!current.disabled === !!option.disabled) return;
          entries.current.set(key, option);
          setVersion(v => v + 1);
        },
        delete: key => {
          if (entries.current.delete(key)) setVersion(v => v + 1);
        },
      }),
      [],
    );
    // Recomputed on each registration (`version`), in the order the items mounted.
    const items = useMemo(() => [...entries.current.values()], [version]);
    useMappedBinding(name, control, rest, agent as AgentProp | undefined, items);
    return createElement(Items.Provider, { value: registry }, createElement(RootComponent, forwarded(rest, ref)));
  });

  const BoundItem = forwardRef<unknown, Props>(function BoundItem(props, ref) {
    const registry = useContext(Items);
    const key = useRef({}).current;
    const value = props[valueProp];
    const title = titleOf(itemTitleProps, props) || (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
    const disabled = props.disabled === true;
    useEffect(() => {
      if (registry && (typeof value === 'string' || typeof value === 'number')) registry.set(key, { value, title, ...(disabled ? { disabled } : {}) });
    }, [registry, key, value, title, disabled]);
    useEffect(() => () => registry?.delete(key), [registry, key]);
    return createElement(ItemComponent, forwarded(props, ref));
  });

  return {
    root: finish<R>(BoundRoot, root, `${name}.root`),
    item: finish<I>(BoundItem, item, `${name}.item`),
  };
}

/**
 * A namespace or component with some members replaced by bound parts
 * (`Select` with its `Root` and `Item`, or a bound `Tabs` with its `Tab`),
 * every other member kept. A module namespace or a third-party component is
 * never changed: a new object, or a pass-through component, carries the
 * members.
 */
export function withMembers<B>(base: B, members: Readonly<Record<string, unknown>>): B {
  let target: Record<string, unknown>;
  if (typeof base === 'function' || (base && typeof base === 'object' && '$$typeof' in (base as object))) {
    if ((base as Record<symbol, unknown>)[BOUND]) target = base as unknown as Record<string, unknown>;
    else {
      const Component = base as unknown as ElementType;
      const PassThrough = forwardRef<unknown, Props>(function PassThrough(props, ref) {
        return createElement(Component, forwarded(props, ref));
      });
      target = finish<Record<string, unknown>>(PassThrough, base, 'Namespace');
    }
  } else {
    target = { ...(base as Record<string, unknown>) };
  }
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return target as unknown as B;
}
