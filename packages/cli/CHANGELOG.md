# @ouispec/cli

## 0.4.0

### Patch Changes

- An action input can take a file the user attached (spec §7.3.11, ADR-0252 §2.13).

  - **oui-spec:** an input declared `{ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file' | 'text', mediaTypes } }` is sent the attachment's id.
    - The runtime resolves the id before the handler runs, through `createSurfaceRuntime({ attachments: { resolve } })`, and hands the handler the `File` or the file's text.
    - It refuses an id it cannot resolve, or a file of a type the input does not take (`ATTACHMENT_UNAVAILABLE`), and refuses outright when it has no resolver (`ATTACHMENTS_UNSUPPORTED`).
    - The index describes the input as `file(…)`.
    - Exports `OUI_ATTACHMENT_FORMAT`, `isAttachmentId`, `attachmentInputOf`, `attachmentInputs` and `attachmentIdsIn`.
  - **contract:** the JSON Schema subset declares `x-oui-attachment` and documents the format. The control kinds add `file`, and `SchemaProps` adds `accept`.
  - **bindings:** a `file` control (an upload zone, a file button) derives that input from `accept`. Run by the assistant, its handler receives the file, as from the person's own choice.
  - **testing:** the kit samples a file, of a type the control accepts, for a control that takes one, and measures an attachment input against the budgets.
  - **cli:** released again on the new bindings and contract.

- Updated dependencies
  - @ouispec/contract@0.4.0
  - @ouispec/bindings@0.4.0

## 0.3.4

### Patch Changes

- Published again with their dependencies on the current releases. `@ouispec/cli` 0.3.0 still required `@ouispec/bindings ^0.2.3` and `@ouispec/contract ^0.2.0`, and `@ouispec/testing` 0.2.0 required `@ouispec/contract ^0.2.0`. An app on `@ouispec/bindings` 0.3 and `oui-spec` 0.10 therefore got a second, older copy of each through the generator, and `oui generate` built its manifest with bindings 0.2. There is no change of code.

## 0.3.0

### Minor Changes

- A reason a control gives for not being the assistant's is checked when it names another action.

  A control opts out with `data-non-agent="<reason>"` or `agent={{ nonAgent: '<reason>' }}`, and the reason commonly names what the assistant uses instead: "opens Add Asset, as the Add button (editor.add-asset.open) does", or "the same as the insert.media command". Nothing checked that name, so a renamed or removed action left the assistant with no way to do the thing and nothing saying so.

  `oui generate` now fails a reason that names, in parentheses, an id with a dot in it that is no binding, room action or command of the app, and one that names "`<id>` command" for a command no room's catalog has. Each failure gives the file and line of the reason. Nothing else in a reason is read.

  **What to do when you take this version.** A build that passed may now fail on a stale reason: point it at the action the assistant uses, or bind the control.

## 0.2.3

### Patch Changes

- A control's label is read from its own text, never from a nested element's attributes.

  The generator names an action by the control's label. Reading a label from children that hold an expression (`{busy ? <Loader className="animate-spin" /> : null} Render WAV`), it took every string literal inside the expression, the nested element's `className` and `data-testid` included, so actions were titled "animate-spin Render WAV", "text-[10px] shrink-0" or "character-create-persona-path". Thirty actions of one app were named that way, and an assistant does not choose an action it cannot name.

  - JSX inside an expression is not entered: the label is the text the control itself shows.
  - An entity is read as the character it shows (`Use the character&apos;s own` is "Use the character's own").
  - Text that is only a symbol (`&times;`, `★`) gives no label, so the control's `aria-label` or its binding's `title` names it.

  **What to do when you take this version.** Your first build on it changes the generated titles that were wrong, so `oui generate --check` fails until you regenerate: run `oui generate`, review the diff (titles only; no id, input or schema changes), and commit the generated files in the same change that takes the version.

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
  - @ouispec/contract@0.2.0
  - @ouispec/bindings@0.2.0

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/contract@0.1.0
  - @ouispec/bindings@0.1.0
