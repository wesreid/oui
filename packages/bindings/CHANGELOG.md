# @ouispec/bindings

## 0.5.0

### Patch Changes

- Released again so each depends on the current release of the contract and the agent SDK, and an app on the latest of everything has one copy of each.
- Updated dependencies
- Updated dependencies
  - @ouispec/contract@0.5.0
  - @ouispec/agent-events@0.11.0

## 0.4.0

### Minor Changes

- An action input can take a file the user attached (spec §7.3.11, ADR-0252 §2.13).

  - **oui-spec:** an input declared `{ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file' | 'text', mediaTypes } }` is sent the attachment's id.
    - The runtime resolves the id before the handler runs, through `createSurfaceRuntime({ attachments: { resolve } })`, and hands the handler the `File` or the file's text.
    - It refuses an id it cannot resolve, or a file of a type the input does not take (`ATTACHMENT_UNAVAILABLE`), and refuses outright when it has no resolver (`ATTACHMENTS_UNSUPPORTED`).
    - The type is checked for an input that takes text too: the host resolves it to the `File` or to `{ name, mediaType, text }` (`AttachmentText`), and bare text is taken only by an input that accepts any type.
    - A file input anywhere other than a property of the input or a list property's items is refused (`ATTACHMENT_INPUT_UNSUPPORTED`, `misplacedAttachmentInputs`).
    - A file named twice in a request is resolved once, a list's files at most four at a time, and a list input takes at most 20 files (`ATTACHMENT_LIST_MAX`).
    - The index describes the input as `file(…)`.
    - Exports `OUI_ATTACHMENT_FORMAT`, `isAttachmentId`, `attachmentInputOf`, `attachmentInputs`, `attachmentIdsIn`, `acceptsMediaType` and `misplacedAttachmentInputs`.
  - **contract:** the JSON Schema subset declares `x-oui-attachment` and documents the format. The control kinds add `file`, and `SchemaProps` adds `accept`.
  - **bindings:** a `file` control (an upload zone, a file button) derives that input from `accept`. Run by the assistant, its handler receives the file, as from the person's own choice. Its value must be the file itself (a `Blob`), or the text for an input that takes text: an unresolved id or a URL is not one.
  - **testing:** the kit samples a file, of a type the control accepts, for a control that takes one, and measures an attachment input against the budgets.
  - **cli:** released again on the new bindings and contract.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.11.0
  - @ouispec/contract@0.4.0
  - @ouispec/agent-events@0.8.0

## 0.3.3

### Patch Changes

- Work that failed ends its action as a failure. A polling `resolve` may now return `{ done: true, data, error: { code, message } }`. The runtime then sends the final result with `success: false` and that error, and keeps `data`. The spec says so in §7.3.3: an async action whose work failed sends its final result as a failure.

  `@ouispec/bindings` ends a job whose declared failure arrived this way, with error `JOB_FAILED` and the declared reason as its message, and keeps the outcome as data. Before, a failed job answered `success: true` with `data.status: 'failed'`. The assistant's record of the call then said it succeeded, and so did the stored chat.

- Updated dependencies
- Updated dependencies
  - oui-spec@0.10.0
  - @ouispec/agent-events@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.9.0
  - @ouispec/agent-events@0.5.0

## 0.2.3

### Patch Changes

- A colour control that offers mesh gradients says so in its schema. With `'mesh-gradient'` among a `color` control's `paintKinds`, the derived input schema accepts `{ kind: 'mesh-gradient', rows, columns, points }`: a grid of (rows + 1) × (columns + 1) points, each placed as fractions of the painted shape with a CSS colour, an optional opacity and optional `left`, `right`, `up` and `down` handles that bend the grid lines leaving it. A mesh has no stops, so it is no longer listed among the stop gradients' kinds. Controls that do not offer the kind are unchanged.

## 0.2.2

### Patch Changes

- The room readers' descriptions open with a short sentence. An index carries an action's first sentence (up to 160 characters), and `inspect` and `query` opened with sentences of 155 and 246 characters, in every room that declares lists. They now open with "Reads everything about the things named, as they are now." and "Lists the rows of one of the room's lists, to find a thing by its name."; the rest of each description is unchanged in substance and is read through the action's definition.

## 0.2.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.8.0
  - @ouispec/agent-events@0.2.2

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
  - @ouispec/agent-events@0.2.0
  - @ouispec/contract@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.7.0
  - @ouispec/agent-events@0.1.1

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/contract@0.1.0
  - @ouispec/agent-events@0.1.0
