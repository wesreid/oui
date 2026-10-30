# @ouispec/contract

## 0.11.0

### Minor Changes

- Every display a page shows is in its manifest, and a frame on every page says so.

  - **The generator records every `useAgentFacts` a page reaches.** The app's own calls, in a component (a `<ReportFacts agent={…} />` the page renders) or an app hook, are read where the page reaches them, and their binding is followed through the props that pass it down to where it is written, a binding built from those props (`id: factsId`, `PRODUCT_META[product].title`) included, and a design-system display's binding the same. Props a component destructures in its body (`const { tableAgent } = props as TableProps`) are followed as those it destructures in its parameter. A binding the build cannot read fails `generate --check`, where it is written: the page would report facts its manifest does not record.
  - **A control table declares every display, not only a description list.** `display` no longer needs `itemsProp` and `labelKey` (`labels` names the facts it always reports), and sits beside `kind`, `slots` or `entries`: a card bound to open reports under the same binding; a composite under its `slot` binding (`facts`) when the page gives one, else under the first of its `parts` the page bound. The conformance kit checks a composite display reports under that binding.
  - **A display may share its id** with the control whose rows it describes, or with itself shown from several places, described the same way everywhere; one id described two ways fails.
  - **A frame or a shared component on every page says so.** "around every page under /dashboard", not a list of every route in its description, which every turn's index carried. The manifest's `routes` are unchanged.
  - **The bindings mount a page for what it shows.** With none of its controls mounted (a page of figures, a Home whose cards gave way to a conversation), a page whose manifest entry records a display that is reporting is mounted, with no actions, so its state carries `shown`; where several pages record it, the page at the address. Evals get the same.

## 0.10.0

### Minor Changes

- **An eval's page shows what the product's pages show.** The fixture page (`AgentEvalPage`) declares `shown`, each display's facts in the shape `useAgentFacts` reports them (`id`, `title`, `facts` by label, `item` for a card of a list), and `problems`, each page area's problems as `useAgentProblems` reports them (`source`, `problems`). They are registered with the binding registry as the product's displays and page areas register them, so the page state carries the Home's numbers and a list's cards under `shown` exactly as the product's tab does: by display, a long list kept as an index of its rows (`x-rows`), the rest read with `ui_read` at the display's own offset; and the page's problems in its `problems` observation, or the navigation surface's when no page is open. Each is shown on its `routes` and while the address holds its `query`. A surface declared in the suite takes `shown` (its `state` observation, declared with `x-rows`) and `problems` too.

  **The manifest records each page's displays.** The generator writes each display a page or shell shows on its surface (`displays`: binding id, title, description, the labels the build can read; `ManifestDisplay`), so a fixture names a display as the build does: an id the manifest does not record fails the page, a title left out is the manifest's, and an entry with no `routes` is shown where its page is. A page with no display records none; a manifest generated before this release is read as before.

  **A control follows the address's query.** A fixture control bound to a query parameter (`query: view`) takes its value from the page's address, read with the page's declared query as the generator records it in `app.navigate` (`pageQueryOf`, then `readQuery`: its default when the address leaves it out), follows the address when `app.navigate` goes to the page with another query, and writes the value a run gives it back to the address (`writeQuery`), so `/dashboard/service-lane?view=declined` opens on the declined tab. A parameter no page declares, or `query` on a list's control, fails the page.

  **The conversation store is given the turn it reads for.** `EvalHistory.getHistory`, and `createMemoryHistory`'s `window`, now receive `request.turn` beside the worker's request (`EvalHistoryRequest`, `EvalHistoryTurn`): the turn's id and place, its suite, scenario and channel, the customer (`user`), the context it is sent with (the scenario's view, the page's `currentPath`, `oui` and `uiKnowledge`), and where the page is (`at`). A step context written from the page needs no pass-through `beforeTurn`. A store that ignores it is unchanged.

  **Bindings.** `pageQueryOf` reads a page's query schema back into its declaration; `generatedNavigationSurface` is the navigation surface the generator emits, now shared by the generator and the eval page, whose own navigation surface now carries the `problems` observation, as the generator's does.

## 0.9.0

### Minor Changes

