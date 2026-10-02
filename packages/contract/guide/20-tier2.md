## Tier 2: a design system you do not own

An app on MUI, Mantine or shadcn/Radix binds that design system's controls with a mapping, one file per third-party package (ADR-0226 §2.3). It is a declaration, not handler code. `oui generate` emits one module per mapping into `<out>/bound/`: each wrapper accepts `agent`, calls `useAgentBinding` with the app's own callback, returns that callback's result, and renders the third-party component unchanged. The emitted module ships its own control table and is treated exactly like a tier 1 package. On an enforced page, importing a mapped component straight from the third-party package fails the build, naming the bound import to use instead.

The mapping's schema and the conformance kit's tier 2 rules are published now; the generator emits the wrappers from W4 of the platform plan.

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
    }
  }
}
```

- **`valueFrom` is explicit.** It says where the new value is in the callback's arguments: `{ "arg": 0 }` for Mantine's `onChange(value)`, `{ "arg": 1 }` for MUI's `onChange(event, value)`, `{ "arg": 0, "path": "target.value" }` for a native-style event. Every kind that takes a value needs it.
- **`controlled` names the prop that shows the value.** The generator reports every use that does not pass it: there the handler would run, but the control would not show what the assistant set.
- **Compound components** (Radix `Select.Root` / `Select.Item`) are declared as `parts`; the options come from the rendered items.

<!-- schema: tier2-mapping.json -->

<!-- schema: tier2-mapping.json#/$defs/Tier2Control -->
