# @ouispec/agent-worker

## 0.2.2

### Patch Changes

- An index entry is smaller: its `definitionHash` is 32 bits (8 hex digits) and it no longer carries `definitionBytes`.

  **`oui-spec` 0.8 (breaking for a reader of the entry type).** `OUIActionIndexEntry.definitionBytes` is removed: nothing read it but size budgets, which measure the definition themselves. `definitionHash` is the first 32 bits of the definition's 64-bit FNV-1a (`DEFINITION_HASH_HEX`): it is only compared with the same action's earlier hash, so a change goes unseen once in 2^32. `surfacesHash`, which is compared across a whole page, stays 64 bits. On a page of 447 actions this takes about 13 KB off the index.

  **Rolling it out: the agent runtime first, then the page.** A hash is opaque to a runtime, which MUST accept one of any length and ignore a `definitionBytes` it is sent (§7.3.8). So move the worker to this release first; a tab still on 0.7 then keeps working with it, and the tab follows. A 0.7 worker given a 0.8 tab's index also works (it compares the hash as a string and never read `definitionBytes`), but only this order is tested.

  **`@ouispec/agent-worker`.** Tested against an index from a 0.7 tab. The `Turn usage` log line carries `ui.indexChars` and `ui.maxIndexChars`: the size of the page's index as the model reads it, and the most it is given before the furthest surfaces are listed by id only.

- Updated dependencies
  - oui-spec@0.8.0
  - @ouispec/agent-core@0.2.2
  - @ouispec/agent-events@0.2.2
  - @ouispec/bindings@0.2.1

## 0.2.1

### Patch Changes

- A part of an action's input asked for by its path is given whole, a list too long for one answer is paged, and a list or object sent as JSON text is read as what it spells.

  - **`ui_describe` with a `path`** returns that part whole up to 12,000 characters (`WHOLE_PART_CHARS`); an action's whole input is still outlined past 4,000. Asked for the `command` part of an editor's run-command, a model was twice given 12 of its 48 commands and never saw the one the task needed.
  - **No row is dropped without a way to read it.** An outline lists as many rows (properties, a union's members, an enumeration's values) as the size holds, says how many there are, and says where the next begin; `ui_describe` and `describeSchema` take `from`. An enumeration of more than 12 values is opened by its path like any other part.
  - **A list or an object sent as JSON text** (`"ids": "[\"a\",\"b\"]"`) is read as the list or object, when the schema takes one there and that makes the input valid. The call runs, and its result carries an `inputNote` saying so. A string where the schema takes a string is left alone.

## 0.2.0

### Minor Changes

- The assistant scales to a whole app, and reads what a page holds. This release breaks 0.1: read the list before upgrading.

  **The page sends an index of its actions (needs `oui-spec` 0.7).**
  - A client created with `createSurfaceRuntime({ form: 'index' })` sends one line per action. The worker fetches a definition from the page when an action is first used (`oui.describe`). A client that sends every definition keeps working.
  - The model is given three UI tools whatever the page offers: `ui_act` (run one action by its id), `ui_describe` (what actions take) and `ui_read` (part of the page's state). A large definition is described in outline and opened by path. **Breaking:** a UI action is no longer its own model tool, and a stored tool call of one is `ui_act` with `{ action, input }`. Quota, tool policy, approval, the turn record and the `agent:tool_call_*` events still name the action.
  - Nothing that changes the page runs while the page cannot be seen: after an answer that arrived without the page's state, only reads run, and two refused changes end the turn's UI work.
  - Size budgets, checked by `oui generate` and by the conformance kit (`within-budgets`): an index entry is at most 512 bytes, a definition 256 KB, and a surface's index 128 KB.
  - **Breaking exports in `@ouispec/agent-worker`:** `readClientSnapshot` is `readClientPage`; `buildUITools` takes the page and returns `describe` and `read`; a UI result names `page.nowOffers`, `page.actionsAdded` and `page.actionsRemoved` in place of `toolsAdded` and `toolsRemoved`.

  **The assistant reads what the page holds, and knows what a value means.**
  - A room's lists are readable: a row index in the page state, and generated `inspect` and `query` actions. A name is accepted where an id is.
  - An edit says what it changed (`changed`), and that row is kept whole in the page state it comes with.
  - Every number in a generated action says its unit and its space (`x-unit`, `x-space`), and the generator refuses one that does not.
  - The turn keeps a record of what ran and what it could not confirm.

  **Questions, approvals and pictures.**
  - **Breaking:** `present_options` requires `context`: what the person needs to know before choosing. The card shows it above the question.
  - An approved action is one call with one result.
  - A picture in an action's answer (`data.image = { mediaType, base64, width, height }`; PNG, JPEG or WebP, up to 256 KB of base64) is given to the model as an image, and its base64 is kept nowhere.
  - The Lambda and container adapters take `uiActions.maxIndexChars`.

  **Also.**
  - A model that takes no temperature is sent none (`temperature: null`).
  - The contract's JSON Schema subset gains `x-unit`, `x-space`, `x-ref` and `x-rows`, and a room catalog declares its rows.
  - The paint controls' schema takes freeform gradients and patterns.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.2.0
  - @ouispec/agent-events@0.2.0
  - @ouispec/bindings@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.7.0
  - @ouispec/agent-core@0.1.1
  - @ouispec/agent-events@0.1.1
  - @ouispec/bindings@0.1.1

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/bindings@0.1.0
  - @ouispec/agent-core@0.1.0
  - @ouispec/agent-events@0.1.0
