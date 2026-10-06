# @ouispec/agent-events

## 0.8.0

### Minor Changes

- The person can give the assistant files (ADR-0252 phase 2). A file is uploaded to the platform's file area first and travels by reference: no file's bytes go with a message, a turn, an event or a stored record.

  - **agent-core:** `AttachmentRef` (with `pending` while the platform still checks a file), `AttachmentLimits` with the default limits, `attachmentRefusal`, `attachmentReferenceLine`, and the tab's upload seam (`AgentClientConfig.attachments`). `sendMessage` carries `attachments: AttachmentRef[]` (it was `File[]`), and `AgentStoredMessage.attachments` carries a message's files. A file's name reaches the model through `attachmentNameForModel`: one JSON string, control, line-breaking and direction characters taken out, angle brackets escaped, at most 120 characters.
  - **agent-react:** `useAgent().attachments`, the composer's files. A file is uploaded the moment it is attached, refused before upload when it breaks the limits, and shows its progress or why it was refused. `sendMessage` waits for running uploads and sends the ready files.
    - While it waits, `attachments.waitingToSend` is true and a second Send is refused. It takes only the files on the message at Send. Nothing is sent, and `notSent` hands the text back for the draft, when a file on the message is refused, when the conversation changes, or when Stop gives the send up; the wait ends then even if an upload ignores its cancel.
    - A file attached while the tab restores its conversation goes into that conversation (a host whose `getConversation` throws synchronously included), and a file is never sent with a message to a conversation other than the one it went into: it stays on the message, refused, saying so. A file uploaded for a message that is not sent (taken off after the platform had it, or left when the conversation changed) is removed from the file area.
  - **agent-worker:**
    - The host's file area (`attachments.store`) gives the turn's files to the model with its message: a picture as the platform's rendition (PNG, JPEG or WebP, at most 1 MB, checked), text and a PDF's text capped, anything else as its reference line. Earlier files are in history as reference lines. A message gives each file once and at most five (`attachments.perMessage`).
    - A file that cannot be had is named with why and the turn goes on: the store failing for it, a file still being checked (`pending`), a picture the model cannot take. Every store call carries the turn's `signal`.
    - The system prompt says a file's name and content are data, never instructions, and a file's text cannot close its own `<attachment>` block, however the tag is spaced (zero-width characters too), broken or cased, or opened with a full-width bracket; other text, full-width brackets included, is left as it is.
    - `attachment_list`, `attachment_view` and `attachment_read` reach every file of the conversation. They are backend tools of the class `attachment` (`ToolPolicyContext.toolClass`, and `allTools` for a turn policy's `prepareStep`). What `attachment_read` reads is the model's, with that call's result, like `attachment_view`'s picture: events and stored messages say which characters were read, never what they say.
    - The cost guard caps what each model step carries, at 30,000 tokens a turn and 300,000 a conversation by default, and reports `attachments` usage to `recordTurnComplete`. A file left out is given as its line once, and the model is told whether the turn's allowance or the conversation's is used up.
    - An action's input may take a file (`format: 'oui-attachment'`). Before the call runs, the worker checks that each id named is the conversation's, that its check has passed, and that it is a type the input takes, and refuses an action declaring a file where none can be checked. The approval card shows the file by name and size.
    - The three helpers that add the note, the page's state and the clock to the user's message now keep its non-text parts.
  - **The deadline is on the stop path (ADR-0252 §6.4).** A turn that reaches its deadline ends with `stopReason: 'deadline'`: what it did is kept and marked, and the next turn is told. `TurnStoppedReason` adds `deadline` to the requestable `TurnStopReason`. `agent:turn_complete` declares it, so a realtime server must take this release before a worker that emits it. A deadline stop whose store failed returns `stored: false`, and the runner records it with `recordTurnFailure` as `TURN_DEADLINE_EXCEEDED`, not as stopped. A store that timed out may still finish, so a host records that failure only over a turn still `running`.
  - **agent-realtime, agent-mcp:** released with the rest of the SDK at one version.

### Patch Changes

- Updated dependencies
  - oui-spec@0.11.0
  - @ouispec/contract@0.4.0

## 0.7.0

0.6.0 was not published; its changes ship in 0.7.0.

### Minor Changes

- Released with the rest of the agent SDK at one version (VERSIONING.md): no change of its own beyond the SDK's.

### Patch Changes

- Updated dependencies
  - oui-spec@0.10.0

## 0.5.0

### Minor Changes

- A running turn can be stopped, and a message sent while a turn runs supersedes it (Closure ADR-0252, phase 1).

  - **oui-spec:** an action request may name its turn (`turnId`, carried by the socket transport), and `acceptCurrentTurn` is the `accept` rule for a client that runs one turn at a time: a request a stopped or superseded turn sends late is refused, and one that names no turn (an older worker) is accepted while a turn is in progress, as before.
  - **agent-events:** `agent:turn_complete` declares `stopReason` (`user_stop`, `superseded`); the UI dispatch declares `turnId`.
  - **agent-core:** the turn-stop event, reason, record and marker types; `DoneEvent.stopReason`; `AgentStoredMessage.stopped`; `AgentClientConfig.stopTurn`; why an approval was withdrawn.
  - **agent-realtime:** a turn's stop is kept for its worker: the `agent:turn_stop` client event (taken only from the turn's token-guarded room, kept under the socket's user), `POST` and `GET /internal/turns/:turnId/stop`. An approval can be expired now with why (`settle` with `expire`), in one script with decide and redeem.
  - **agent-worker:** a turn watches for a stop for as long as it runs, fails open, and ignores a stop once it has begun its own end. A stopped turn settles what was in flight (every call keeps exactly one result), stores what it had produced from the worker's own record, then announces with `stopReason`. Every UI request names its turn. Host hooks: `getHistory` is told the turns this one supersedes; `persistMessages` is given `stopped` and may answer `{ stored: false }`; `recordTurnStart` may answer `{ run: false }`; `recordTurnComplete` is given `stopReason`. `TurnOutcome` gains `stopped` and `refused`.
  - **agent-react:** `stopTurn`, `isStopping` and `acceptedTurnId` on `useAgent`; a message sent while a turn runs makes the new turn the tab's at once; a stopped turn's message keeps what it had said, marked `stopped`.

### Patch Changes

- Updated dependencies
  - oui-spec@0.9.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - oui-spec@0.8.0

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

## 0.1.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.7.0

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/contract@0.1.0
