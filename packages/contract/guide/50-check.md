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

<!-- schema: oui-manifest.json -->

<!-- schema: oui-manifest.json#/$defs/ManifestAction -->

<!-- schema: generated-knowledge.json -->
