## Tier 1: a design system you own

A tier 1 design system is conformant when all of these hold, and the conformance kit checks each:

1. **Every interactive export accepts `agent?: AgentProp`**, or `AgentSlots<…>` for a composite with several controls. `AgentProp` is an `AgentBinding`, or `{ nonAgent: "<reason>" }` for a control the assistant must never operate; the reason is required.
2. **Every interactive export calls `useAgentBinding` (or `useAgentBindings`)** with the kind its table entry declares, and with the handler the person's gesture fires.
3. **Every binding's `run` returns what the consumer's callback returned.** A handler that starts a job returns `{ ok: true, pending: { jobId } }`; if the control drops it, the job action can never settle.
4. **The control table is generated at build time** from the package's own declaration, shipped in the package, and named in its `package.json` under `oui.agentControls`. `closure.agentControls` is read during the transition; declaring both is an error.
5. **The input schema is derived from props**, by the same function in the browser and in the generator. A live schema may narrow the generated one but never widen it.

### Worked example

A button and a select, bound:

```tsx
import { useAgentBinding, type BindingRunResult } from '@ouispec/bindings/react';
import type { AgentProp } from '@ouispec/bindings';

export function Button({ children, disabled, onClick, agent }: ButtonProps & { agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'button',
    title: String(children ?? ''),
    disabled,
    // Rule 3: hand back what the app's handler returned.
    run: () => onClick?.() as BindingRunResult,
  });
  return <button disabled={disabled} onClick={onClick}>{children}</button>;
}

export function Select({ label, value, options, onChange, agent }: SelectProps & { agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'choice',
    title: label,
    value,
    // The schema is derived from the live options; never written by hand.
    schemaProps: { options: options.map(o => ({ value: o.value, title: o.label })) },
    run: ({ value: next }) => onChange?.(next as string) as BindingRunResult,
  });
  return /* … */;
}
```

The table the generator reads, declared next to the controls and written to `dist/agent-controls.json` by the build (`stableStringify` from `@ouispec/bindings` keeps it byte-stable):

```ts
import type { ControlTableFile } from '@ouispec/bindings';

export const AGENT_CONTROLS: ControlTableFile = {
  Button: { kind: 'button', callbacks: ['onClick'], titleProps: ['aria-label', 'children'] },
  Select: { kind: 'choice', callbacks: ['onChange'], options: { prop: 'options', value: 'value', title: 'label' }, titleProps: ['label'] },
};
```

```json
{ "name": "@acme/ui", "oui": { "agentControls": "./dist/agent-controls.json" } }
```

A page then declares what each use means, with values the generator can read without running the code:

```tsx
<Button
  agent={{ id: 'orders.place', description: 'Send the order to the exchange', effect: { kind: 'transaction', operation: 'placeOrder' } }}
  onClick={placeOrder}
>
  Place order
</Button>
```

<!-- schema: agent-binding.json -->

**Binding values are build-time constants.** The generator reads them from source: a literal, a `const` it can follow, a property of a constant object, a template literal or `+` over those, or a single-literal type read through the type checker. A value built by a call (`t('save')`) fails the build, naming the binding. A field's `hint` and `placeholder` join its tool description the same way.

**Rows.** A control rendered once per row of a list carries `item: { key, title, description? }`. `description` says what the row is when only the running app knows (a model's parameters). The action then takes the row as `item`.

<!-- schema: agent-binding.json#/$defs/AgentItem -->

### The control table

<!-- schema: control-table.json#/$defs/ControlDescriptor -->

A composite with several callbacks names each in `slots`; an array prop whose entries carry their own `agent` (menu items, toolbar items) is `entries`; a dialog or tab set that shows a panel is a `container`; a component that reports what it shows (`useAgentFacts`) is a `display`.

**Displays.** Everything that reports facts is declared, so the manifest records every display a page shows. A component that only shows facts (a stat, a description list) is a `display` and nothing else: a use without a binding is not unbound. A control or composite that also reports what it shows keeps its `kind`, `slots` or `entries` beside `display`: a card bound to open reports under the same binding, as the same row; a composite reports under its `slot` binding (`agent={{ facts: { id, description } }}`) when the page gives one, else under the first of its `parts` the page bound. A display that reports for the displays inside it (a scope a dashboard's tiles report as rows of) is a `display` too. The app's own `useAgentFacts` calls need no declaration: the generator reads each where the page reaches it, in a component or an app hook, and follows its binding through the props that pass it down to where it is written. A display's id may be its control's (the rows it acts on) or its own shown from several places, described the same way everywhere.

<!-- schema: control-table.json#/$defs/SlotDescriptor -->

### Adding a control kind

`ControlKind` is closed. A design system adds a kind only by registering it under an `x-` name, with the verb its tools start with and how its value schema follows from props, as data. The registration ships under `$kinds` in the control table, where the generator reads it, and the package calls `registerControlKind` with the same object at run time.

```ts
export const PRICE_RANGE: ControlKindRegistration = {
  kind: 'x-price-range',
  verb: 'Set the price band of',
  deriveSchema: {
    schema: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
    props: { '/properties/low/minimum': 'min', '/properties/high/maximum': 'max' },
  },
};
```

<!-- schema: control-kind-registration.json -->
