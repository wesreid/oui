<!-- GENERATED FILE — DO NOT EDIT. Generated from guide/*.md and schemas/*.json by @ouispec/contract (contract major 1).
     Edit the sections or the schemas, then: pnpm generate (in packages/contract). -->

# OUI integrator guide

**For:** engineers plugging a React product into the OUI agent platform, so its assistant can do everything the product's UI lets a person do, through the same code paths the person uses.
**Specified by:** ADR-0226 (the integrator contract), ADR-0227 (the reference architecture) and ADR-0228 (approvals). This guide replaces ADR-0139's dispatch mechanics, which no longer describe how the platform works.

## How it fits together

The assistant never gets a hand-written list of what it can do. A build step, `oui generate`, reads the app's own code — its routes, the controls each page renders, the room catalogs of its editors and its API's OpenAPI document — and writes two files: a **manifest** of every action and observation the UI offers, and **knowledge** describing them. At run time each control registers its real handler while it is mounted, and the tab offers the assistant exactly the actions the manifest declares *and* the page has on screen. The assistant and the person go through one code path.

A product plugs its UI in through one or more of three tiers, combinable in one app:

| Tier | When | The product provides | Section |
|---|---|---|---|
| 1. Native design system | It owns its design system | `agent` props, `useAgentBinding` calls, a control table | [Tier 1](#tier-1-a-design-system-you-own) |
| 2. Third-party design system | It uses one it does not own (MUI, Mantine, shadcn/Radix) | A mapping file; the generator emits bound wrappers | [Tier 2](#tier-2-a-design-system-you-do-not-own) |
| 3. Rooms | Custom editors: canvases, charts, timelines, players | A room catalog of actions, fields, commands and observations | [Tier 3](#tier-3-rooms) |

## The packages

| Package | What it is |
|---|---|
| `@ouispec/contract` | The JSON Schemas below, the TypeScript types generated from them, a validator (`/validate`), and this guide. |
| `@ouispec/bindings` | The binding (`useAgentBinding`, `useRoomRegistration` from `/react`), the registry, and `connectBindings` (from `/oui`), which turns what is mounted into the tab's OUI surfaces. |
| `@ouispec/cli` | The `oui generate [--check]` CLI (also installed as `closure-oui`). |
| `@ouispec/testing` | The conformance kit. |
| `oui-spec` | The OUI surface runtime, protocol and approval rules every package above builds on. |

They are published to the public npm registry from the open [`oui` repository](https://github.com/wesreid/oui), by its CI, with provenance. The schema URLs below are the same as before the packages were public.

## Versions

Every schema of the contract is versioned together by `MANIFEST_VERSION`, and that major is in each schema's `$id` (`…/oui/v1/…`). A breaking change to any schema bumps it. Pin the contract major, and run the conformance kit in CI: it is the compatibility gate. The packages stay below 1.0 until the first outside product is live.

## The schemas

| Schema | TypeScript | `$id` |
|---|---|---|
| [`json-schema.json`](schemas/json-schema.json) | `JsonSchema` | `https://schemas.closurestudio.ai/oui/v1/json-schema.json` |
| [`action-effect.json`](schemas/action-effect.json) | `ActionEffect` | `https://schemas.closurestudio.ai/oui/v1/action-effect.json` |
| [`agent-binding.json`](schemas/agent-binding.json) | `AgentBinding` | `https://schemas.closurestudio.ai/oui/v1/agent-binding.json` |
| [`control-kind-registration.json`](schemas/control-kind-registration.json) | `ControlKindRegistration` | `https://schemas.closurestudio.ai/oui/v1/control-kind-registration.json` |
| [`control-table.json`](schemas/control-table.json) | `ControlTableFile` | `https://schemas.closurestudio.ai/oui/v1/control-table.json` |
| [`tier2-mapping.json`](schemas/tier2-mapping.json) | `Tier2Mapping` | `https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json` |
| [`room-catalog-data.json`](schemas/room-catalog-data.json) | `RoomCatalogData` | `https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json` |
| [`oui-manifest.json`](schemas/oui-manifest.json) | `OuiManifest` | `https://schemas.closurestudio.ai/oui/v1/oui-manifest.json` |
| [`generated-knowledge.json`](schemas/generated-knowledge.json) | `GeneratedKnowledge` | `https://schemas.closurestudio.ai/oui/v1/generated-knowledge.json` |
| [`oui-config.json`](schemas/oui-config.json) | `OuiConfigFile` | `https://schemas.closurestudio.ai/oui/v1/oui-config.json` |
| [`approvals.json`](schemas/approvals.json) | its 19 `$defs`, one type each | `https://schemas.closurestudio.ai/oui/v1/approvals.json` |
| [`event-declarations.json`](schemas/event-declarations.json) | `EventDeclarationDocument` | `https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json` |

Validate any of these files in a build step with `contractProblems(ref, value)` from `@ouispec/contract/validate`, where `ref` is a file name (`control-table.json`) or a generated type's name (`ControlDescriptor`). The generator already validates every control table, room catalog, `oui.config.json`, manifest and knowledge it reads or writes, and fails the build on any problem.

## Tier 1: a design system you own

A tier 1 design system is conformant when all of these hold (ADR-0226 §2.2), and the conformance kit checks each:

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

> **Schema:** [`agent-binding.json`](schemas/agent-binding.json) · `https://schemas.closurestudio.ai/oui/v1/agent-binding.json` · TypeScript: `AgentBinding` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `id` | string | yes | Stable, globally unique, dotted and lower-kebab: `voices.library`, `voices.detail.engine`. |
> | `title` | string |  | Defaults to the control's visible label or aria-label. |
> | `description` | string | yes | What using it does, for someone who cannot see the screen. |
> | `effect` | ActionEffect |  | What using it does: what reach paths, data and verification are derived from (ADR-0226 §2.6). |
> | `destructive` | boolean |  | It removes or replaces something the person made; running it needs the person's approval (ADR-0228). |
> | `confirm` | boolean |  | It changes what the person is working in (their account, project or role) rather than their work; the assistant asks before using it. |
> | `item` | AgentItem |  | Set when the control is one of a list's rows: which row. |

**Binding values are build-time constants.** The generator reads them from source: a literal, a `const` it can follow, a property of a constant object, a template literal or `+` over those, or a single-literal type read through the type checker. A value built by a call (`t('save')`) fails the build, naming the binding. A field's `hint` and `placeholder` join its tool description the same way.

**Rows.** A control rendered once per row of a list carries `item: { key, title, description? }`. `description` says what the row is when only the running app knows (a model's parameters). The action then takes the row as `item`.

> **Schema:** [`agent-binding.json#/$defs/AgentItem`](schemas/agent-binding.json) · `https://schemas.closurestudio.ai/oui/v1/agent-binding.json#/$defs/AgentItem` · TypeScript: `AgentItem` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `key` | string | yes | The id of what the row shows (a voice id, a project id). |
> | `title` | string | yes | What the row is called on screen (the voice's name). |
> | `description` | string |  | What this row is, when the rows' meanings are only known at run time (a model's parameters, from its manifest). |

### The control table

> **Schema:** [`control-table.json#/$defs/ControlDescriptor`](schemas/control-table.json) · `https://schemas.closurestudio.ai/oui/v1/control-table.json#/$defs/ControlDescriptor` · TypeScript: `ControlDescriptor` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `kind` | AnyControlKind |  | What a binding on the component itself makes. |
> | `callbacks` | string[] | yes | Props whose presence makes a use interactive — a use with one of them must be bound. |
> | `schemaProps` | SchemaPropSources |  | Props the schema is derived from, by `SchemaProps` key: the prop of the component each comes from. |
> | `options` | OptionsSource |  | Where the options come from: the prop, and the keys of each option's value and title. |
> | `slots` | map of SlotDescriptor |  | A composite with several callbacks: slot name → its kind and the callback it binds. |
> | `entries` | EntriesDescriptor |  |  |
> | `rows` | boolean |  | The control registers one binding per row it renders (a selectable grid), so its action takes an `item`. |
> | `container` | { kind: "dialog" \| "tabs", stateProp: string } |  | A container: a dialog whose prop says whether it shows, or a tab set whose prop selects a panel. |
> | `defaults` | SchemaProps |  | What the schema props are when the page leaves them out, as the component defaults them. |
> | `display` | { itemsProp: string, labelKey: string } |  | It shows facts rather than taking input (a clip's parameters): a binding on it names what it shows, and the page reports its facts by label. |
> | `titleProps` | string[] | yes | Props that give a default title, in order. |

A composite with several callbacks names each in `slots`; an array prop whose entries carry their own `agent` (menu items, toolbar items) is `entries`; a dialog or tab set that shows a panel is a `container`; a control that only shows facts is a `display`.

> **Schema:** [`control-table.json#/$defs/SlotDescriptor`](schemas/control-table.json) · `https://schemas.closurestudio.ai/oui/v1/control-table.json#/$defs/SlotDescriptor` · TypeScript: `SlotDescriptor` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `kind` | AnyControlKind | yes |  |
> | `callback` | string |  |  |
> | `rows` | boolean |  |  |
> | `defaults` | SchemaProps |  |  |

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

> **Schema:** [`control-kind-registration.json`](schemas/control-kind-registration.json) · `https://schemas.closurestudio.ai/oui/v1/control-kind-registration.json` · TypeScript: `ControlKindRegistration` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `kind` | RegisteredControlKind | yes |  |
> | `verb` | string | yes | What using it does, as a tool description starts: "Set the price range of". |
> | `deriveSchema` | KindSchemaDerivation | yes |  |

## Tier 2: a design system you do not own

An app on MUI, Mantine or shadcn/Radix binds that design system's controls with a mapping, one file per third-party package (ADR-0226 §2.3). It is a declaration, not handler code. List each mapping under `mappings` in `oui.config.json`, and `oui generate` emits one module per mapping into `<out>/bound/`, named after the package (`@mantine/core` → `mantine-core.ts`), with its control table beside it (`mantine-core.agent-controls.json`):

- each wrapper accepts `agent`, calls `useAgentBinding` with the app's own callback, and returns that callback's result, so a job control's `pending.jobId` reaches the runtime;
- it reports the component's `disabled` prop, so a control the page disables is not offered, and a job control the page disables while its job runs is still followed until the job settles;
- it renders the third-party component unchanged, with its ref and its static members (`Button.Group`).

The app imports every mapped control from the bound module instead of the package. The generator reads each use of a bound control exactly as it reads a tier 1 control: its binding, its title, its options, and the schema its props give. `--check` fails when the bound module or its control table is stale, so the module is committed with the rest of the generated output.

### Worked example

```json
{
  "$schema": "https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json",
  "package": "@mantine/core",
  "controls": {
    "Button": { "kind": "button", "callbacks": ["onClick"], "titleProps": ["aria-label", "children"] },
    "Select": {
      "kind": "choice",
      "callbacks": ["onChange"],
      "valueFrom": { "arg": 0 },
      "controlled": "value",
      "options": { "prop": "data", "value": "value", "title": "label" },
      "titleProps": ["label", "placeholder"]
    },
    "Switch": {
      "kind": "toggle",
      "callbacks": ["onChange"],
      "valueFrom": { "arg": 0, "path": "currentTarget.checked" },
      "controlled": "checked",
      "titleProps": ["label"]
    }
  }
}
```

```tsx
import { Button, Select } from '../agent/generated/bound/mantine-core';

<Select label="Market" data={MARKETS} value={market} onChange={setMarket}
  agent={{ id: 'screener.market', description: 'The market the screen searches' }} />
```

- **`valueFrom` is explicit.** It says where the new value is in the callback's arguments: `{ "arg": 0 }` for Mantine's `onChange(value)`, `{ "arg": 1 }` for MUI's `onChange(event, value)`, `{ "arg": 0, "path": "currentTarget.value" }` for a native-style event. Every kind that takes a value needs it. When the assistant sets the value, the wrapper builds those arguments: the value at its position (inside an event-shaped object at `path`), and an event-shaped object, whose `isTrusted` is false, at each position before it.
- **`controlled` names the prop that shows the value.** The generator reports every use that does not pass it, as a warning that does not fail the build: there the handler would run, but the control would not show what the assistant set. A use that passes its props through a spread is reported too, since the build cannot see what the spread carries.
- **Options** come from the prop `options` names, and an entry may be an object with the named keys, a string or a number (both value and title), or a group: an object with an `items` array of entries.
- **A control under a namespace** (Radix `Switch.Root`) is declared with `parts.root` alone. **A compound control** (Radix `Select.Root` / `Select.Item`, Mantine `Tabs` / `Tabs.Tab`) adds `parts.item`, and its options are the items it renders: each item's `valueProp`, titled by its `titleProps` (`children` is its text, nested elements included). The bound module keeps every other member of each namespace, so `Select.Trigger` and `Tabs.List` are imported from it too.
- **A dialog's `controlled`** is the prop that shows it (Mantine `Modal`'s `opened`): the dialog's own controls are reached through it, and the controls that set that state open it.
- **The mapping is checked against the package's types.** A callback, `controlled` prop or option prop the component does not take, or an export the package does not have, is an error naming the mapping, the control and what TypeScript says.

### What fails the build

- On an enforced page, importing a mapped control straight from its package. The error names the bound import to use instead. A page listed in `unbound` may still do it, and it stays listed until it does not.
- A mapping that does not match the schema, names a package the app cannot resolve, maps a package also listed in `designSystem`, maps one package twice, or does not fit the package's types.

> **Schema:** [`tier2-mapping.json`](schemas/tier2-mapping.json) · `https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json` · TypeScript: `Tier2Mapping` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `$schema` | string |  |  |
> | `package` | string | yes | The third-party package the controls are imported from (`@mantine/core`). |
> | `controls` | map of Tier2Control | yes | Each mapped export, by its export name in that package. |

> **Schema:** [`tier2-mapping.json#/$defs/Tier2Control`](schemas/tier2-mapping.json) · `https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json#/$defs/Tier2Control` · TypeScript: `Tier2Control` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `kind` | AnyControlKind | yes |  |
> | `callbacks` | string[] | yes | Props whose presence makes a use interactive. |
> | `valueFrom` | ValueFrom |  | Required for every kind that takes a value (all but `button` and `dialog`). |
> | `controlled` | string |  | The prop that shows the value. |
> | `options` | OptionsSource |  | Where the options come from: the prop, and the keys of each option's value and title. |
> | `titleProps` | string[] |  | Props that give a default title, in order. |
> | `schemaProps` | SchemaPropSources |  | Props the value schema is derived from, by `SchemaProps` key. |
> | `defaults` | SchemaProps |  | What the schema props are when the app leaves them out, as the component defaults them. |
> | `parts` | { root: Tier2Part, item?: Tier2Part } |  | A control exported under a namespace (Radix `Switch.Root`) or made of parts (Radix `Select.Root` / `Select.Item`, Mantine `Tabs` / `Tabs.Tab`): its `root`, which takes the callbacks, and, when the options are the items it renders, its `item`. |

## Tier 3: rooms

A room is an editor with its own editing model — a canvas, a chart, a timeline, a player — whose operations are not one control each. It publishes a typed catalog of everything a person can do in it, declared where the room implements it (ADR-0220 §2.3):

- **actions**: its operations, each run through the room's own reducer and commands, with a JSON Schema for the input (one object schema, never a union at the top);
- **fields**: its inspector's fields, from the same definitions the inspector renders, each with its value's schema, its unit and range, what it applies to, and — only in a room with a timeline — its `animation`;
- **commands**: its keymap;
- **observations**: what the host reports about the room's state, including a `problems` list in the room's own vocabulary;
- **recipes**: tasks only the room knows, built from its own tools.

Derive each action's input from the schema the reducer already validates with (`z.toJSONSchema`), and check the input with the same schema before applying it. A room with fields also declares a `set-properties` action and a room with available commands a `run-command` action; the generator builds their inputs from the rest of the catalog.

### Worked example

```ts
import type { RoomCatalog } from '@ouispec/bindings';

export const ledgerCatalog: RoomCatalog<LedgerRuntime> = {
  room: 'ledger',
  title: 'Ledger',
  description: 'The account’s positions and orders.',
  actions: [
    {
      kind: 'action',
      id: 'close-position',
      title: 'Close position',
      description: 'Sells the whole position at market.',
      control: 'The Close button on a position',
      input: { type: 'object', properties: { id: { type: 'string', description: 'The position' } }, required: ['id'] },
      effect: { kind: 'transaction', operation: 'closePosition' },
      run: (ctx, { id }) => ctx.close(id),
    },
  ],
  fields: [],
  commands: [],
  observations: [{ id: 'positions', description: 'The open positions', schema: { type: 'array' } }],
  problems: [{ kind: 'order-rejected', description: 'The broker refused the order' }],
  recipes: [{ name: 'Flatten the book', trigger: 'When asked to close everything', steps: ['Close each position with {action:close-position}.'] }],
};
```

The room registers itself while it is mounted, and pushes its observations and problems as they change:

```tsx
useRoomRegistration(catalogData(ledgerCatalog), {
  run: (id, input) => controller.run(id, input),
  observations: { positions },
  problems,
});
```

A room package ships `catalogData(catalog)` as `agent-catalog.json` and names it, with the components that mount the room:

```json
{ "oui": { "agentCatalog": { "path": "./dist/agent-catalog.json", "hosts": ["Ledger"] } } }
```

A catalog in the app itself is listed in `oui.config.json` under `appCatalogs`; the generator loads it through the app's own Vite config, so the app needs `vite` among its own dependencies.

> **Schema:** [`room-catalog-data.json`](schemas/room-catalog-data.json) · `https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json` · TypeScript: `RoomCatalogData` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `room` | string | yes | The room's id: the surface id its assistant surface is published under (`room:<id>`). |
> | `title` | string | yes |  |
> | `description` | string | yes | What the room is for, in one or two sentences. |
> | `actions` | RoomActionData[] | yes |  |
> | `fields` | RoomFieldData[] | yes |  |
> | `commands` | RoomCommand[] | yes |  |
> | `observations` | RoomObservation[] | yes |  |
> | `problems` | RoomProblemKind[] |  | The kinds of problem it reports, in its own vocabulary. |
> | `recipes` | RoomRecipe[] |  | Tasks its tools carry out together, which only the room knows. |

> **Schema:** [`room-catalog-data.json#/$defs/RoomActionData`](schemas/room-catalog-data.json) · `https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json#/$defs/RoomActionData` · TypeScript: `RoomActionData` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `id` | string | yes | Stable, kebab-case, unique among the room's entries of its kind. |
> | `title` | string | yes | What the UI calls it: a button's label, a field's label, a command's name. |
> | `description` | string | yes | What it does, in a sentence or two, in the room's own terms. |
> | `control` | string | yes | Where a person does it: the tool, panel, button, key or gesture. |
> | `kind` | "action" | yes |  |
> | `input` | JsonSchema | yes | An object schema: a tool's input is one, never a union at its top level. |
> | `effect` | ActionEffect | yes | What it changes: the document (`edit`), the selection, the view, files, backend data, a job, a transaction. |
> | `destructive` | boolean |  | It removes or replaces something the person made; running it needs the person's approval (ADR-0228). |

> **Schema:** [`room-catalog-data.json#/$defs/RoomFieldData`](schemas/room-catalog-data.json) · `https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json#/$defs/RoomFieldData` · TypeScript: `RoomFieldData` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `id` | string | yes | Stable, kebab-case, unique among the room's entries of its kind. |
> | `title` | string | yes | What the UI calls it: a button's label, a field's label, a command's name. |
> | `description` | string | yes | What it does, in a sentence or two, in the room's own terms. |
> | `control` | string | yes | Where a person does it: the tool, panel, button, key or gesture. |
> | `kind` | "field" | yes |  |
> | `section` | RoomSection | yes |  |
> | `appliesTo` | string[] | yes | The kinds of thing it applies to, in the room's vocabulary (`text`, `shape`, `artboard`…). |
> | `value` | JsonSchema | yes | The value's schema: its type, range (`minimum`/`maximum`), options (`enum`) and unit (`x-unit`). |
> | `animation` | RoomFieldAnimation |  | How it animates, in a room with a timeline. |
> | `keyframeable` | boolean |  | Deprecated since oui-bindings 0.8: `animation: { keyframeable }`. |

> **Schema:** [`room-catalog-data.json#/$defs/RoomRecipe`](schemas/room-catalog-data.json) · `https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json#/$defs/RoomRecipe` · TypeScript: `RoomRecipe` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `name` | string | yes |  |
> | `trigger` | string | yes |  |
> | `steps` | string[] | yes |  |

Every input, value and observation schema, here and in tier 1, is written in the same subset of JSON Schema, which is what assistant tool inputs are written in; `x-unit` names a number's unit.

> **Schema:** [`json-schema.json`](schemas/json-schema.json) · `https://schemas.closurestudio.ai/oui/v1/json-schema.json` · TypeScript: `JsonSchema` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `type` | JsonSchemaType \| JsonSchemaType[] |  |  |
> | `description` | string |  |  |
> | `enum` | string \| number \| boolean \| null[] |  |  |
> | `const` | string \| number \| boolean \| null |  |  |
> | `properties` | map of JsonSchema |  |  |
> | `required` | string[] |  |  |
> | `additionalProperties` | boolean \| JsonSchema |  |  |
> | `items` | JsonSchema |  |  |
> | `minItems` | number |  |  |
> | `maxItems` | number |  |  |
> | `uniqueItems` | boolean |  | No two items are the same. |
> | `minimum` | number |  |  |
> | `maximum` | number |  |  |
> | `multipleOf` | number |  |  |
> | `minLength` | number |  |  |
> | `maxLength` | number |  |  |
> | `pattern` | string |  |  |
> | `format` | string |  |  |
> | `oneOf` | JsonSchema[] |  |  |
> | `anyOf` | JsonSchema[] |  |  |
> | `default` | unknown |  |  |
> | `x-unit` | string |  | The unit a number is in: `px`, `%`, `°`. |
> | `x-enum-omitted` | number |  | How many allowed values a shortened `enum` leaves out. |

## `oui.config.json`

The generator reads every setting from `oui.config.json` at the app's root; paths are relative to it (ADR-0226 §2.4). Nothing an app depends on has a default: a missing `tsconfig`, `routes`, `designSystem`, `apiSpec` or `out` is an error naming the setting, and so is a setting the generator does not know. `designSystem: []` says every control is tier 2 or in a room; `apiSpec: null` says the app has no API, and then a `mutate` effect fails.

```json
{
  "$schema": "https://schemas.closurestudio.ai/oui/v1/oui-config.json",
  "tsconfig": "tsconfig.json",
  "routes": "src/routes.tsx",
  "routeWrappers": ["Suspense", "ErrorBoundary"],
  "nav": ["src/nav.ts"],
  "shell": [{ "module": "src/app/AppFrame.tsx", "export": "AppFrame" }],
  "designSystem": ["@acme/ui"],
  "mappings": ["oui/mantine-core.mapping.json"],
  "apiSpec": "@acme/api-client/openapi.json",
  "appCatalogs": [{ "module": "src/strategy/catalog.ts", "export": "strategyCanvasCatalog", "hosts": ["StrategyCanvas"] }],
  "unbound": [],
  "out": "src/agent/generated"
}
```

`apiSpec` names the OpenAPI 3 document inside the installed API client package, never a sibling checkout, so the generator reads exactly the spec of the client version the app installs. Every `mutate` effect names one of its `operationId`s.

`mappings` lists the app's tier 2 mappings; each emits a bound module into `<out>/bound/` (see [Tier 2](#tier-2-a-design-system-you-do-not-own)).

> **Schema:** [`oui-config.json`](schemas/oui-config.json) · `https://schemas.closurestudio.ai/oui/v1/oui-config.json` · TypeScript: `OuiConfigFile` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `$schema` | string |  | This schema's URL, for editors. |
> | `$comment` | string |  |  |
> | `tsconfig` | string | yes | The tsconfig the app's source compiles with. |
> | `routes` | string | yes | The file whose routes decide where the app can go: `<Route>` elements (nested paths are joined to their parent, `index` routes kept, `React.lazy` followed) or a data router (`createBrowserRouter([...])`). |
> | `routeWrappers` | string[] |  | Components a route's element is wrapped in that are never the page (`Suspense`, `ErrorBoundary`). |
> | `nav` | string[] |  | Files holding the navigation entries (`{ label, route, group }` object literals). |
> | `out` | string | yes | Where generated output goes. |
> | `designSystem` | string[] | yes | Design-system packages whose controls carry bindings (tier 1). |
> | `mappings` | string[] |  | Tier 2 mappings (`tier2-mapping.json`), one per third-party design system the app does not own, by path. |
> | `apiSpec` | string \| null | yes | The API's OpenAPI 3 document, by module path, as the installed API client ships it (`@traidr/api-client/openapi.json`) — never a sibling checkout path, so the generator reads exactly the spec of the client version the app installs; or a path inside the app. |
> | `unbound` | string[] |  | Page components whose interactive controls are not all bound yet. |
> | `appCatalogs` | AppCatalogEntry[] |  | Room catalogs the app itself declares (tier 3, a page's own editor), each loaded through the app's own Vite config so its modules resolve as the app build resolves them: the app needs `vite` among its own dependencies. |
> | `shell` | ShellEntry[] |  | The app's frame: components mounted around the pages rather than by a route (a sidebar, a top bar, a phone tab bar, a toast host). |

## `generate --check` in CI

```sh
npx oui generate           # writes <out>/oui-manifest.json and <out>/oui-knowledge.json
npx oui generate --check   # CI: fails when either is stale, or any declaration is invalid
```

Commit both files, and run `--check` in CI on every change. The build fails, naming the file and line, when:

| Condition |
|---|
| A listed design-system package cannot be resolved, or declares no control table, or its table breaks `control-table.json` |
| A component that is not the app's own takes a callback and is neither a design-system control, a mapped control nor a room host, unless it carries `data-non-agent="<reason>"` |
| An element takes `onPointerDown`, `onMouseDown` or `onKeyDown` (or any other interactive handler) without a binding, on an enforced page |
| A route is nested, `index`, in a data router or behind `React.lazy`, and its page is not bound |
| `apiSpec` cannot be read, or a `mutate` names an unknown `operationId` |
| A room catalog breaks `room-catalog-data.json`, or a recipe names an entry the room does not have |
| A page listed in `unbound` is fully bound (the list may only get shorter) |
| A binding's value is built by a call, so it cannot be read without running the app |

The two outputs are part of the contract too: the runtime offers the intersection of the manifest and what is mounted, and each turn carries the knowledge for the page the person is on.

> **Schema:** [`oui-manifest.json`](schemas/oui-manifest.json) · `https://schemas.closurestudio.ai/oui/v1/oui-manifest.json` · TypeScript: `OuiManifest` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `version` | 1 | yes | The contract major (`MANIFEST_VERSION`). |
> | `buildId` | string | yes | A hash of everything else in the manifest and the knowledge: the build's identity to the assistant. |
> | `surfaces` | ManifestSurface[] | yes |  |

> **Schema:** [`oui-manifest.json#/$defs/ManifestAction`](schemas/oui-manifest.json) · `https://schemas.closurestudio.ai/oui/v1/oui-manifest.json#/$defs/ManifestAction` · TypeScript: `ManifestAction` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `name` | string | yes | The tool name: unique across the build. |
> | `id` | string | yes | The binding id, or `<room>/<kind>/<entry>` for a room's. |
> | `source` | ManifestActionSource | yes |  |
> | `control` | AnyControlKind |  | The control kind, for a control: a built-in one, or one its design system registers. |
> | `title` | string | yes |  |
> | `description` | string | yes |  |
> | `input` | JsonSchema | yes | The tool's input: one object schema, never a union at its top level. |
> | `effect` | ActionEffect |  | What running it does. |
> | `destructive` | boolean |  |  |
> | `confirm` | boolean |  | It changes what the person is working in (account, project, role): the assistant asks first. |
> | `itemized` | boolean |  | One of a list's rows: the action takes the row as `item`. |
> | `reach` | ReachStep[] | yes | How a person gets to it, from the page. |
> | `declaredIn` | string |  | The source file that declares it, relative to the app. |

> **Schema:** [`generated-knowledge.json`](schemas/generated-knowledge.json) · `https://schemas.closurestudio.ai/oui/v1/generated-knowledge.json` · TypeScript: `GeneratedKnowledge` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `version` | 1 | yes | The contract major (`MANIFEST_VERSION`). |
> | `buildId` | string | yes | The manifest's build id: the two are one build. |
> | `overview` | KnowledgeEntry | yes | Every page, one line each: the map of the app. |
> | `pages` | PageKnowledge[] | yes |  |
> | `frames` | PageKnowledge[] |  | The app's frame around the pages (`shell` surfaces), each part with the route patterns it frames. |

## In the tab: connecting the bindings

One OUI surface runtime per tab holds everything the assistant may do there. `connectBindings` keeps it equal to what the build's manifest declares and the page has mounted, and answers every action the assistant takes with its real result and what the page offers afterwards. There is no server-side registry of surfaces and no dispatch marker in tool results: the tab sends its snapshot with each message, and the agent runtime dispatches each UI tool call to the tab and waits for the answer.

```ts
import { createSurfaceRuntime } from 'oui-spec/core';
import { createBindingRegistry } from '@ouispec/bindings';
import { connectBindings } from '@ouispec/bindings/oui';
import manifest from './agent/generated/oui-manifest.json';

export const runtime = createSurfaceRuntime({ announce: false, accept: () => assistantTurnInProgress() });
export const registry = createBindingRegistry();

connectBindings({
  registry,
  runtime,
  manifest,
  jobs: jobTracker,               // below: how a job action settles
  navigation: appNavigation,      // { navigate, location, subscribe }: going to a page by its address
  onDefect: defect => log.error('OUI binding defect', defect),
});
```

Wrap the app in `<AgentBindingProvider registry={registry}>` (from `@ouispec/bindings/react`) so every bound control registers into it. Send `runtime.snapshot()` as the message context with every turn, and pass `runtime.grantApproval` to the agent client as `grantApproval` (see approvals).

- `accept` refuses any action request that arrives while the assistant has no turn in progress in this tab.
- A disabled control is not offered, except while a job it started is still running, or for a moment after its own press disabled it (it is reported busy, not gone).
- A control the build does not declare, or a live schema wider than the declared one, is reported through `onDefect`; the conformance kit keeps both from shipping.

## Work that outlives the call: the job effect

A binding or room action whose work finishes later — a render, an export, an order that fills — declares `effect: { kind: 'job', estimatedDuration?, timeoutMs? }`, and its handler returns `{ ok: true, pending: { jobId } }`. The action is reported `started` at once, then settles on the job's outcome: `complete` when its completion arrives, `failed` when its failure does, and after `timeoutMs` (default five minutes) a `timeout` failure, never a late success. With no tracker, or no job id, it is `unverified`: started, but not confirmable from the page. Three rules make this hold, and the kit checks the first: every `run` returns its callback's result; a job is tracked at dispatch, not at the first poll; a disabled job control is still followed.

`transaction` settles the same way.

> **Schema:** [`action-effect.json`](schemas/action-effect.json) · `https://schemas.closurestudio.ai/oui/v1/action-effect.json` · TypeScript: `ActionEffect` from `@ouispec/contract`
>
> One of: SimpleEffect \| { kind: "navigate", to: string } \| { kind: "open", container: string } \| { kind: "mutate", operation: string } \| { kind: "job", estimatedDuration?: string, timeoutMs?: number } \| { kind: "transaction", operation?: string, estimatedDuration?: string, timeoutMs?: number, approvalMinutes?: integer }.

> **Schema:** [`action-effect.json#/$defs/JobSettlement`](schemas/action-effect.json) · `https://schemas.closurestudio.ai/oui/v1/action-effect.json#/$defs/JobSettlement` · TypeScript: `JobSettlement` from `@ouispec/contract`
>
> One of: { status: "started", jobId?: string } \| { status: "running", jobId: string } \| JobOutcome \| { status: "unverified", message: string }.

### A job tracker from the product's declared events

The tracker is the seam between the product's events and its actions. Build it from the product's event declarations (ADR-0227 §2.4) rather than by hand: each event's payload schema, the rooms it goes to, the field that names the job, and whether it completes or fails a kind of job.

```ts
import { createEventCatalog } from '@ouispec/agent-events';
import { createDeclaredJobTracker } from '@ouispec/bindings/oui';
import declarations from './events.json';

export const jobTracker = createDeclaredJobTracker({
  events: createEventCatalog(declarations),
  source: socket,       // { subscribe(rooms), unsubscribe(rooms), on(event, handler) }
  kind: 'report',       // the declared job kind a job id names
});
```

It joins the room the completion declares for one job (`report:{jobId}`), and settles on the declared completion with its declared result fields, or on the declared failure with its declared reason. Work no declared kind describes (work the tab does itself) plugs in as a `JobTrackerExtension`, which may read declared events only. An event name the declarations do not hold fails where it is used: the realtime server refuses it, the worker refuses the tool, the tracker refuses to start.

> **Schema:** [`event-declarations.json`](schemas/event-declarations.json) · `https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json` · TypeScript: `EventDeclarationDocument` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `$schema` | string |  |  |
> | `version` | 1 | yes | The version of this document's format. |
> | `product` | string | yes | Who declares these events. |
> | `description` | string |  |  |
> | `$defs` | map of EventPayloadSchema |  | Payload shapes the events share, referenced as `#/$defs/<Name>`. |
> | `rooms` | map of RoomDeclaration | yes | Every room these events go to, by name. |
> | `events` | map of EventDeclaration | yes | Every event, by its name on the wire. |

> **Schema:** [`event-declarations.json#/$defs/EventDeclaration`](schemas/event-declarations.json) · `https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json#/$defs/EventDeclaration` · TypeScript: `EventDeclaration` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `description` | string | yes |  |
> | `payload` | EventPayloadSchema | yes | The payload's JSON Schema: an object. |
> | `typeName` | string |  | The name generated code gives the payload type. |
> | `rooms` | string[] | yes | The rooms the event is published to: names from the document's `rooms`, or `turn` for the room of the agent turn it belongs to (the host names that room in each turn). |
> | `correlation` | string[] | yes | The payload fields that say which job, or which resource, the event is about (e.g. |
> | `role` | EventRole | yes |  |
> | `completes` | string |  | For a completion or failure: the kind of job it settles. |
> | `result` | string[] |  | For a completion: the payload fields that are the job's result, as a follower reports them. |
> | `reason` | FailureReason |  | For a failure: where its reason is. |

## Irreversible actions: the approval card

A `transaction` — an order, a payment, a send, a publish — and any `write` declared `destructive` run only on an approval the person gave, bound to the exact call (ADR-0228). No policy waives it.

1. The agent worker stops the turn at the call, stores it with its args hash, and the person's tab receives `agent:approval_required` with a preview whose every word comes from the action's declaration, never from the model.
2. The tab renders the approval card. In a UI only a click on the card counts: a "yes" typed in chat is a message. On voice, phone and SMS, the verbatim readback and an affirmative next turn.
3. The click goes to the approval store on the person's own socket (`approval:decide`). The store answers the decider only, with a single-use token and the call's args hash, and the tab's OUI runtime receives a grant (`grantApproval`).
4. The next turn carries the token, outside the message text. The worker redeems it for the stored call, exactly, and runs it. A UI action then reaches the tab carrying `approval: { approvalId, argsHash }`, and the tab runs it only when that matches its grant.

Render the card with `ApprovalCard` from `@ouispec/agent-react`, drawn with your design system's parts:

```tsx
<ApprovalCard components={{ Card: MyCard, Button: MyButton }} labels={{ approve: 'Place order' }} />
```

The card takes no `agent` prop, and a package that ships its own card declares it under `oui.personOnly` (`{ "ApprovalCard": "the person's own approval" }`), so the generator refuses to bind it: the assistant can never operate its own approval. The args hash is SHA-256 over the RFC 8785 canonical JSON of the arguments, lowercase hex; `oui-spec/approval-vectors.json` holds every implementation to it, in any language.

> **Schema:** [`approvals.json#/$defs/ApprovalRequiredEvent`](schemas/approvals.json) · `https://schemas.closurestudio.ai/oui/v1/approvals.json#/$defs/ApprovalRequiredEvent` · TypeScript: `ApprovalRequiredEvent` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `turnId` | string | yes |  |
> | `conversationId` | string | yes |  |
> | `approvalId` | string | yes |  |
> | `tool` | string | yes |  |
> | `effect` | ApprovalEffect | yes |  |
> | `destructive` | boolean | yes |  |
> | `preview` | ApprovalPreview | yes |  |
> | `expiresAt` | number | yes |  |
> | `timestamp` | number | yes |  |

> **Schema:** [`approvals.json#/$defs/ApprovalDecideResult`](schemas/approvals.json) · `https://schemas.closurestudio.ai/oui/v1/approvals.json#/$defs/ApprovalDecideResult` · TypeScript: `ApprovalDecideResult` from `@ouispec/contract`
>
> One of: { ok: true, decision: "approve", approvalId: string, token: string, argsHash: ArgsHash, expiresAt: number, channel: ApprovalChannel } \| { ok: true, decision: "decline", approvalId: string } \| ApprovalRefusal.

> **Schema:** [`approvals.json#/$defs/ApprovalContinuation`](schemas/approvals.json) · `https://schemas.closurestudio.ai/oui/v1/approvals.json#/$defs/ApprovalContinuation` · TypeScript: `ApprovalContinuation` from `@ouispec/contract`
>
> One of: { approvalId: string, decision: "approve", token: string } \| { approvalId: string, decision: "decline" }.

> **Schema:** [`approvals.json#/$defs/ActionRequestApproval`](schemas/approvals.json) · `https://schemas.closurestudio.ai/oui/v1/approvals.json#/$defs/ActionRequestApproval` · TypeScript: `ActionRequestApproval` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `approvalId` | string | yes |  |
> | `argsHash` | ArgsHash | yes | `argsHash(params)` of the request the user approved. |

> **Schema:** [`approvals.json#/$defs/ApprovalTokenClaims`](schemas/approvals.json) · `https://schemas.closurestudio.ai/oui/v1/approvals.json#/$defs/ApprovalTokenClaims` · TypeScript: `ApprovalTokenClaims` from `@ouispec/contract`
>
> | Field | Type | Required | What it is |
> |---|---|---|---|
> | `aid` | string | yes | The approval id, which is the tool call id. |
> | `sub` | string | yes | The user. |
> | `cid` | string | yes | The conversation. |
> | `tool` | string | yes |  |
> | `ah` | ArgsHash | yes | The args hash. |
> | `eff` | ApprovalEffect | yes | The effect. |
> | `ch` | ApprovalChannel | yes | Where the user confirmed. |
> | `iat` | integer | yes | Issued at, epoch seconds. |
> | `exp` | integer | yes | Expires at, epoch seconds. |
> | `jti` | string | yes | A nonce. |

## The conformance kit

`@ouispec/testing` runs in your own test runner, in any DOM environment (jsdom, happy-dom, a browser), and reports against these schemas (ADR-0226 §3.2). Each check returns a report; `assertConformant(report)` throws with every violation listed, under its rule.

| Rule | What it holds |
|---|---|
| `matches-contract` | What the package ships and declares matches the schemas: its control table and `$kinds`, its `oui.agentControls` declaration, a manifest, a mapping. |
| `registers-declared-kind` | Every table entry registers at runtime with the kind it declares. |
| `callbacks-accounted` | Every export that takes a callback is in the table, or excluded with a reason. |
| `run-returns-result` | Every binding's `run` returns its callback's result, and a job control reports `pending.jobId`. |
| `actions-mounted` | Every generated manifest action has a mounted handler on the page that offers it. |
| `tier2-forwards-value` | Every tier 2 wrapper forwards `valueFrom` correctly. |
| `tier2-reports-uncontrolled` | Every use of a mapped control that does not pass its `controlled` prop is reported. |

### A design system

```tsx
import { assertConformant, checkDesignSystem, readShippedPackage } from '@ouispec/testing';
import * as ui from '../src';

it('passes the OUI conformance kit', async () => {
  assertConformant(
    await checkDesignSystem({
      ...readShippedPackage(packageDir),           // package.json and the table it declares, as built
      exports: ui,
      source: { tsconfig: 'tsconfig.json', entry: 'src/index.ts' }, // finds every export that takes a callback
      excluded: { Avatar: 'display' },             // exports that are not controls, each with why
      wrapper: ThemeProvider,
      examples: {
        Button: ({ agent, on }) => <Button agent={agent()} onClick={on('onClick')}>Save</Button>,
        Card: ({ slots, agent, on }) => (
          <Card agent={slots()} onOpen={on('onOpen')} menuItems={[{ label: 'Rename', onClick: on('onClick'), agent: agent('entries') }]} />
        ),
      },
    }),
  );
});
```

Each example renders a control the way a page uses it, with the kit's bindings (`agent()`, `agent('<slot>')`, `agent('entries')`, `slots()`) and callbacks (`on('<callback as the table names it>')`). Return several elements when parts only show in some state (a dialog open, a row present). The kit runs every part with a value its live schema accepts, and requires the named callback to be called and its result — and, in a second run, `{ ok: true, pending: { jobId } }` — to come back from `run` unchanged.

### An app

`checkApp({ name, manifest, pages })` mounts each surface's page (several states if needed) and requires a handler for every action the generated manifest declares on it.

### A tier 2 mapping

`checkTier2({ mapping, wrappers, examples, uses, reported })` mounts each bound wrapper, runs it, and requires the app's callback to receive the value where `valueFrom` says, and its result back from `run`; and it requires every use the generator found without the `controlled` prop to be among those it reported. The generator returns both lists, so the kit is fed what the build found:

```ts
const result = await generate(loadConfig('oui.config.json'));
assertConformant(await checkTier2({
  mapping, wrappers: await import('./src/agent/generated/bound/mantine-core'), examples,
  uses: result.tier2.uses, reported: result.tier2.uncontrolled, wrapper: MantineProvider,
}));
```

A compound control's wrapper is its namespace (`Select`), and its example renders the root and its items.

## Conversations

The agent client never makes HTTP requests; the product supplies callbacks. Beyond `createConversation` and `sendMessage` (which passes an approval continuation through unchanged, as `approval`), two optional callbacks let a person return to earlier conversations: `listConversations({ limit, offset, … })` and `getConversation(id)`. With `getConversation`, the client also restores the tab's active conversation after a reload. Both must return only the signed-in person's conversations.
