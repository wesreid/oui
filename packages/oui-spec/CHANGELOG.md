# oui-spec

## 0.7.1

### Patch Changes

- A result's observations are the page after the action, for a slow action too.

  - **What was wrong:** the runtime answers once the page has been quiet for `quietMs`, and it measured that from when the request arrived. A handler that awaits its own work first (a save, a restore over the network) returns later than that, so the page had already "been quiet" and the answer was taken at once, before the UI rendered what the handler had just changed. The result said the restore worked; the observations beside it showed the page before it.
  - **Now:** quiet, and the settle timeout, are measured from when the handler returned.
  - **Tests:** a handler that waits four quiet windows and then changes an observation is answered with the changed observation; a handler slower than the settle timeout still gets the whole timeout afterwards.

## 0.7.0

### Minor Changes

- The index form, definitions on demand, and frames that always fit (spec §7.3.8–§7.3.10).

  - **A client can send an index of its actions, not their definitions.**
    - With `createSurfaceRuntime({ form: "index" })`, `runtime.snapshot()` and every result carry `index` (`OUISurfaceIndex[]`) in place of `surfaces`.
    - Each action is `{ id, title, description, effect, confirm, async, input, definitionHash, definitionBytes }`, where `input` is a one-line summary (`summarizeInput`).
    - On a page whose definitions weigh over 200 KB, the index is under 128 KB.
    - The default stays `"full"` until 1.0, so a client upgrades without its agent runtime changing.
  - **`oui.describe` and `oui.read`.** The surface id `oui` is the runtime's own.
    - `describe` returns the live definitions of the actions asked for.
    - `read` returns part of an observation's value by JSON Pointer, a page of a list at a time.
    - Both work in either form.
  - **Frames are fitted before they are sent.**
    - A result is held to 480 KB and a snapshot to 256 KB (`budgets`).
    - Long lists are cut first, then long texts, then whole values.
    - `fit` reports each cut so the rest can be read.
  - **A refused result is trimmed a step at a time:** what the page offers, then the observations, then the data. It used to lose the definitions and the observations together, which left an agent unable to see the page.

  **Changes in behaviour:**

  - A surface can no longer be defined with the id `oui`.
  - A refused result is trimmed in three steps, not two: `delivery.omitted` is first `["surfaces"]` (or `["index"]`).
  - Observations over a frame's budget arrive shortened, with `fit` saying where.

## 0.6.1

### Patch Changes

- Published from the OUI monorepo (`packages/oui-spec`) by its release workflow, with provenance: the package's `repository.directory`, homepage and changelog now point at that directory. No change to the code or the protocol.

## 0.6.0 and earlier

Released from the repository root before the monorepo. Each release's changes are in its GitHub release: [v0.6.0](https://github.com/wesreid/oui/releases/tag/v0.6.0), [v0.5.0](https://github.com/wesreid/oui/releases/tag/v0.5.0), [v0.4.1](https://github.com/wesreid/oui/releases/tag/v0.4.1), [v0.4.0](https://github.com/wesreid/oui/releases/tag/v0.4.0), [v0.3.0](https://github.com/wesreid/oui/releases/tag/v0.3.0).
