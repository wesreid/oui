/**
 * Mounting an example under a binding registry, in whatever test runner and
 * DOM the integrator uses (jsdom, happy-dom, a browser), and the context an
 * example is written against: the bindings to pass, and the callbacks whose
 * calls and results the kit watches.
 */
import { act, createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { createBindingRegistry, type AgentBinding, type BindingRegistry, type ControlRegistration, type RoomResult } from '@ouispec/bindings';
import { AgentBindingProvider } from '@ouispec/bindings/react';

/** Providers the integrator's controls need around them: a theme, an overlay layer. */
export type Wrapper = ComponentType<{ children: ReactNode }>;

/** One example of a control, or several states of it, which together show every part it binds. */
export type ExampleElements = ReactElement | readonly ReactElement[];

/**
 * How an example of a control is written: render the control the way a page
 * uses it, with the bindings and callbacks the context gives.
 *
 * ```tsx
 * Button: ({ agent, on }) => <Button agent={agent()} onClick={on('onClick')}>Save</Button>,
 * Card: ({ slots, agent, on }) => (
 *   <Card agent={slots()} onOpen={on('onOpen')} onDelete={on('onDelete')}
 *     menuItems={[{ label: 'Rename', onClick: on('onClick'), agent: agent('entries') }]} />
 * ),
 * ```
 */
export type ControlExample =
  | ((ctx: ExampleContext) => ExampleElements)
  | {
      render: (ctx: ExampleContext) => ExampleElements;
      /** The value to run a part with, by part (`self`, a slot, `entries`), where the kit's own sample would not do. */
      values?: Readonly<Record<string, unknown>>;
    };

export interface ExampleContext {
  /** The binding for the control itself (`self`, the default), one of its slots, or its `entries`. */
  agent(part?: string): AgentBinding;
  /** The `agent` prop of a composite: a binding for each of the slots its table entry declares. */
  slots(): Record<string, AgentBinding>;
  /**
   * The consumer's callback, named as the table names it (`onClick`, or a
   * non-function callback such as `action` or `print`, for the function the
   * control calls through it). The kit records each call, and the callback
   * returns what the kit plans: the result `run` must hand back.
   */
  on(callback: string): (...args: unknown[]) => unknown;
}

/** The binding id the kit gives a control's part: `kit.<export>.<part>`, lower-kebab. */
export function kitBindingId(exportName: string, part: string): string {
  return `kit.${kebab(exportName)}.${kebab(part)}`;
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

export interface ExampleRun {
  ctx: ExampleContext;
  /** Each callback's calls, by the name the example gave it. */
  calls: Map<string, unknown[][]>;
  /** What the next call of any callback returns. */
  plan(result: unknown): void;
}

export function exampleContext(exportName: string, slotNames: readonly string[]): ExampleRun {
  const calls = new Map<string, unknown[][]>();
  let planned: unknown = undefined;
  const agent = (part = 'self'): AgentBinding => ({
    id: kitBindingId(exportName, part),
    description: `The conformance kit's binding of ${exportName}${part === 'self' ? '' : `'s ${part}`}`,
  });
  return {
    ctx: {
      agent,
      slots: () => Object.fromEntries(slotNames.map(slot => [slot, agent(slot)])),
      on: callback => (...args: unknown[]) => {
        const list = calls.get(callback) ?? [];
        list.push(args);
        calls.set(callback, list);
        return planned;
      },
    },
    calls,
    plan: result => {
      planned = result;
    },
  };
}

export function exampleRender(example: ControlExample): (ctx: ExampleContext) => ExampleElements {
  return typeof example === 'function' ? example : example.render;
}

export function exampleValue(example: ControlExample, part: string): { given: boolean; value?: unknown } {
  if (typeof example === 'function' || !example.values || !(part in example.values)) return { given: false };
  return { given: true, value: example.values[part] };
}

export interface Mounted {
  registry: BindingRegistry;
  unmount(): Promise<void>;
}

/** Mount `element` under a fresh registry and the integrator's providers, and let it settle. */
export async function mount(element: ReactElement, wrapper?: Wrapper): Promise<Mounted> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof document === 'undefined') {
    throw new Error('The OUI conformance kit renders controls: run it in a DOM environment (jsdom, happy-dom or a browser)');
  }
  const registry = createBindingRegistry();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const inner = wrapper ? createElement(wrapper, null, element) : element;
  await act(async () => {
    root.render(createElement(AgentBindingProvider, { registry }, inner));
  });
  await act(async () => {});
  return {
    registry,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Run a registration as the assistant would, inside `act`, and return what it returned. */
export async function runRegistration(registration: ControlRegistration, value: unknown): Promise<RoomResult> {
  let result: RoomResult = { ok: false, code: 'NOT_RUN', message: 'did not run' };
  await act(async () => {
    result = await registration.run(value === undefined ? {} : { value });
  });
  return result;
}

/** Deep equality of JSON-like values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter(k => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
