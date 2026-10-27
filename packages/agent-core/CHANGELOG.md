# @ouispec/agent-core

## 0.17.0

### Minor Changes

- An approved call carries a signed receipt that the tool's own API verifies.

  The approval token proves the user's decision inside the product, but a tool's API could not check it: the token is HS256, so whoever verifies one can sign one, and redemption deletes the record before the tool's request arrives. Now, when the realtime server redeems a token, it also signs a **receipt**: this user approved exactly this call, in this conversation, and it was redeemed just now.

  - **The receipt.** A compact JWS, header `{ "alg": "EdDSA", "typ": "oui-approval-receipt+jwt", "kid" }`, signed with an Ed25519 key only the realtime server holds. Claims: `iss`, `aud`, `approvalId`, `argsHash`, `tool`, `operationId` (a generated API tool's), `conversationId`, `userId`, `accountId`, `channel`, `iat`, `exp` (`iat` + 120) and `jti`. `ApprovalReceiptClaims` in the contract's `approvals.json`.
  - **agent-realtime.** `approvals.receiptKeys` (Ed25519 private JWKs, each with a `kid`, exactly one `active`), `approvals.receiptIssuer` (the server's public base URL, every receipt's `iss`) and `approvals.defaultAudience` (the product's own API origin) turn receipts on; the three go together, and the server refuses to start on a key whose public part is not its private key's, a key id listed twice, or anything but one active key. `POST /internal/approvals/redeem` answers `{ call, receipt }`, signed for the audience fixed when the approval was stored: the pending approval's `audience`, or `defaultAudience` for a host tool that names none; a UI action (`toolKind: 'ui'`) gets none. A pending, declined, expired, withdrawn or replayed approval never gets one. `GET /.well-known/oui-approval-jwks.json` publishes the public keys to any origin, with `Cache-Control: public, max-age=3600`. `RealtimeServerInstance.setReceiptKeys` rotates without a restart (add a key, make it active an hour later, remove the old one an hour after that). `generateApprovalReceiptKey` makes a key. The pending approval accepts `accountId`, `toolKind`, `operationId` and `audience`: **update the realtime server before the worker**, since an older one refuses those fields and no approval can be asked for.
  - **agent-worker.** The approved call's context carries the receipt as `ctx.approval.receipt`, beside `approvalId` and `argsHash`, and only that call does. The OpenAPI executor sends it as the `OUI-Approval-Receipt` header (a header of that name from `actAs` is dropped). A generated API tool names its server's origin as its `approvalAudience` and its `operationId`; a host tool may declare `approvalAudience` (an origin), and one that is not an origin is refused before approval. A UI action's request never carries a receipt. The pending approval now names the turn's `accountId` and the tool's kind.
  - **agent-core.** `verifyApprovalReceipt(jws, { jwks, expectedArgsHash, audience })` → `{ ok: true, claims }` or `{ ok: false, reason, error }`, on WebCrypto in Node and the browser build. `jwks` is the document or its URL, which is cached for its `max-age` and read again for an unknown `kid` at most once a minute. It checks the header (only `EdDSA` with this `typ`, a `kid`, no `crit`), the key, the signature, the claims, `exp` and `iat` with 60 s of skew, `aud`, then `argsHash`; the reasons are `malformed`, `key`, `signature`, `expired`, `audience` and `args`. `@ouispec/agent-core/receipt-vectors.json` holds 21 receipts, the keys they were signed with and the result each must give, for an implementation in any language. Also `APPROVAL_RECEIPT_HEADER`, `APPROVAL_RECEIPT_JWKS_PATH`, `APPROVAL_RECEIPT_TTL_SEC` and `approvalReceiptAudience`.

  Single use is the tool's: it records each `jti` it acts on for at least two minutes and never acts twice on one.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.17.0
  - @ouispec/contract@0.4.9

## 0.16.0

### Minor Changes

- Seams for a product that answers its own customers: what the model reads, what leaves the runtime, what a caller hears, and the words of an approval.

  - **Text before a tool call is shown and spoken, and the prompt now says so.** The base rule used to tell the model that text written before a tool call is cleared from view when the tool runs. Nothing clears it: the chat keeps it and a live call speaks it, so models wrote their reasoning there. The rule now says it reaches the person, and asks for at most one brief line meant for them before a tool call, or nothing, and never reasoning.
  - **Every round of a turn is announced.** Each `agent:token` carries `step`, its round, and `agent:round_end { turnId, step, calledTools, final }` follows each round once all of its text has been sent. `final` says no round follows: a round that ends at an approval, a choice for the person, the hand-back for time or the last step allowed is final though it called a tool; a round cut off at the output limit having said nothing never is. Declared in `PLATFORM_EVENTS` (`AGENT_TURN_EVENTS.ROUND_END`) and parsed by agent-core (`RoundEndEvent`, `TokenEvent.step`). Update the realtime server with the worker: an older one refuses `agent:round_end` as undeclared.
  - **`beforeTurn(payload, info)`** on the runtime config runs before every turn on every channel (the Lambda adapter, the container's `/turns`, the live-call handler, or a host's own `runner.run`). It returns the payload to run (the person's words redacted before the model reads them) or null to refuse the turn, which then does nothing and reports `refused` with `refusedBy: 'beforeTurn'` (a live call answers `TURN_DECLINED`). `TurnOutcome`'s `refused` now always says `refusedBy` (`record` or `beforeTurn`). `TurnHost.channel` names how a turn came; the adapters set `lambda`, `container` and `live-call`, and a host calling `run` names its own (default `direct`).
  - **`filterEvent(event, data, turn)`** on the runtime config decides what of each turn event leaves the runtime, before the room, an observing host and the live-call handler see it: the payload to send (a copy), or null. It fails closed: an event it throws on is not sent. `filterEmitAdapter` is exported.
  - **The turn every hook is told of** (`AgentTurnInfo`: `id`, `channel`, `inputMode`, `language`; `turnInfoOf`): `beforeTurn`, `filterEvent`, the approval hooks, and the turn policy (`classifyTurn(content, history, turn)`, `turn` on `prepareStep` and `onTurnClassified`).
  - **`approvals.validateBeforeApproval(tool, args, ctx)`** checks a call that needs approval before it is read back; `{ ok: false, error }` refuses it, and the model gets `error` as the call's result. **`approvals.preview(tool, args, ctx)`** writes the approval's display copy (`ctx.built` is the declaration's, `ctx.locale` the language the person spoke in): what the store keeps with the call, what `agent:approval_required` carries and what is read back, with `spokenReadback` for a voice. The stored arguments and `argsHash` stay the model's. Both fail closed. Of the calls in one response only the first that needs approval is asked for; a call arriving while its check runs waits for the outcome.
  - **`ApprovalPreview.spokenReadback`** in the contract's `approvals.json`, accepted by the realtime approval store; `APPROVAL_PREVIEW_LIMITS` in agent-core is the one statement of the preview's limits, which the store and the worker both hold a preview to.
  - **`persona.renderContext(ctx)`** renders the turn's context in place of the SDK's "CURRENT UI CONTEXT", or returns null for no section.
  - **Live calls.** `LiveCallTurnTarget.content` is what the model reads in place of `request.text`. `speak: 'all' | 'final-round'` (default `all`): with `final-round` only the round the turn ends with is spoken, and `holdingLine` (a string, or a function of the request and target) is spoken once as the turn's first tool starts. The readback is the preview's `spokenReadback` when the host wrote one. An `opening` request may carry `disclosureLine`, what the call service has just said, and the model greets following on from it (`liveCallOpeningMessage(request)`). `output.voiceDirections: { engine, tags, guidance }` (agent-core `VoiceDirections`, `readVoiceDirections`) offers the voice's inline tags to the model in the spoken-reply rule.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.16.0
  - @ouispec/contract@0.4.8

## 0.15.0

### Minor Changes

- A live call answered by the product's own agent. `createLiveCallTurnHandler({ runner, credential, resolveTurn, opening?, keepAliveMs? })` is a Node `(req, res)` handler a product mounts on its own server, and `startContainerAgentWorker` serves it at `liveCall.path` (default `/live-call/turns`) from the same runtime and turn slots. Each request is one turn of the call (`sessionId`, `clientRef`, `turnId`, `kind`, `text`, `input`, `output`, `supersedes`) with the call service's bearer credential. The host's `resolveTurn` maps the call's `clientRef` to the conversation, user and realtime room, and the turn runs on the same runtime as every other turn, so it still streams to the conversation's room and every page joined to it receives the reply and every UI action. The handler answers `200 text/event-stream` from the turn's own events (`TurnHost.observe`, `teeEmitAdapter`): `text` with the reply as it is written, `readback` with an approval preview's verbatim readback once the turn has ended, `done` with how it ended, `error` with a code and a fixed line, and `: keep-alive` comments while it is silent. A closed connection stops the turn as a superseding message does (`TurnHost.stopSignal`, `withLocalStop`), and `supersedes` reaches the turn's `getHistory`. An `opening` turn greets, from the model or from the product's template (`runner.reply`, a turn answered with the host's text). The approval store client gains `decide` for a conversation channel's decision on a readback.

  A reply that will be spoken is written for the ear: a turn whose `context.output` is `{ mode: 'voice' }` (`REPLY_OUTPUT_CONTEXT_KEY`, `readReplyOutput` in agent-core) is told, after the conversation, to speak in short plain sentences with no markdown, lists, links or emoji, to say numbers, prices and dates as they are said, and to show what the person should look at through the page instead of reading it out. The system prompt, the tools and every message stay byte for byte the same, so a conversation's chat and call turns share the prompt cache.

  Text the model said before a tool call or an approval now reaches the room before that call's events: the text held for coalescing is sent first.

## 0.14.0

### Minor Changes

- A turn's progress, for every view that shows it. The worker relays the model's thinking to the turn's room (`agent:reasoning_started`, `agent:reasoning_delta` with the summary when `modelProviderOptions` asks the model for one, `agent:reasoning_ended`; nothing is stored or sent to the model differently) and says how a turn ended (`endReason` on `agent:turn_complete`). `useAgentStatus()` gives one status (idle, working, needs-you, done, problem) with what the assistant is doing ("Planning…", "Draw a shape · 12", from `config.toolLabels`) and `clearDone`; `useAgent().reasoning` holds the thinking blocks. agent-core's `agentWorkRuns`, `currentWorkStep`, `workLabel`, `formatWorkStep` and `humanizeToolName` are the one definition of the assistant's work as a person reads it.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.14.0

## 0.13.1

### Patch Changes

- README and docs cleanup.
- Updated dependencies
  - @ouispec/agent-events@0.13.1
  - @ouispec/contract@0.4.6
  - oui-spec@0.11.1

## 0.10.0

### Minor Changes

- A conversation that began by voice says so in the history. `AgentConversationSummary.previewInput` is how the message its `preview` is taken from was entered, and `AgentConversationMatch.input` how a matched message was: `{ mode: 'voice', language }` for one the person spoke. `@ouispec/agent-react`'s history (`refresh`, `query`, `rename`, `update`) keeps only what `readMessageInput` recognises (`readConversationSummary`, exported), so a list can mark a spoken conversation and match. The integrator guide names both fields.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.4.2

## 0.9.0

### Minor Changes

- A message the person spoke says so.

  - `@ouispec/agent-core`: `MessageInput` (`{ mode: 'voice', language? }`), `readMessageInput` (an unknown mode is read as typed; a language that is not a BCP 47 tag of at most 16 characters is left out) and `MESSAGE_INPUT_CONTEXT_KEY`. `AgentMessageContext.input` and `AgentStoredMessage.input` carry it.
  - `@ouispec/agent-react`: `sendMessage(content, { attachments?, input? })`. An array as the second argument still gives the message's files. `input` reaches `config.sendMessage` as `context.input` and stays on the message (`AgentMessage.input`, the session record, and a restored message). A spoken message sent while a turn runs supersedes it as a typed one does.
  - `@ouispec/agent-worker`: a turn whose `context.input` says the message was spoken adds one line to the newest user message, after the person's words and before the clock: it was spoken and machine-transcribed, may contain recognition errors, the language detected, and to ask rather than guess when a likely mis-hearing makes the request ambiguous. Typed messages, malformed inputs and an approval card's turn get nothing. The message's files keep their parts. `input` is kept out of the context the host's prompt sees, so the cached prefix is the same for a spoken message as for a typed one.
  - `@ouispec/contract`: the integrator guide says `sendMessage` passes `context.input` and that the product stores it with the message.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.4.1

## 0.8.2

### Patch Changes

- The browser entry exports the attachment helpers. 0.8.1's `dist/browser.js` left out the attachments module, so a browser build of `@ouispec/agent-react` 0.8.0 (Vite, webpack, esbuild: anything honouring the `browser` condition) failed on `DEFAULT_ATTACHMENT_LIMITS`, while tests and typechecks, which resolve the main entry, passed. A test now holds the browser entry to the main entry less the Node-only schema loader.

## 0.8.1

### Patch Changes

- Two notes from the review of the attachments release.

  - **agent-worker:** a file's text cannot close its `<attachment>` block with a left-to-right or right-to-left mark (U+200E, U+200F) inside the tag either: direction marks join the characters skipped between `<`, `/` and `attachment`.
  - **agent-core:** `attachmentRefusal` names the kind it refuses as a sentence does: "an image file", "a text file", "a PDF", "a file" (it said "a image file").

## 0.8.0

### Minor Changes

- The person can give the assistant files. A file is uploaded to the platform's file area first and travels by reference: no file's bytes go with a message, a turn, an event or a stored record.

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
  - **The deadline is on the stop path.** A turn that reaches its deadline ends with `stopReason: 'deadline'`: what it did is kept and marked, and the next turn is told. `TurnStoppedReason` adds `deadline` to the requestable `TurnStopReason`. `agent:turn_complete` declares it, so a realtime server must take this release before a worker that emits it. A deadline stop whose store failed returns `stored: false`, and the runner records it with `recordTurnFailure` as `TURN_DEADLINE_EXCEEDED`, not as stopped. A store that timed out may still finish, so a host records that failure only over a turn still `running`.
  - **agent-realtime, agent-mcp:** released with the rest of the SDK at one version.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.11.0
  - @ouispec/contract@0.4.0
  - @ouispec/agent-events@0.8.0

## 0.7.0

0.6.0 was not published; its changes ship in 0.7.0.

### Minor Changes

- Released with the rest of the agent SDK at one version (VERSIONING.md): no change of its own beyond the SDK's.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.10.0
  - @ouispec/agent-events@0.7.0

## 0.5.0

### Minor Changes

- A running turn can be stopped, and a message sent while a turn runs supersedes it (phase 1).

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

## 0.2.2

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
