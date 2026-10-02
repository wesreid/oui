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

<!-- schema: tier2-mapping.json -->

<!-- schema: tier2-mapping.json#/$defs/Tier2Control -->
