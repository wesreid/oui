# @ouispec/agent-worker

## 0.11.0

### Minor Changes

- Every step reads the conversation from the prompt cache (ADR-0263). On dev, 49% of PA input was written to the cache again or sent uncached.

  - A breakpoint on the conversation's end moves forward every step, so the next step and the next turn read it. A turn's own calls were paid in full at every later step.
  - What is true only now goes after the conversation, in one message per step that is never cached or stored: the page's values (`<page_state>`), the clock, that the message was spoken, expired approvals, the host's step context and the step's notes (`<step_note>`). Notes in the system prompt, and per-turn additions to the user's message, made a turn write the conversation again.
  - The page's index follows the system prompt (`<page_index>`), with its own breakpoint.
  - Every answer gives its page state up the same way, as it arrives and when stored (`pageState`), so an answer never changes once sent. The newest state of the turn is read in `<page_state>`.
  - `getHistory` may return `{ messages, stepContext }`; `AgentTurnInput.stepContext` is read at the end of every step.
  - `Step completed` logs carry `inputTokens`, `cacheReadTokens` and `cacheWriteTokens`; the turn's usage log reports `pageStatesMoved`.
  - New live eval `evals/prompt-cache.live-eval.ts`.

## 0.10.1

### Patch Changes

- A step that reaches the output limit before it says or calls anything no longer ends the turn silently. The default output limit is 32,000 tokens per response (was 4,096): a model that thinks spends its thinking from it, and on dev a request that needed planning used all 4,096 thinking, twice, so the turn ended having said, done and stored nothing. Such a step's output is discarded and it runs once more, told to plan less; if that is cut off too, the person is told and the turn ends with `stopReason: 'output_limit'`. The runtime no longer sets its own 4,096 default over the orchestrator's. `Step completed` logs carry `finishReason` and `outputTokens`.

## 0.10.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.10.0

## 0.9.0

### Minor Changes

- A message the person spoke says so (ADR-0259 §2.6).

  - `@ouispec/agent-core`: `MessageInput` (`{ mode: 'voice', language? }`), `readMessageInput` (an unknown mode is read as typed; a language that is not a BCP 47 tag of at most 16 characters is left out) and `MESSAGE_INPUT_CONTEXT_KEY`. `AgentMessageContext.input` and `AgentStoredMessage.input` carry it.
  - `@ouispec/agent-react`: `sendMessage(content, { attachments?, input? })`. An array as the second argument still gives the message's files. `input` reaches `config.sendMessage` as `context.input` and stays on the message (`AgentMessage.input`, the session record, and a restored message). A spoken message sent while a turn runs supersedes it as a typed one does.
  - `@ouispec/agent-worker`: a turn whose `context.input` says the message was spoken adds one line to the newest user message, after the person's words and before the clock: it was spoken and machine-transcribed, may contain recognition errors, the language detected, and to ask rather than guess when a likely mis-hearing makes the request ambiguous. Typed messages, malformed inputs and an approval card's turn get nothing. The message's files keep their parts. `input` is kept out of the context the host's prompt sees, so the cached prefix is the same for a spoken message as for a typed one.
  - `@ouispec/contract`: the integrator guide says `sendMessage` passes `context.input` and that the product stores it with the message.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.9.0

## 0.8.3

### Patch Changes

- A reply written in rounds streams as paragraphs. Where a round that said something ended in tool calls and more text follows, the token stream carries a paragraph break (`\n\n`), so "Adding the file now." and "I added it." no longer reach the person as "now.I added". The break goes where the round's text ends in the turn's text, not when the SDK reports the round's end, because the text stream can still be delivering that round's text. It is only streamed: each round is still stored as the model said it.

## 0.8.1

### Patch Changes

- Two notes from the review of the attachments release (ADR-0252).

  - **agent-worker:** a file's text cannot close its `<attachment>` block with a left-to-right or right-to-left mark (U+200E, U+200F) inside the tag either: direction marks join the characters skipped between `<`, `/` and `attachment`.
  - **agent-core:** `attachmentRefusal` names the kind it refuses as a sentence does: "an image file", "a text file", "a PDF", "a file" (it said "a image file").

- Updated dependencies
  - @ouispec/agent-core@0.8.1

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
- Updated dependencies
  - oui-spec@0.11.0
  - @ouispec/bindings@0.4.0
  - @ouispec/agent-core@0.8.0
  - @ouispec/agent-events@0.8.0

## 0.7.0

0.6.0 was not published; its changes ship in 0.7.0.

### Minor Changes

- A UI action that starts work (a GPU job, an export) no longer holds the turn open until the work ends. The call waits for its outcome for at most 20 s, or the action's own limit, or until the turn must answer, whichever comes first. Work that ends within that time is reported done in the call. Work still going is reported still running, and the turn goes on and ends. Meanwhile the person can stop the turn, and the assistant can do something else, including cancelling that work. The outcome reaches the conversation through the page state of a later turn.

  The wait is settable as `ui.jobWaitMs` on `runAgentTurn`'s config and `uiActions.jobWaitMs` on the Lambda handler's. `DEFAULT_JOB_WAIT_MS` is now 20 s, where it was 5 min, so an action that declares no limit is not held for 5 min either.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.10.0
  - @ouispec/bindings@0.3.3
  - @ouispec/agent-core@0.7.0
  - @ouispec/agent-events@0.7.0

## 0.6.0

### Minor Changes