- **Evals have a page that answers.** A suite, or a scenario in its place (`page: false` for none), declares the page its turns are sent from (`AgentEvalPage`, `agent-evals.json`). The harness runs it on a real oui-spec surface runtime in index form, sends every turn from wherever the page is (its snapshot as `oui`, its address as `currentPath`, and the product's knowledge for that page as `uiKnowledge` when the configuration gives it), and answers `ui_act`, `ui_describe` and `ui_read` from it, as the person's tab would, where every page action used to wait out its 20 seconds. Its surfaces are declared in the suite (each one's `routes`, its observations as `state`, and its actions, each with the `result` it answers, the `state` it leaves and the address it goes to, by `cases` on its input), or are the product's own: given its generated manifest (`defineEvals({ page: { manifest, knowledge } })`), a fixture names its controls by binding id (`controls`: value, live schema, rows, what a run does; `allControls` mounts the rest of a mounted surface's, empty), registered with a real binding registry and connected with `connectBindings` as the tab does. Going to a page is the bindings' own navigation surface, the manifest's or one made from the fixture's routes, so an address is checked as the product's runtime checks it. An approved page action is granted to the page as the approval store grants it to the tab. `createFixturePage` builds one for a product's own tests. With no page, a turn whose context carries a snapshot is told at once that the page is not responding.

  **A call no tool ran no longer breaks the next turn.** The worker stored a turn's tool results by position: a call with no result of its own (a tool the model invented, input that would not parse) moved every later result a call early, and the next turn put a result before its call, which the model's SDK refuses (`MissingToolResultsError`). Each call is now stored with its own result, by id, and a call no tool ran with the error the model was given for it (`notRun`). A history stored that way before is sent with each result after its call, and a call with no result stored is given one saying whether it ran is not known (`MISSING_RESULT`), where it was told `acknowledged`.

  **The product's own conversation store.** `defineEvals({ history })` plugs in the product's store (`EvalHistory`: `append`, `getHistory`, `persistMessages`), or its window over the whole conversation (`createMemoryHistory({ window })`: its cut of old tool results, its summary, its step context), so later turns read what its worker reads. The customer's message is appended before the turn runs, as a product's API stores it.

  **The agent's own settings.** `EvalAgentConfig` takes `modelProviderOptions`, `forcedToolChoice` and `uiActions` (its waits and how much of the page the model reads; the channel is the page's), and a recording knows them.

  **What a turn did, beyond its words.** New assertions: `calls` (each tool, or each page action through `ui_act` by its id or index name, called exactly `times`, or `min` to `max`, its arguments or input holding `args`); `usage` (bounds on `modelCalls`, `firstCallInputTokens`, every call's `callInputTokens`, the turn's `inputTokens` and `outputTokens`, and `cachedShare` of input read from the prompt cache, as the provider reported them); `choices` (the choice buttons offered: options and question matched, their `count`; `false` for none); and `page` (where the page is `at` after the turn, what `ran` on it, what did not). A turn's record carries its `usage`, its `choices` and its `page`. The SDK's interaction tools (`present_options`, …) run as they are when no stub answers them: they reach no backend.

  **A judge that answers.** A rubric's verdict is asked for as structured output (`Output.object`), which the provider gives its own way; an answer that is no verdict is read as text, then asked for again (`judgeOptions: { retries, maxOutputTokens }`, default 2 and 1024, where it was one try at 300 tokens). A judge that never gives one is reported apart from a failure: the failure's `kind` is `judge`, the case's `status` is `unjudged` (`JUDGE` in the report, an `error` in JUnit, `unjudged` in the report's counts), and the CLI exits 3 when nothing else failed. Every failure now carries its `kind` (`assertion`, `judge` or `case`).

  The scripted model in `@ouispec/agent-worker/testing` takes the usage a reply reports (`ScriptedReply.usage`: input, cached input and output tokens).

## 0.8.1

### Patch Changes

- **A long list of cards keeps an index of its rows in the page state, never a bare count.** The generated page state declares `x-rows` on `shown`: a display's facts that describe one row of a list (a card each) are addressed by the row's `item.key`, called by its `item.title`, and indexed with their display's `id`. `x-rows` takes a dotted path to a row's property (`rowValue`, `indexRow` and the row lookup read one), and the bindings report each display's rows together (`factsByDisplay`). Over budget, the worker keeps a display's first rows and the rows an action just changed whole and the rest as index rows, as it does any declared list; when even the index does not fit, it says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time. A page generated before the declaration is indexed the same way.

## 0.8.0

### Minor Changes

- **The assistant opens a page already filtered, in one call.** A page declares the query it reads from its address once, with `defineQuery` (`@ouispec/bindings`), and reads and writes it with `readQuery` and `writeQuery`: typed values, a value the page does not take falling back to its default, defaults left out of the address. The generator reads the declaration where the page, a component it renders or an app hook reads it, holds it to the new `page-query.json` schema, and the generated `app.navigate` takes `query` (one alternative per page, its routes in `x-routes`) and `params` (a route's `:parameters`, filled and encoded). `path` names each page's parameters, and the page's knowledge lists them. The runtime builds the address from the path, `params` and `query`, each part encoded, refuses a path that could leave the app (`//host`, a backslash, `.` or `..` segments) and a query parameter or value a declaring page does not take, naming what it takes, and does nothing, saying `alreadyThere`, when the person is already at that address. A build that declares no query is generated as before, with `params` added.

  **An action called as a tool runs once, through `ui_act`.** When the model calls an action of the page by its id as if it were a tool of its own (`app_navigate`), the worker runs it as the `ui_act` call it means, once, validated, judged by policy and approved as any `ui_act` call, instead of refusing it and having the model call it again. A name that is no action of the page is answered by the SDK as before.

## 0.7.0

### Patch Changes

- **Pages the assistant is never on.** `oui.config.json` takes `outside`: pages before sign-in and public pages a link opens, each named by `component` or by `route`, with its `reason` (`OutsideEntry`). An outside page has no surface, its controls are not enforced, `app_navigate` does not list it, and the knowledge's overview says the assistant is not on its routes. Until now such a page could only sit in `unbound`, which is meant to shrink to nothing.

  The list cannot hide a page of the app. A page is outside only when no `shell` entry frames its routes; every element its routes render around it (a layout route's, or a `routeWrappers` component's, at any level) holds nothing someone can use and no person-only component, which is how the assistant's own UI is declared; it does not render the app's frame itself; and it has no binding, display or room of its own, on no page the assistant is on. A page is never in both `outside` and `unbound`. An app without `outside` builds as before.

  **A design system's person-only components are the person's own.** `oui.personOnly` in a package listed in `designSystem` is now read, as it already was for any other package: a sign-in screen or the assistant's panel needs no control table entry, its callbacks need no `data-non-agent`, and an `agent` binding or a spread on one fails the build. An export in both the control table and `oui.personOnly` is an error. A page whose only unbound controls were such components is now fully bound, so the build asks to take it out of `unbound`: this is why the release is a minor.

  A route's page is read through the components it renders, as before; the tests now hold a route element that picks between two lazy pages, each rendering through a wrapper of its own children.

  The agent SDK is released again only to depend on this contract.

## 0.6.0

### Minor Changes

- A spoken "yes" approves an action on the person's page as a click on its card does, on `voice`, `phone` and `chat`.

  - **agent-worker:** on those channels a UI action is read back like any other call (the host's `spokenReadback` on a voice), with its card on the person's screen as well, and its approval is stored with the turn's room (`PendingApprovalInput.room`). The 0.18 note that a yes in the conversation does not count, and that the card is on the screen, stays only for SMS. `approvalConfirmedBy` and `READBACK_UI_APPROVAL_TOOL_NOTE` are new; the UI prompt rule says how each channel approves.
  - **agent-realtime:** when the engine decides `approve` on `voice`, `phone` or `chat` for a UI action stored with its room, the same script writes a single-use grant (two minutes at most, never past the approval) and the store pushes `agent:approval_granted` to that room. A tab claims it with `approval:claim` on its own socket: only the first claim from a socket of the approval's user in that room, before it expires, gets it (`used`, `forbidden`, `expired`, `unknown` otherwise). A decline in a conversation channel pushes `agent:approval_declined`. `/api/emit` and a client's relay refuse both events (`SERVER_SENT_EVENTS`). A withdrawn approval's grant can no longer be claimed. An SMS approve, or one of a UI action stored without a room, is still refused `channel`. Upgrade the realtime server before the worker: an older server refuses the room.
  - **agent-core:** `APPROVAL_CLAIM_EVENT`, `APPROVAL_PUSH_EVENTS`, `READBACK_UI_APPROVAL_CHANNELS`, `approvesUIByReadback`, `APPROVAL_GRANT_TTL_MS`, and the browser-safe `readApprovalGranted`, `readApprovalDeclined`, `approvalGrantRefusal` and `claimApprovalGrant` every tab takes a grant with. `grantApproval` in the client config may return the runtime's answer.
  - **agent-react:** the provider shows the card of a turn of the open conversation it did not start (a call's), checks a pushed grant against its conversation and rooms, claims it, and hands it to `grantApproval`; the card then says how the person decided (`labels.approvedBy`, `labels.declinedBy`) and offers no buttons.
  - **oui-spec:** `runtime.grantApproval` returns whether it took the grant and refuses one it holds or has used, or one already expired, so a replay never admits a second request. A request carrying an approval the tab was never given is refused on its receipt and neither run nor answered: with a conversation open in two tabs, only the tab holding the grant runs the action and answers.
  - **contract:** `ApprovalGrantedEvent`, `ApprovalDeclinedEvent`, `ApprovalClaimPayload`, `ApprovalClaimResult`, `ReadbackUIApprovalChannel`, and `room` on `PendingApprovalInput`; the events are declared among the platform's.

## 0.5.0

### Minor Changes

- Two schemas: `conversation-takeover.json` (a person on the staff takes a conversation over, writes as themselves, and hands it back: the hold, its requests and answers, including the approvals a take-over withdrew, and the three conversation events) and `agent-evals.json` (a suite of agent eval scenarios). An event declaration may name the room `conversation`, the conversation's room, as it names `turn`. The integrator guide gains "Staff take over a conversation, and hand it back", live calls included, and "Evals", and says how a turn's channel decides an approval.

## 0.4.9

### Patch Changes

- An approved call carries a signed receipt that the tool's own API verifies.

  The approval token proves the user's decision inside the product, but a tool's API could not check it: the token is HS256, so whoever verifies one can sign one, and redemption deletes the record before the tool's request arrives. Now, when the realtime server redeems a token, it also signs a **receipt**: this user approved exactly this call, in this conversation, and it was redeemed just now.

  - **The receipt.** A compact JWS, header `{ "alg": "EdDSA", "typ": "oui-approval-receipt+jwt", "kid" }`, signed with an Ed25519 key only the realtime server holds. Claims: `iss`, `aud`, `approvalId`, `argsHash`, `tool`, `operationId` (a generated API tool's), `conversationId`, `userId`, `accountId`, `channel`, `iat`, `exp` (`iat` + 120) and `jti`. `ApprovalReceiptClaims` in the contract's `approvals.json`.
  - **agent-realtime.** `approvals.receiptKeys` (Ed25519 private JWKs, each with a `kid`, exactly one `active`), `approvals.receiptIssuer` (the server's public base URL, every receipt's `iss`) and `approvals.defaultAudience` (the product's own API origin) turn receipts on; the three go together, and the server refuses to start on a key whose public part is not its private key's, a key id listed twice, or anything but one active key. `POST /internal/approvals/redeem` answers `{ call, receipt }`, signed for the audience fixed when the approval was stored: the pending approval's `audience`, or `defaultAudience` for a host tool that names none; a UI action (`toolKind: 'ui'`) gets none. A pending, declined, expired, withdrawn or replayed approval never gets one. `GET /.well-known/oui-approval-jwks.json` publishes the public keys to any origin, with `Cache-Control: public, max-age=3600`. `RealtimeServerInstance.setReceiptKeys` rotates without a restart (add a key, make it active an hour later, remove the old one an hour after that). `generateApprovalReceiptKey` makes a key. The pending approval accepts `accountId`, `toolKind`, `operationId` and `audience`: **update the realtime server before the worker**, since an older one refuses those fields and no approval can be asked for.
  - **agent-worker.** The approved call's context carries the receipt as `ctx.approval.receipt`, beside `approvalId` and `argsHash`, and only that call does. The OpenAPI executor sends it as the `OUI-Approval-Receipt` header (a header of that name from `actAs` is dropped). A generated API tool names its server's origin as its `approvalAudience` and its `operationId`; a host tool may declare `approvalAudience` (an origin), and one that is not an origin is refused before approval. A UI action's request never carries a receipt. The pending approval now names the turn's `accountId` and the tool's kind.
  - **agent-core.** `verifyApprovalReceipt(jws, { jwks, expectedArgsHash, audience })` → `{ ok: true, claims }` or `{ ok: false, reason, error }`, on WebCrypto in Node and the browser build. `jwks` is the document or its URL, which is cached for its `max-age` and read again for an unknown `kid` at most once a minute. It checks the header (only `EdDSA` with this `typ`, a `kid`, no `crit`), the key, the signature, the claims, `exp` and `iat` with 60 s of skew, `aud`, then `argsHash`; the reasons are `malformed`, `key`, `signature`, `expired`, `audience` and `args`. `@ouispec/agent-core/receipt-vectors.json` holds 21 receipts, the keys they were signed with and the result each must give, for an implementation in any language. Also `APPROVAL_RECEIPT_HEADER`, `APPROVAL_RECEIPT_JWKS_PATH`, `APPROVAL_RECEIPT_TTL_SEC` and `approvalReceiptAudience`.

  Single use is the tool's: it records each `jti` it acts on for at least two minutes and never acts twice on one.

## 0.4.8

### Patch Changes

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

## 0.4.6

### Patch Changes

- README and docs cleanup.

## 0.4.5

### Patch Changes

- **A question is answered in words.** The tool strategy's new "Answering Questions" rule and `present_options`' description say that a question (what something is, how it works, why) is answered in the reply. A card is never the answer: it only follows when a choice does, and a question asked again is answered, not met with another offer. On Closure's dev, a person asked "What is the push channel?" twice and got only a card offering to set one up (`textLength: 0` both times). The new live eval `ui-questions` asks that question fresh, after a card, and again after a card that didn't answer it, under the neutral persona (12/12). With Closure's persona it fails before the rule and passes after (16/16). Its control, "set one up", still sets one up.

  **`ui_guide` finds the entry a name means.** It tries, in order: the exact title; the title in any case; the one page entry whose title, less its route, is the name ("Experience Studio" for "Experience Studio (/distribution/experiences/:partId)"); and the one entry the name begins (`findNamed`). A name that two entries could mean finds neither, and the error still lists them all.

  **An option says what it means.** `ControlOption.description` is new: what choosing the option means, as the control shows it beside its title. `deriveInputSchema` names it with the option (`token = Recipient token (A field of the recipient, such as {{firstName}})`) for choices, tabs and multi-choices, live and generated alike (`describeOption`). The generator reads it from source through a control table's new `OptionsSource.description` key, and a tier 2 mapping's options through `mappedOptions`.

  `liveTurn` (evals) takes the conversation before the message, the client's knowledge and a product's persona.

## 0.4.2

### Patch Changes

- A conversation that began by voice says so in the history. `AgentConversationSummary.previewInput` is how the message its `preview` is taken from was entered, and `AgentConversationMatch.input` how a matched message was: `{ mode: 'voice', language }` for one the person spoke. `@ouispec/agent-react`'s history (`refresh`, `query`, `rename`, `update`) keeps only what `readMessageInput` recognises (`readConversationSummary`, exported), so a list can mark a spoken conversation and match. The integrator guide names both fields.

## 0.4.1

### Patch Changes

- A message the person spoke says so.

  - `@ouispec/agent-core`: `MessageInput` (`{ mode: 'voice', language? }`), `readMessageInput` (an unknown mode is read as typed; a language that is not a BCP 47 tag of at most 16 characters is left out) and `MESSAGE_INPUT_CONTEXT_KEY`. `AgentMessageContext.input` and `AgentStoredMessage.input` carry it.
  - `@ouispec/agent-react`: `sendMessage(content, { attachments?, input? })`. An array as the second argument still gives the message's files. `input` reaches `config.sendMessage` as `context.input` and stays on the message (`AgentMessage.input`, the session record, and a restored message). A spoken message sent while a turn runs supersedes it as a typed one does.
  - `@ouispec/agent-worker`: a turn whose `context.input` says the message was spoken adds one line to the newest user message, after the person's words and before the clock: it was spoken and machine-transcribed, may contain recognition errors, the language detected, and to ask rather than guess when a likely mis-hearing makes the request ambiguous. Typed messages, malformed inputs and an approval card's turn get nothing. The message's files keep their parts. `input` is kept out of the context the host's prompt sees, so the cached prefix is the same for a spoken message as for a typed one.
  - `@ouispec/contract`: the integrator guide says `sendMessage` passes `context.input` and that the product stores it with the message.

## 0.4.0

### Minor Changes

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

## 0.3.2

### Patch Changes

- The integrator guide describes `ui_guide`, the bounded knowledge, the page's state on the newest answer only, and UI actions without a per-tool quota.

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

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.
