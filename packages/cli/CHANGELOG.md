# @ouispec/cli

## 0.8.1

### Patch Changes

- **A long list of cards keeps an index of its rows in the page state, never a bare count.** The generated page state declares `x-rows` on `shown`: a display's facts that describe one row of a list (a card each) are addressed by the row's `item.key`, called by its `item.title`, and indexed with their display's `id`. `x-rows` takes a dotted path to a row's property (`rowValue`, `indexRow` and the row lookup read one), and the bindings report each display's rows together (`factsByDisplay`). Over budget, the worker keeps a display's first rows and the rows an action just changed whole and the rest as index rows, as it does any declared list; when even the index does not fit, it says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time. A page generated before the declaration is indexed the same way.
- Updated dependencies
  - @ouispec/contract@0.8.1
  - @ouispec/bindings@0.8.1

## 0.8.0

### Minor Changes

- **The assistant opens a page already filtered, in one call.** A page declares the query it reads from its address once, with `defineQuery` (`@ouispec/bindings`), and reads and writes it with `readQuery` and `writeQuery`: typed values, a value the page does not take falling back to its default, defaults left out of the address. The generator reads the declaration where the page, a component it renders or an app hook reads it, holds it to the new `page-query.json` schema, and the generated `app.navigate` takes `query` (one alternative per page, its routes in `x-routes`) and `params` (a route's `:parameters`, filled and encoded). `path` names each page's parameters, and the page's knowledge lists them. The runtime builds the address from the path, `params` and `query`, each part encoded, refuses a path that could leave the app (`//host`, a backslash, `.` or `..` segments) and a query parameter or value a declaring page does not take, naming what it takes, and does nothing, saying `alreadyThere`, when the person is already at that address. A build that declares no query is generated as before, with `params` added.

  **An action called as a tool runs once, through `ui_act`.** When the model calls an action of the page by its id as if it were a tool of its own (`app_navigate`), the worker runs it as the `ui_act` call it means, once, validated, judged by policy and approved as any `ui_act` call, instead of refusing it and having the model call it again. A name that is no action of the page is answered by the SDK as before.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.8.0
  - @ouispec/bindings@0.8.0

## 0.7.0

### Minor Changes

- **Pages the assistant is never on.** `oui.config.json` takes `outside`: pages before sign-in and public pages a link opens, each named by `component` or by `route`, with its `reason` (`OutsideEntry`). An outside page has no surface, its controls are not enforced, `app_navigate` does not list it, and the knowledge's overview says the assistant is not on its routes. Until now such a page could only sit in `unbound`, which is meant to shrink to nothing.

  The list cannot hide a page of the app. A page is outside only when no `shell` entry frames its routes; every element its routes render around it (a layout route's, or a `routeWrappers` component's, at any level) holds nothing someone can use and no person-only component, which is how the assistant's own UI is declared; it does not render the app's frame itself; and it has no binding, display or room of its own, on no page the assistant is on. A page is never in both `outside` and `unbound`. An app without `outside` builds as before.

  **A design system's person-only components are the person's own.** `oui.personOnly` in a package listed in `designSystem` is now read, as it already was for any other package: a sign-in screen or the assistant's panel needs no control table entry, its callbacks need no `data-non-agent`, and an `agent` binding or a spread on one fails the build. An export in both the control table and `oui.personOnly` is an error. A page whose only unbound controls were such components is now fully bound, so the build asks to take it out of `unbound`: this is why the release is a minor.

  A route's page is read through the components it renders, as before; the tests now hold a route element that picks between two lazy pages, each rendering through a wrapper of its own children.

  The agent SDK is released again only to depend on this contract.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.7.0
  - @ouispec/bindings@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.6.0
  - @ouispec/bindings@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.5.0
  - @ouispec/bindings@0.5.0

## 0.4.6

### Patch Changes

- README and docs cleanup.
- Updated dependencies
  - @ouispec/bindings@0.4.6
  - @ouispec/contract@0.4.6

## 0.4.5

### Patch Changes

- **A question is answered in words.** The tool strategy's new "Answering Questions" rule and `present_options`' description say that a question (what something is, how it works, why) is answered in the reply. A card is never the answer: it only follows when a choice does, and a question asked again is answered, not met with another offer. On Closure's dev, a person asked "What is the push channel?" twice and got only a card offering to set one up (`textLength: 0` both times). The new live eval `ui-questions` asks that question fresh, after a card, and again after a card that didn't answer it, under the neutral persona (12/12). With Closure's persona it fails before the rule and passes after (16/16). Its control, "set one up", still sets one up.

  **`ui_guide` finds the entry a name means.** It tries, in order: the exact title; the title in any case; the one page entry whose title, less its route, is the name ("Experience Studio" for "Experience Studio (/distribution/experiences/:partId)"); and the one entry the name begins (`findNamed`). A name that two entries could mean finds neither, and the error still lists them all.

  **An option says what it means.** `ControlOption.description` is new: what choosing the option means, as the control shows it beside its title. `deriveInputSchema` names it with the option (`token = Recipient token (A field of the recipient, such as {{firstName}})`) for choices, tabs and multi-choices, live and generated alike (`describeOption`). The generator reads it from source through a control table's new `OptionsSource.description` key, and a tier 2 mapping's options through `mappedOptions`.

  `liveTurn` (evals) takes the conversation before the message, the client's knowledge and a product's persona.

- Updated dependencies
  - @ouispec/contract@0.4.5
  - @ouispec/bindings@0.4.5

## 0.4.3

### Patch Changes

- A control imported from a subpath export of a design-system package is read against that package's control table.

  A design system that declares its control table once in its package.json (`"oui": { "agentControls": … }`) but exports its React controls from a subpath (`@acme/kit/react`) was never recognised: `oui generate` compared each import's specifier with the `designSystem` names exactly, so every bound control imported from the subpath failed as "neither a design-system control nor a room host", and a binding on it never reached the manifest.

  - An import whose specifier is a listed package, or a subpath of one (`<package>/<anything>`), is that package's: its controls are bound against the package's table, and an unbound one on an enforced page is reported as before. When `designSystem` lists a package and a subpath of it, the longest name the import is under wins. A package whose name only starts the same (`@acme/kit-extras` for `@acme/kit`) is not a match.
  - The same holds for a room package's hosts and catalog, for a person-only component (`oui.personOnly` is read from the package a subpath belongs to), and for a mapped package: a mapped control imported from a subpath of its package is reported as imported straight from the package, naming the bound import.
  - A mapping of a package that overlaps a `designSystem` entry through a subpath (`acme` and `acme/kit`, either way round) is refused, as a mapping of a listed package already was.

## 0.4.0

### Patch Changes

- An action input can take a file the user attached (spec §7.3.11).

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