- A model call carries less, and ordinary editing is not capped (session 24611234).

  - The client's knowledge is bounded in the system prompt (`KNOWLEDGE_PROMPT_CHARS`, 12,000): small entries whole, a large entry cut at a line with how much is left, workflows listed by name. The new `ui_guide` tool reads the rest of an entry a page at a time, or a workflow with its steps. The video editor's knowledge went from 117,000 characters to 11,300.
  - Only the newest UI answer carries the page's state to the model; every earlier answer keeps what it did and says where the state is. `Turn usage` logs `ui.pageStatesNotRepeated`.
  - UI actions are no longer counted against a per-tool quota of 12. A loop is refused instead (`repeatedCall`): the same call with the same input, once it has changed nothing three times in a row (it failed, the page said no row changed, or the page's state was the same as after its last run). Undo five times runs five times. `ui_guide` calls are counted as `ui.guides` in `Turn usage`. Backend tools keep their quotas.

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
  - @ouispec/agent-events@0.5.0
  - @ouispec/agent-core@0.5.0
  - @ouispec/bindings@0.3.1

## 0.4.0

### Minor Changes

- A call whose approval expired without the call having run is settled at the start of a later turn.

  - **What was wrong:** an approval card that expires disables its buttons and sends nothing, so no turn ever stored how the call ended. Every later turn read "waiting for approval… has not run", and the assistant could not say the approval had expired.
  - **Now:** at the start of a turn the worker finds the calls the history still shows as waiting (their last stored result is the "waiting" placeholder) and asks the approval store about each, as this user and conversation. Only the store's explicit answer settles one:
    - `claimed`: the "expired, not run" result is given to the model in place of "waiting" and returned in `newMessages` under the call's own id, with `settledApprovals` naming it.
    - `already` (another turn holds the claim, or it is stored): the model is told for this turn, and nothing is stored.
    - `open` and `unknown`: the call is left as it is.
  - **Approved, and never run:** when the user had approved the call and the turn that would have run it never did, the store says so (`decided: "approved"`). The stored result then reads `approval: { decided: "approved", by: "user", ran: false, expired: true }`, and the model is told the user approved it but it expired before it ran, so to ask before running it again. It is not told that nobody decided.
  - **Expiry is the store's to decide**, on its own clock. The worker's clock is not consulted.
  - **A claim is a lease.** After the host has stored the turn's messages, the turn runner confirms each claim (`confirmExpirySettled`). A turn that dies, or a host whose write fails, confirms nothing; the claim lapses after two minutes and a later turn stores the result. A host that calls `runAgentTurn` itself confirms `result.settledApprovals` after persisting.
  - **Two rows are possible, rarely.** If a turn's claim lapses while its host is still storing (more than two minutes), a second turn can claim and store the same result. The worker's own history conversion gives the model one result per call (the last), and so must a host that reads its store some other way: keep the last result of a call id.
  - **A history that does not hold the stopped turn yet** has no waiting call in it, so nothing is asked.
  - **The newest five waiting calls** are asked about per turn; the store is called once for each, in parallel. A store that cannot be reached, or that has no `settleExpired`, settles nothing.
  - **New in `@ouispec/agent-core`:** `ApprovalSettlement`, `ApprovalSettleOutcome`, `ApprovalOwner`, `EXPIRED_APPROVAL_MEMORY_MS`, `EXPIRY_CLAIM_LEASE_MS`. New, optional, on `ApprovalStoreClient`: `settleExpired` and `confirmExpirySettled`.
  - **Rollout:** the worker and the realtime server ship in either order. Against a realtime server without `POST /internal/approvals/:id/settle` the worker reads its 404 as `unknown`, and nothing is settled.
  - **Approvals created before the realtime server is upgraded stay "waiting"**: the store has no memory of them.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.4.0

## 0.3.1

### Patch Changes

- A turn's messages are stored before the client is told the turn is complete.

  The runner announced `turn_complete` and then called the host's `persistMessages`. A message sent in that gap was answered from a history without the turn that had just finished: asked to rename a draft and then delete it, with one second between, the model renamed it again (three runs of three on a live deployment; none with a six-second gap).

  - `AgentWorkerConfig.beforeTurnComplete` is called with the turn's `rounds`, `usage` and `newMessages` after the last step and before `turn_complete` is emitted, and is awaited. A rejection is logged and the turn still completes.
  - `createAgentTurnRunner` calls `persistMessages` there, once. `recordTurnComplete` now runs after the messages are stored, where it ran before them, so a host reading the turn's stored messages in it finds them.

  A host whose `persistMessages` does slow work beyond storing the messages (a summary, a model call) should move that work to `recordTurnComplete`: what `persistMessages` awaits now delays `turn_complete`.

## 0.3.0

### Minor Changes

- 86c3f55: A call that waited for approval says, in its stored result, how the approval ended.

  - **What was wrong:** once the approved run's result replaced "waiting for approval", nothing in the history said an approval had happened. On the next turn the assistant could not tell the person had approved anything, and took back having said so. A declined or expired approval left the call showing "waiting for approval" on every later turn.
  - **Approved:** the result carries `approval: { decided: "approved", by: "user", at, ran, summary }` first, with the summary "Approved by the user on the approval card, and run once." An object result gains the field; any other result is kept beside it as `result`.
  - **Declined:** the continuation turn stores, under the call's own id, a result with `approval.decided: "declined"`, `notRun: true` and "Declined by the user on the approval card. It was not run."
  - **Expired:** the same with `approval.decided: "expired"` (no `by`: nobody decided it) and "The approval expired before it was used. It was not run."
  - **Approved but unavailable or refused when run:** `approval.decided: "approved"`, `ran: false`.
  - **An approval already used** leaves the call's result as it is: that run's result stands.
  - **Hosts:** a continuation turn can now persist a `tool` message for a decline or an expiry too, under the original call id. A host that gives the model the last stored result of a call (as the worker's own history conversion does) needs no change.
  - **Tests:** the model's history in the continuation turn and on a later turn read back from the store, for approved, declined, expired and already-used.

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
