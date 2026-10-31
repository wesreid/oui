# @ouispec/agent-worker

## 0.22.2

### Patch Changes

- **A choice is the question that follows a reply.**

  - **A choice ends the turn only when it ran.** A call to a tool that asks the person (`present_options`, `confirm_action`, `request_user_decision`) used to end the turn whether it ran or not. One that was refused by policy, invalid, or sent back now asked nothing, and the step goes back to the model.
  - **Policies are told what the turn has written.** `ToolPolicyContext.replyText` is every word the turn has written up to the call, as the model's stream gave it, including the words before the call in the same step. A turn policy's `prepareStep` gets each step's `text`.
  - **`requireReplyBeforeChoice`** (opt-in, `AgentRuntimeConfig` and the orchestrator's config). A `present_options` call made before the turn has written a word is sent back once, with `REPLY_BEFORE_CHOICE_ERROR`: write the reply, then offer the choice again. A second empty choice goes through, so a turn never ends with neither a reply nor its choice, and never loops. Measured on DEOS (2026-10-30): a third of turns ended on a choice card with no reply, whatever the prompt said.
  - **agent-evals.** `EvalAgentConfig` takes `requireReplyBeforeChoice`, and it is part of a recording's fingerprint. A turn's `choices` leave out a card the runtime sent back, since it was never shown.

## 0.22.1

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.11.0
  - @ouispec/agent-core@0.22.1
  - @ouispec/agent-events@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.10.0
  - @ouispec/agent-core@0.22.0
  - @ouispec/agent-events@0.22.0

## 0.21.0

### Minor Changes

- **Evals have a page that answers.** A suite, or a scenario in its place (`page: false` for none), declares the page its turns are sent from (`AgentEvalPage`, `agent-evals.json`). The harness runs it on a real oui-spec surface runtime in index form, sends every turn from wherever the page is (its snapshot as `oui`, its address as `currentPath`, and the product's knowledge for that page as `uiKnowledge` when the configuration gives it), and answers `ui_act`, `ui_describe` and `ui_read` from it, as the person's tab would, where every page action used to wait out its 20 seconds. Its surfaces are declared in the suite (each one's `routes`, its observations as `state`, and its actions, each with the `result` it answers, the `state` it leaves and the address it goes to, by `cases` on its input), or are the product's own: given its generated manifest (`defineEvals({ page: { manifest, knowledge } })`), a fixture names its controls by binding id (`controls`: value, live schema, rows, what a run does; `allControls` mounts the rest of a mounted surface's, empty), registered with a real binding registry and connected with `connectBindings` as the tab does. Going to a page is the bindings' own navigation surface, the manifest's or one made from the fixture's routes, so an address is checked as the product's runtime checks it. An approved page action is granted to the page as the approval store grants it to the tab. `createFixturePage` builds one for a product's own tests. With no page, a turn whose context carries a snapshot is told at once that the page is not responding.

  **A call no tool ran no longer breaks the next turn.** The worker stored a turn's tool results by position: a call with no result of its own (a tool the model invented, input that would not parse) moved every later result a call early, and the next turn put a result before its call, which the model's SDK refuses (`MissingToolResultsError`). Each call is now stored with its own result, by id, and a call no tool ran with the error the model was given for it (`notRun`). A history stored that way before is sent with each result after its call, and a call with no result stored is given one saying whether it ran is not known (`MISSING_RESULT`), where it was told `acknowledged`.

  **The product's own conversation store.** `defineEvals({ history })` plugs in the product's store (`EvalHistory`: `append`, `getHistory`, `persistMessages`), or its window over the whole conversation (`createMemoryHistory({ window })`: its cut of old tool results, its summary, its step context), so later turns read what its worker reads. The customer's message is appended before the turn runs, as a product's API stores it.

  **The agent's own settings.** `EvalAgentConfig` takes `modelProviderOptions`, `forcedToolChoice` and `uiActions` (its waits and how much of the page the model reads; the channel is the page's), and a recording knows them.

  **What a turn did, beyond its words.** New assertions: `calls` (each tool, or each page action through `ui_act` by its id or index name, called exactly `times`, or `min` to `max`, its arguments or input holding `args`); `usage` (bounds on `modelCalls`, `firstCallInputTokens`, every call's `callInputTokens`, the turn's `inputTokens` and `outputTokens`, and `cachedShare` of input read from the prompt cache, as the provider reported them); `choices` (the choice buttons offered: options and question matched, their `count`; `false` for none); and `page` (where the page is `at` after the turn, what `ran` on it, what did not). A turn's record carries its `usage`, its `choices` and its `page`. The SDK's interaction tools (`present_options`, …) run as they are when no stub answers them: they reach no backend.

  **A judge that answers.** A rubric's verdict is asked for as structured output (`Output.object`), which the provider gives its own way; an answer that is no verdict is read as text, then asked for again (`judgeOptions: { retries, maxOutputTokens }`, default 2 and 1024, where it was one try at 300 tokens). A judge that never gives one is reported apart from a failure: the failure's `kind` is `judge`, the case's `status` is `unjudged` (`JUDGE` in the report, an `error` in JUnit, `unjudged` in the report's counts), and the CLI exits 3 when nothing else failed. Every failure now carries its `kind` (`assertion`, `judge` or `case`).

  The scripted model in `@ouispec/agent-worker/testing` takes the usage a reply reports (`ScriptedReply.usage`: input, cached input and output tokens).

### Patch Changes

- @ouispec/agent-core@0.21.0
- @ouispec/agent-events@0.21.0
- @ouispec/bindings@0.9.0

## 0.20.3

### Patch Changes

- **A long list of cards keeps an index of its rows in the page state, never a bare count.** The generated page state declares `x-rows` on `shown`: a display's facts that describe one row of a list (a card each) are addressed by the row's `item.key`, called by its `item.title`, and indexed with their display's `id`. `x-rows` takes a dotted path to a row's property (`rowValue`, `indexRow` and the row lookup read one), and the bindings report each display's rows together (`factsByDisplay`). Over budget, the worker keeps a display's first rows and the rows an action just changed whole and the rest as index rows, as it does any declared list; when even the index does not fit, it says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time. A page generated before the declaration is indexed the same way.
- Updated dependencies
  - @ouispec/bindings@0.8.1

## 0.20.2

### Patch Changes

- **The assistant opens a page already filtered, in one call.** A page declares the query it reads from its address once, with `defineQuery` (`@ouispec/bindings`), and reads and writes it with `readQuery` and `writeQuery`: typed values, a value the page does not take falling back to its default, defaults left out of the address. The generator reads the declaration where the page, a component it renders or an app hook reads it, holds it to the new `page-query.json` schema, and the generated `app.navigate` takes `query` (one alternative per page, its routes in `x-routes`) and `params` (a route's `:parameters`, filled and encoded). `path` names each page's parameters, and the page's knowledge lists them. The runtime builds the address from the path, `params` and `query`, each part encoded, refuses a path that could leave the app (`//host`, a backslash, `.` or `..` segments) and a query parameter or value a declaring page does not take, naming what it takes, and does nothing, saying `alreadyThere`, when the person is already at that address. A build that declares no query is generated as before, with `params` added.

  **An action called as a tool runs once, through `ui_act`.** When the model calls an action of the page by its id as if it were a tool of its own (`app_navigate`), the worker runs it as the `ui_act` call it means, once, validated, judged by policy and approved as any `ui_act` call, instead of refusing it and having the model call it again. A name that is no action of the page is answered by the SDK as before.

- Updated dependencies
  - @ouispec/bindings@0.8.0
  - @ouispec/agent-core@0.20.2
  - @ouispec/agent-events@0.20.2

## 0.20.1

### Patch Changes

- @ouispec/agent-core@0.20.1
- @ouispec/agent-events@0.20.1
- @ouispec/bindings@0.7.0

## 0.20.0

### Minor Changes

- A live-call turn carries the person's page (`client.ui`). When the page sent its UI into the call, the call service puts its latest on every turn as `client: { ui: { buildId?, currentPath?, oui?, uiKnowledge? } }`, the names a typed turn from that page uses. `createLiveCallTurnHandler` reads it (`LiveCallTurnRequest.client`, `LiveCallClient`, `LiveCallClientUi`; at most 64 KiB, `LIVE_CALL_LIMITS.clientUiBytes`; unknown fields read past, a known field of the wrong type refused with 400 naming it) and puts `oui`, `uiKnowledge` and `currentPath` on the turn's context, so the turn's UI tools are the page's as on a typed turn. What the host's target `context` sets itself is kept. The handler's default `maxBodyBytes` is 128 KiB, so a turn with a page at its bound fits.

## 0.19.0

### Minor Changes

- A spoken "yes" approves an action on the person's page as a click on its card does, on `voice`, `phone` and `chat`.

  - **agent-worker:** on those channels a UI action is read back like any other call (the host's `spokenReadback` on a voice), with its card on the person's screen as well, and its approval is stored with the turn's room (`PendingApprovalInput.room`). The 0.18 note that a yes in the conversation does not count, and that the card is on the screen, stays only for SMS. `approvalConfirmedBy` and `READBACK_UI_APPROVAL_TOOL_NOTE` are new; the UI prompt rule says how each channel approves.
  - **agent-realtime:** when the engine decides `approve` on `voice`, `phone` or `chat` for a UI action stored with its room, the same script writes a single-use grant (two minutes at most, never past the approval) and the store pushes `agent:approval_granted` to that room. A tab claims it with `approval:claim` on its own socket: only the first claim from a socket of the approval's user in that room, before it expires, gets it (`used`, `forbidden`, `expired`, `unknown` otherwise). A decline in a conversation channel pushes `agent:approval_declined`. `/api/emit` and a client's relay refuse both events (`SERVER_SENT_EVENTS`). A withdrawn approval's grant can no longer be claimed. An SMS approve, or one of a UI action stored without a room, is still refused `channel`. Upgrade the realtime server before the worker: an older server refuses the room.
  - **agent-core:** `APPROVAL_CLAIM_EVENT`, `APPROVAL_PUSH_EVENTS`, `READBACK_UI_APPROVAL_CHANNELS`, `approvesUIByReadback`, `APPROVAL_GRANT_TTL_MS`, and the browser-safe `readApprovalGranted`, `readApprovalDeclined`, `approvalGrantRefusal` and `claimApprovalGrant` every tab takes a grant with. `grantApproval` in the client config may return the runtime's answer.
  - **agent-react:** the provider shows the card of a turn of the open conversation it did not start (a call's), checks a pushed grant against its conversation and rooms, claims it, and hands it to `grantApproval`; the card then says how the person decided (`labels.approvedBy`, `labels.declinedBy`) and offers no buttons.
  - **oui-spec:** `runtime.grantApproval` returns whether it took the grant and refuses one it holds or has used, or one already expired, so a replay never admits a second request. A request carrying an approval the tab was never given is refused on its receipt and neither run nor answered: with a conversation open in two tabs, only the tab holding the grant runs the action and answers.
  - **contract:** `ApprovalGrantedEvent`, `ApprovalDeclinedEvent`, `ApprovalClaimPayload`, `ApprovalClaimResult`, `ReadbackUIApprovalChannel`, and `room` on `PendingApprovalInput`; the events are declared among the platform's.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.19.0
  - @ouispec/agent-events@0.19.0
  - oui-spec@0.12.0
  - @ouispec/bindings@0.6.0

## 0.18.0

### Minor Changes

- A person on the staff can take a conversation from the agent, answer the customer as themselves, and hand it back, on every channel, live calls included; approvals follow the turn's channel; and a product's evals run as data in its CI.

  - **The hold (agent-realtime).** `GET`/`POST /internal/conversations/:id/hold`, `POST …/hold/release` and `POST …/messages`, on the internal key: your API calls them after its own check that this person may. One holder at a time (`409 held` names who); only the holder hands back unless your product releases it on its own authority; a staff message is announced only while its speaker holds the conversation. Taking it over stops every turn of the conversation, withdraws every approval of it still waiting, or approved and not yet used (`taken_over`, listed as `withdrawn` in the answer), and sends `agent:conversation_taken_over`; the hand-back sends `agent:conversation_handed_back`, and stored messages `agent:conversation_message`. `/api/emit` refuses all three. The stop record answers `taken_over` for a turn whose conversation is held (`GET /internal/turns/:turnId/stop?conversationId=`).
  - **The agent stops (agent-worker).** A turn running when its conversation is taken over stops at a safe point and keeps what it had produced, marked `taken_over`; one that arrives while it is held makes no model call and stores nothing; `runner.reply` does not answer a held conversation. `createHttpConversationClient` is your API's client for the hold routes.
  - **Live calls.** A turn of a held conversation answers `done { stopReason: 'taken_over' }` with no words, so the call service keeps the character quiet; one speaking when the conversation is taken over ends the same way; an opening is not greeted. The stop a live call adds no longer drops the conversation, so the hold is heard there too.
  - **Staff in the history.** Store a person's message with `role: 'staff'` and its `speaker`, and the take-over and hand-back as `staff` entries with `takeover`. `getHistory` returns them as a fourth kind of `TurnHistoryMessage`; the model reads them as the business's side of the conversation, under the person's name, never as its own words or the customer's. `historyOf` maps a turn's stored messages back to history.
  - **Approvals in the turn's channel.** The turn payload's `channel` (`ui` by default, or `chat`, `sms`, `voice`, `phone`) decides what the model is told: the card, or a readback the next message confirms. On a conversation channel the readback (a voice's `spokenReadback` when your preview wrote one) is the turn's last words, its `agent:token` pieces marked `readback: true`, and stored as the agent's. A live call's turns are `voice`, or `phone` (`LiveCallTurnTarget.channel`), and it sends the readback once, as its `readback` event. An action on the person's page is approved only by its card, on every channel: the model is told the card is on their screen, nothing is read back, and the approval store refuses a conversation channel's approve of it (`channel`); a spoken no still declines it. Hooks see the channel as `AgentTurnInfo.approvalChannel`.
  - **Both sides in React (agent-react).** With `conversationRoom`, `AgentProvider` follows the open conversation's room: `useAgent().hold`, staff messages with their `speaker`, the take-over and hand-back as `staff` entries, a waiting card cleared at the take-over, and no "working" or "done" status for a turn the hold stopped. `useStaffConversation(conversationId)`, with the `staff` seam, is the staff console: it loads the conversation, follows it live, takes over, sends and hands back.
  - **Events (agent-events, agent-core).** The reserved room `conversation` beside `turn`, `AGENT_CONVERSATION_EVENTS` in `PLATFORM_EVENTS`, `TurnStoppedReason` and `ApprovalWithdrawReason` gain `taken_over`, and agent-core has the take-over's shapes and what the model is told of each staff entry.
  - **Evals (new: agent-evals).** Scenarios as data (`agent-evals.json`), run against your real agent configuration (persona, tools, policies, and `beforeTurn`, `filterEvent` and your approval hooks) through the SDK's own runner, on every channel you serve, from recorded model responses in CI or against the live model. A stale recording, an unstubbed tool and every violated assertion fail. The `agent-evals` CLI and `evalCases` for a test runner; an example dealer suite on web chat, SMS and voice. `@ouispec/agent-worker/testing` adds `scriptedChatCompletions` and `conversationOf`.

  Update the realtime server first, then every worker (the Lambda and container adapters and the live-call handler), then your API's take-over routes and the React app. A worker older than this release does not ask for the hold, and would answer over the person who holds the conversation.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.18.0
  - @ouispec/agent-events@0.18.0
  - @ouispec/bindings@0.5.0

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
  - @ouispec/agent-core@0.17.0
  - @ouispec/agent-events@0.17.0
  - @ouispec/bindings@0.4.9

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
  - @ouispec/agent-core@0.16.0
  - @ouispec/agent-events@0.16.0
  - @ouispec/bindings@0.4.8

## 0.15.0

### Minor Changes

- A live call answered by the product's own agent. `createLiveCallTurnHandler({ runner, credential, resolveTurn, opening?, keepAliveMs? })` is a Node `(req, res)` handler a product mounts on its own server, and `startContainerAgentWorker` serves it at `liveCall.path` (default `/live-call/turns`) from the same runtime and turn slots. Each request is one turn of the call (`sessionId`, `clientRef`, `turnId`, `kind`, `text`, `input`, `output`, `supersedes`) with the call service's bearer credential. `input` is `{ mode: 'voice', language? }` for what the person said, and `{ mode: 'text' }` for a message they typed during the call, which runs as typed (no spoken-input line) while `output: { mode: 'voice' }` still applies. The host's `resolveTurn` maps the call's `clientRef` to the conversation, user and realtime room, and the turn runs on the same runtime as every other turn, so it still streams to the conversation's room and every page joined to it receives the reply and every UI action. The handler answers `200 text/event-stream` from the turn's own events (`TurnHost.observe`, `teeEmitAdapter`): `text` with the reply as it is written, `readback` with an approval preview's verbatim readback once the turn has ended, `done` with how it ended, `error` with a code and a fixed line, and `: keep-alive` comments while it is silent. A closed connection stops the turn as a superseding message does (`TurnHost.stopSignal`, `withLocalStop`), and `supersedes` reaches the turn's `getHistory`. An `opening` turn greets, from the model or from the product's template (`runner.reply`, a turn answered with the host's text). The approval store client gains `decide` for a conversation channel's decision on a readback.

  A reply that will be spoken is written for the ear: a turn whose `context.output` is `{ mode: 'voice' }` (`REPLY_OUTPUT_CONTEXT_KEY`, `readReplyOutput` in agent-core) is told, after the conversation, to speak in short plain sentences with no markdown, lists, links or emoji, to say numbers, prices and dates as they are said, and to show what the person should look at through the page instead of reading it out. The system prompt, the tools and every message stay byte for byte the same, so a conversation's chat and call turns share the prompt cache.

  Text the model said before a tool call or an approval now reaches the room before that call's events: the text held for coalescing is sent first.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.15.0

## 0.14.0

### Minor Changes

- A turn's progress, for every view that shows it. The worker relays the model's thinking to the turn's room (`agent:reasoning_started`, `agent:reasoning_delta` with the summary when `modelProviderOptions` asks the model for one, `agent:reasoning_ended`; nothing is stored or sent to the model differently) and says how a turn ended (`endReason` on `agent:turn_complete`). `useAgentStatus()` gives one status (idle, working, needs-you, done, problem) with what the assistant is doing ("Planning…", "Draw a shape · 12", from `config.toolLabels`) and `clearDone`; `useAgent().reasoning` holds the thinking blocks. agent-core's `agentWorkRuns`, `currentWorkStep`, `workLabel`, `formatWorkStep` and `humanizeToolName` are the one definition of the assistant's work as a person reads it.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.14.0
  - @ouispec/agent-events@0.14.0
  - @ouispec/bindings@0.4.7

## 0.13.1

### Patch Changes

- README and docs cleanup.
- Updated dependencies
  - @ouispec/agent-core@0.13.1
  - @ouispec/agent-events@0.13.1
  - @ouispec/bindings@0.4.6
  - oui-spec@0.11.1

## 0.13.0

### Minor Changes

- A turn hands back before its time runs out. Before each step the worker checks that a step as long as the turn's longest so far, plus `handBackReserveMs` (default 30 s, at most a quarter of the deadline), still fits before `turnDeadlineMs`. When it does not, that step is the turn's last: the model is told to say what is done and what is left and to offer to continue (`present_options` when the host gives it, in words otherwise), the turn policy is not asked about it, and the turn ends with `stopReason: 'time_limit'`. The deadline still stops a step that runs longer than any before it. The runner takes `handBackReserveMs` and passes it on.

## 0.12.2

### Patch Changes

- **A question is answered in words.** The tool strategy's new "Answering Questions" rule and `present_options`' description say that a question (what something is, how it works, why) is answered in the reply. A card is never the answer: it only follows when a choice does, and a question asked again is answered, not met with another offer. On Closure's dev, a person asked "What is the push channel?" twice and got only a card offering to set one up (`textLength: 0` both times). The new live eval `ui-questions` asks that question fresh, after a card, and again after a card that didn't answer it, under the neutral persona (12/12). With Closure's persona it fails before the rule and passes after (16/16). Its control, "set one up", still sets one up.

  **`ui_guide` finds the entry a name means.** It tries, in order: the exact title; the title in any case; the one page entry whose title, less its route, is the name ("Experience Studio" for "Experience Studio (/distribution/experiences/:partId)"); and the one entry the name begins (`findNamed`). A name that two entries could mean finds neither, and the error still lists them all.

  **An option says what it means.** `ControlOption.description` is new: what choosing the option means, as the control shows it beside its title. `deriveInputSchema` names it with the option (`token = Recipient token (A field of the recipient, such as {{firstName}})`) for choices, tabs and multi-choices, live and generated alike (`describeOption`). The generator reads it from source through a control table's new `OptionsSource.description` key, and a tier 2 mapping's options through `mappedOptions`.

  `liveTurn` (evals) takes the conversation before the message, the client's knowledge and a product's persona.

- Updated dependencies
  - @ouispec/bindings@0.4.5

## 0.12.1

### Patch Changes

- `@ouispec/agent-worker/history` exports `answerWithoutState` and `STATE_AT_END` from a module with no runtime imports, and answers a CommonJS resolver (`default`). A host's history code, and its tests, fit stored answers without loading the model SDK.

## 0.12.0

### Minor Changes

- A forced step on a model that refuses a forced tool choice, and a budget for what the model reads of one action's result.

  - `forcedToolChoice: false` (worker and runtime config), for a model that answers 400 to a forced choice (Claude Sonnet 5.5: "tool_choice: type "tool" and "any" are not supported"). A step the turn policy forces to a tool is sent no tool choice: it is given only that tool and told to call it. A turn that reached its step limit failed outright.
  - An action's result is fitted to 24,000 characters for the model (`ui.maxAnswerDataChars`, `answer-fit.ts`). Over it, the longest lists are cut to their first rows, then the longest texts, and `resultCut` says what each had. On dev, answers of 88 KB and 107 KB made one step 168,155 tokens.
  - `answerWithoutState` is exported, for a host that fits answers stored before 0.11.
  - New live eval `evals/forced-step.live-eval.ts`.

## 0.11.0

### Minor Changes

- Every step reads the conversation from the prompt cache. On dev, 49% of PA input was written to the cache again or sent uncached.

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

- A message the person spoke says so.

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

- Two notes from the review of the attachments release.

  - **agent-worker:** a file's text cannot close its `<attachment>` block with a left-to-right or right-to-left mark (U+200E, U+200F) inside the tag either: direction marks join the characters skipped between `<`, `/` and `attachment`.
  - **agent-core:** `attachmentRefusal` names the kind it refuses as a sentence does: "an image file", "a text file", "a PDF", "a file" (it said "a image file").

- Updated dependencies
  - @ouispec/agent-core@0.8.1

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

- A model call carries less, and ordinary editing is not capped.

  - The client's knowledge is bounded in the system prompt (`KNOWLEDGE_PROMPT_CHARS`, 12,000): small entries whole, a large entry cut at a line with how much is left, workflows listed by name. The new `ui_guide` tool reads the rest of an entry a page at a time, or a workflow with its steps. The video editor's knowledge went from 117,000 characters to 11,300.
  - Only the newest UI answer carries the page's state to the model; every earlier answer keeps what it did and says where the state is. `Turn usage` logs `ui.pageStatesNotRepeated`.
  - UI actions are no longer counted against a per-tool quota of 12. A loop is refused instead (`repeatedCall`): the same call with the same input, once it has changed nothing three times in a row (it failed, the page said no row changed, or the page's state was the same as after its last run). Undo five times runs five times. `ui_guide` calls are counted as `ui.guides` in `Turn usage`. Backend tools keep their quotas.

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
