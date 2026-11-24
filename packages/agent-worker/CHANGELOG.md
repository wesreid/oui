# @ouispec/agent-worker

## 0.35.0

### Minor Changes

- The page's index says a surface's shared action-id start once. A surface whose action ids all begin with the same words (`vector_studio_` on each of a studio's 189 actions) names that start in its heading, and its lines give the rest of each id, so the model reads each start once instead of on every line: the Video Studio editor's index with a graphic docked goes from 59,821 to 56,200 characters before anything else changes. `ui_act`, `ui_describe` and an action called as a tool share one resolver (`resolveActionName`). A full id resolves exactly as before. A line's name resolves to the one action it means, and a name that two surfaces' actions end in is refused with their full ids, never guessed. What an answer says the page now offers, and every note and error, keeps full ids. New root exports: `resolveActionName`, `sharedIdPrefix`, `sharedPrefixNote`, `IndexTextOptions`, `ActionNameResolution`; `indexText` takes `{ foldSharedPrefix }`.

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.16.0

## 0.34.0

### Minor Changes

- The agent knows what the whole app can do, not only the page it is on.

  - **The app's map, always in the instructions (agent-worker).** The knowledge a tab sends may carry the app's map apart (`uiKnowledge.map`, from `resolveKnowledge`). The worker renders it first, as its own section ("The App"), straight after the host's prompt and within `APP_MAP_PROMPT_CHARS` (10,000), so it never competes with the page's knowledge for room; the copy a tab also puts first among the entries is not said twice. It is the same on every page of a build, so every step and turn on a page reads it from the prompt cache.
  - **`ui_find` (agent-worker).** When the tab's snapshot names a lookup (`lookup` includes `find`, oui-spec §7.3.10), the turn offers `ui_find { query, limit? }`: it asks the tab (`oui.find`), which searches every action of the build, and the model gets each match with its page, the way to it from the page the user is on, and what it needs first. It takes its place in the turn's UI order and changes nothing in the page. `FIND_TOOL` is exported; a turn's usage counts `ui.finds`.
  - **`ui_guide { page }` (agent-worker).** When the snapshot's lookup includes `guide`, `ui_guide` also takes `page` (a route, an address or a title from the map) and reads that page's knowledge from the tab without going there, a part at a time.
  - **The UI rules (agent-worker).** Before saying something cannot be done, the agent searches the whole app with `ui_find`: a capability on another page is done by going there and using that page's own actions. Where an action takes a picture, any picture the agent can reach will do (one made, kept or attached anywhere in the app, or a file the user attached, given through the page's file slot), and it never says a picture cannot be used because it is on another page. Without `ui_find`, the rules point at the map instead.
  - **Eval pages (agent-evals).** A page given the product's knowledge answers `oui.find` and `oui.guide` as the product's tab does, from the page the eval is on, so a scenario can expect `toolCalled: [{ name: ui_find }]`. It searches `page.search` when given (every surface of the build, for a suite whose `manifest` is kept to the pages it mounts), else the manifest.

  ## 0.33.2

  ## 0.33.3

## 0.33.4

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.15.0
  - @ouispec/agent-core@0.33.4
  - @ouispec/agent-events@0.33.4

## 0.33.2

### Patch Changes

- Updated dependencies
  - oui-spec@0.15.0
  - @ouispec/agent-core@0.33.2
  - @ouispec/agent-events@0.33.2
  - @ouispec/bindings@0.14.7

## 0.33.1

### Patch Changes

- A page action named in one response after the action that offers it now runs.

  - `ui_act` looks the action up once the actions called before it have answered (`UISlot.ready`), in the page those actions left.
  - Before, it looked the action up as the call arrived, in the page the response began on. So "answer, then the Next it enables" or "a form's fields, then the button they enable" refused the second call as not on the page, and each such step took a response of its own.

## 0.33.0

### Minor Changes

- A host can decide what a turn's last step does when the turn runs short of time, and its hooks can read the turn's context.

  - `AgentTurnInfo` has two new fields:
    - `context`: the context the client sent with the turn, as it came, or null.
    - `autoContinue`: `context.autoContinue` when it is a positive integer, else 0. A client sets it when it starts a turn itself to carry on the turns before it.
  - The new optional `TurnPolicy.timeHandBack({ turn, canOfferChoices })` sets the step that hands a turn back for time to the host's own note and tool choice. For example, a person who asked the agent to carry on without stopping can get a short status in words instead of an offer to continue. Returning undefined keeps the offer.
  - `autoContinueOf` is exported, along with the `TimeHandBackContext` and `TimeHandBackStep` types.

  Breaking for code that builds an `AgentTurnInfo` itself: it must now give `context` and `autoContinue`.

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.14.4
  - oui-spec@0.14.1

## 0.32.4

### Patch Changes

- The realtime key can come from your secret store: `realtime.apiKey` takes a getter (`() => string | Promise<string>`) as well as a string. The runtime reads it on the first request, keeps it for `realtime.apiKeyMaxAgeMs` (30 s by default), reads it again at once when the realtime server refuses it and sends that request once more with a newer key, and keeps a key that worked while a re-read fails. Every client the runtime builds shares one cache. The HTTP clients a product builds itself take a string, a getter or a shared `createRealtimeKeySource(...)`. A string works exactly as before.

## 0.32.3

### Patch Changes

- A step is told only about the tools it offers, and a call to a tool it does not offer ends no turn. Nova, 0.32.2: a step its turn policy held to one tool (`activeTools`) still read the SDK's "offer it with present_options", called `present_options` beside the tool it was given, and the call failed (`AI_NoSuchToolError`) without running; it never went into the turn's calls that did not run, so the turn counted it as a question to the user, ended after that round with no reply, and the host fell back.

  - **What a step is told.** Every piece of the SDK's prompt that names a tool is a `ToolRule` (`prompt/step-tools.ts`), said only when the step offers every tool it names, or said without it. What a step offers is one value, worked out once per step from the turn's tools and the policy's limits (`stepOfferedTools`: none with `toolChoice: 'none'`, the forced tool, else the active tools), and every writer of the step's prompt is given it: the tool strategy's choice rules (`present_options`) and the UI rules (`ui_act`, `ui_describe`, `ui_read`), which a persona's prompt carries from `buildAgentSystemPrompt` and the worker takes out of the host's prompt for that step (`systemPromptForTools`, so the host passes nothing); the page index's line on running actions; the files note (`attachmentDataNote`); the client's knowledge (`ui_guide`); the turn's context lines (`look`, `capture_*`, `call_handoff`: a step held to other tools is told it cannot look, start photos or move the call at this step); and the hand-back note. With every tool offered the words are byte for byte what they were. A limited step already sends the provider fewer tools, so it costs no cache the limit had not; steps that offer the same tools are told the same words. Text a host writes itself is sent as written.
  - **A call no tool ran.** A call to a tool its step does not offer, or that the turn never had, or whose input cannot be read, goes into the turn's calls that did not run with its reason: it asks the user nothing and ends no turn. The model reads as its result `{ success: false, notRun: true, unavailable: true, error }` (`unavailableToolError`: the tool is not one it can use now, nothing was shown, carry on or answer in words), or `invalidInput: true` with the parse error, in place of `ai`'s own error, and answers in words in the same turn. The turn's record lists it, the client is sent it as a refused call, and the conversation stores the same result.
  - **The turn policy** sees, on each call in `prepareStep`'s `steps`, whether its tool ran (`ran`) and why not (`notRun`), so a policy can decide on what ran. A `ui_act` call that names no action of the page is counted as not run too.
  - **agent-evals** counts a call to a tool that was not offered (`unavailable`) as an invalid tool call, as it counted `ai`'s error before.

## 0.32.2

### Patch Changes

- A caller's earlier photo capture that did not complete can be picked up where it left off. `client.capture.resumable` (`[{ captureId, planKey, outcome, endedAt, missingSteps }]`, `CaptureResumable`, newest first) is read as strictly as the rest of `client.capture`: `outcome` is one of `CAPTURE_RESUMABLE_OUTCOMES` (`partial`, `camera_unavailable`, `abandoned`, `failed`; the capture contract's outcomes less `completed` and `declined`), `endedAt` is ISO 8601 or null, `missingSteps` are step ids; absent reads as `[]`; a malformed entry answers `400` naming it, and one of a plan the session does not offer, or missing nothing, is left out. While the turn can start photos, `capture_start`'s description lists each in the lines Closure's own brain is shown (`resumableLines`), and the capture line adds Closure's sentence `CAPTURE_RESUME_WHEN`: offer to finish it with `capture_start({ plan, resumeCaptureId })`, so only the missing photos are asked for. `TurnCapture.resumable` is optional, so a host that builds a capture by hand is unchanged. Log lines count them (`capture.resumable`), never name them.

## 0.32.1

### Patch Changes

- The device update kinds take the hand-off contract's names: `CALL_DEVICE_UPDATE_KINDS` / `CallDeviceUpdateKind`, as `@closurestudio/realtime-contracts` 0.28.0 (`live-call-devices`) declares them, with the same values (`offered`, `switched`, `brought_back`, `revoked`, `expired`, `active_lost`). 0.32.0 was never published, so nothing that installed it is affected. A test pins every hand-off name and value to the contract's.

## 0.32.0

### Minor Changes

- A live call can move to the caller's phone, and the character learns what happens only in words. A live-call turn reads `client.handoff` (`{ control: { url, token, expiresAt } | null, device: { formFactor, switches } | null, offer: { handoffId, purpose, expiresAt } | null, update }`) as strictly as `client.capture`, and the handler sets it as the turn payload's new `handoff` (`TurnHandoff`, checked by `payloadRefusal`). While there is a control route, the model has `call_handoff({ purpose })` (`handoffTool`, SDK tool class `handoff`, `kind: 'backend'`), which calls the call service's hand-offs route (`POST {url}` with `{ purpose }`, `purpose` one of `photos`, `caller_asked`, `other`) with `Authorization: Bearer <lhb1 token>`: the result is the route's `words` with the hand-off's id and status, never the code or the link, and a refusal is the contract's line for its code (`HANDOFF_UNAVAILABLE`, `HANDOFF_UNSUPPORTED_CALL`, `RATE_LIMITED`, `SESSION_NOT_LIVE`, `NO_ACTIVE_DEVICE`, `HANDOFF_TOKEN_WRONG_SESSION`, `401`/`403`), never the route's own message. A line in the turn's context gives the clause Closure's own brain has (`HANDOFF_WHEN`), that the model never sees the caller's devices, screen or code (`HANDOFF_NEVER`), the device the call is live on, how often it has moved, and an open offer. A new turn kind, `device` (`text` empty, `client.handoff.update` set), reads `liveCallDeviceMessage(update)` where the person's words would be: the update as data, answered in one short sentence or with silence (`done` with no `text`); capture updates that arrived with it follow it in the same message. `liveCallTurnMessage(request)` gives it as the row to store. `client.capture.active.blockedReason` (`camera_denied` or `no_rear_camera`, `CAPTURE_BLOCKED_REASONS`) says why a capture is blocked. The contract's names are exported without depending on it: `CALL_HANDOFF_PURPOSES`, `CALL_FORM_FACTORS`, `CALL_HANDOFF_STATUSES`, `DEVICE_UPDATE_KINDS`, `DEVICE_UPDATE_TEXT_MAX`, `HANDOFF_CODE_TTL_S`. The token and the update's words are never logged or emitted; log lines carry `handoff: { canOffer, device, switches?, offer?, update? }`. Set `acceptsHandoff: true` on the brain endpoint once this version runs: an older worker refuses the `device` turn kind.

## 0.31.0

### Minor Changes

- A turn's context (the clock, how the message was entered and how the reply is delivered, the vision and capture lines, the host's `stepContext`) now goes straight after the turn's own message, on every step in the same words, never after a tool result. Sent after a result, it read as the person's newest message: Claude Haiku 5.5 with thinking off answered a live call's `look` "your message came through blank", or went back to an earlier question, in 14 to 20 of 20 runs; with the context beside the message it answered from the look in 20 of 20 (`evals/turn-context.live-eval.ts`). Only the page's state and the step's notes still follow the conversation. `turnContextPlacement: 'after-conversation'` keeps 0.30's placement for a model the eval shows handles it; the default is `'with-message'`. The next turn now writes this turn's tool calls and results to the prompt cache once more.

## 0.30.0

### Minor Changes

- A persona's replies can be plain text: `overrides.communicationStyle` takes `{ preset, format: 'markdown' | 'plain' }` as well as a preset. With `format: 'plain'`, the rich-markdown lines are replaced by plain-text ones (short natural sentences, no markdown syntax of any kind, items said in a sentence, no tables), the concise and formal presets' list and heading lines by sentence and paragraph ones, and the few-shot examples and workflows are labelled without bold. The default stays markdown, and a persona that names no format is told exactly what it was before. An unknown preset or format in the object form fails when the adapter is created. Exports `resolveCommunicationStyle`, `COMMUNICATION_STYLES`, `COMMUNICATION_FORMATS` and the types `CommunicationFormat`, `CommunicationStyleOptions`, `CommunicationStyleSetting` and `ResolvedCommunicationStyle`.

## 0.29.1

### Patch Changes

- The capture names and values are the capture contract's, exported without depending on it: `CAPTURE_STATUSES` / `CaptureStatus`, `CAPTURE_OUTCOMES` / `CaptureOutcome`, `CAPTURE_END_REASONS` / `CaptureEndReason`, `CAPTURE_BRAIN_UPDATE_KINDS` / `CaptureBrainUpdateKind`, and `CAPTURE_UPDATE_TEXT_MAX` (600, the longest text of one update; a turn's `client.capture.update` joins the pending ones, at most 8,000 characters). `client.capture.active.status` must be one of `CAPTURE_STATUSES` (a refusal names the field). A capture tool's result reads `status` by `CAPTURE_STATUSES` (an answer with another fails as a failed call) and `outcome` by `CAPTURE_OUTCOMES` (one it does not know is left out).

## 0.29.0

### Minor Changes

- A live character asks the caller for the photos a client's capture plan needs, and learns what happens only in words. A live-call turn reads `client.capture` (`{ plans: [{ key, title, offerWhen }], control: { url, token, expiresAt } | null, active: { captureId, plan, status, step: { id, label, index, of } | null } | null, update }`) as strictly as `client.vision`, and the handler sets it as the turn payload's new `capture` (`TurnCapture`, checked by `payloadRefusal`). While there are plans and a control route, the model has `capture_start({ plan, resumeCaptureId? })`, `capture_status({})` and `capture_stop({ reason? })` (`captureTools`, SDK tool class `capture`, `kind: 'backend'`), which call the call service's captures routes (`POST {url}`, `GET {url}/{captureId}`, `POST {url}/{captureId}/stop`) with `Authorization: Bearer <lcb1 token>`: each result is the route's `words` with the capture's id and status, and a refusal is a line chosen by its code (`CAPTURE_IN_PROGRESS`, `RESUME_NOT_ALLOWED` by `details.why`, `CAPTURE_AGENT_UNAVAILABLE` with Closure's words, `SESSION_NOT_LIVE`, `NO_ROOM_AGENT`, `CAPTURE_PLAN_NOT_FOUND`, `RATE_LIMITED`, `401`/`403`), never the route's own message. `capture_start`'s description lists each plan with when to offer it and tells the model to say a short holding line first. A line after the conversation gives the clause Closure's own brain has (`CAPTURE_WHEN`), that a plan is offered only when its `offerWhen` applies, that the model never sees or judges a photo (`CAPTURE_NEVER`), and where the running capture stands. A new turn kind, `capture` (`text` empty, `client.capture.update` set), reads `liveCallCaptureMessage(update)` where the person's words would be: the update as data and the instruction to narrate it in a short line, to make the plan's offer when a capture ends without completing ("Offer: …"), or to stay silent (`done` with no `text`). `liveCallTurnMessage(request)` gives that message as the readable row to store. An update that rode a message turn reaches the model after the conversation. The token and the update's words are never logged or emitted; log lines carry `capture: { plans, canStart, active?, step?, update? }`. Set `acceptsCapture: true` on the brain endpoint once this version runs: an older worker refuses the `capture` turn kind.

## 0.28.0

### Minor Changes

- The character looks at the caller only when it chooses to: no turn carries a picture any more, and integrators implement no vision. `client.vision` is now `{ seeing, remarks, canLook, absent: 'camera_off' | 'turned_off' | null, look: { url, token, expiresAt } | null, observation }`; `frame` is removed (an older call service's frame is read past and never given to the model), and so are `VISION_FRAME_MEDIA_TYPES`, `VisionFrame`, `VisionFrameMediaType` and the `stale` absence. With `canLook`, the live-call agent has the new `look({ question, frames? })` tool (`lookTool`, SDK tool class `vision`, a `view`): it `POST`s the question (at most 500 characters) and 1–4 frames to `look.url` with `Authorization: Bearer <token>`, and the call service's answer in words reaches the model for that call only, while the stored result says only `{ looked, pictures, newestSecondsAgo }`; nothing seen is `{ looked: false, absent, why }`, and a `409`, `429`, other refusal, timeout or expired token fails with what to do instead. The look route must be https (or this machine). The vision clause now says "You can look at the caller with `look` when the conversation calls for it: they ask about how they look or what is around them, they show you something, or a glance offers it. Do not look otherwise." (`LOOK_WHEN`), or that it cannot see and why. A `glance` now needs `remarks` and an `observation` (no frame): the observation reaches the model in the turn's vision line, escaped as data, and is never stored, so the model phrases one remark or stays silent. A tool's new `inputPrivate` keeps its input out of logs and room events (set on `look`); the token, question, answer and observation are never logged or emitted, and log lines carry `vision: { seeing, remarks, canLook, absent?, observed? }`. A tool policy that admits by name should admit the `vision` class.

## 0.27.0

### Minor Changes

- A live character sees the caller. A live-call turn reads `client.vision` (`{ seeing, remarks, frame: { mediaType, data, width, height, capturedAt } | null, absent }`) as strictly as `client.ui`: a frame with the wrong media type, base64, image signature, size or `capturedAt` answers `400` naming the field, and no refusal repeats its data. The handler sets it as the turn payload's new `vision` (`TurnVision`, checked by `payloadRefusal`), and the worker gives the model the frame as a picture after the conversation's cache breakpoint, with the vision clause (answer about what it sees; with `remarks`, remark unprompted sparingly; never sensitive traits, identification or a body), or a line that it cannot see the caller and why. The stored message keeps the caller's words only, so the next turn never sends an earlier frame. A new turn kind, `glance` (`text` empty, a frame, `remarks` on), reads `LIVE_CALL_GLANCE_MESSAGE`: the model remarks only on something worth it, and an empty answer is `done` with no `text`. `liveCallTurnMessage(request)` is what the model reads for any kind. The frame is never logged, emitted or stored; log lines carry `vision: { seeing, remarks, attached, frameBytes, frameAgeMs }` or `absent`. The live-call body limit is now 384 KiB (`LIVE_CALL_MAX_BODY_BYTES`, also on the container route, which had capped it at 64 KiB), leading whitespace of a reply is never spoken, and a blank user message with no files in history is no longer sent to the provider.

## 0.26.0

### Patch Changes

- @ouispec/agent-core@0.26.0
- @ouispec/agent-events@0.26.0
- @ouispec/bindings@0.14.0

## 0.25.2

### Patch Changes

- A page state of many lists fits at the last steps: once every list is already a count, a page keeps its first lists (40, then 20, then 10, then none) and the ones holding a chosen row, and says how many more there are with the `ui_read` call that returns their ids and rows. A surface of sixty lists no longer takes thousands of characters saying "1 rows" per list, and is no longer left out of the page state whole beside the rest of the page.

## 0.25.1

### Patch Changes

- A shared surface mounted on the page ranks with the page and its rooms in the page state over budget, not below them: one in the snapshot is on the page as much as the page is (a document two pages share is the page's content). Surfaces left out to fit go by rank, then the one mounted last first, as the index collapses; the shells still go first and the acting surface never.

## 0.25.0

### Minor Changes

- The assistant reports work that outlived the turn that started it: a resumed turn.

  A UI action that starts work (a job, an export) waits for its outcome in the call for 20 s at most; `ui_wait` (0.24.0) waits longer, within the turn. Work that ends after the turn reached the assistant only with the person's next message: the tab posted the job's final answer with nobody waiting for it. Now, when such work finishes after its turn has ended, the person's tab starts a turn by itself and the assistant reports the outcome in the same chat.

  - **`oui-spec`:** `runtime.onSettled(listener)` is called once for each request first answered `interim: true`, when its final answer (done, failed, `TIMEOUT`, `SUPERSEDED`, or `SURFACE_NOT_MOUNTED` when its surface left the page) has been sent and acknowledged by the receiving side, so the agent runtime's result store holds it. The event is `OUISettledWork`: `{ requestId, turnId?, surfaceId, actionId, success, at }`. A request that was never interim is not told, nor a final answer refused even trimmed. A listener that throws is logged and does not stop the runtime or the other listeners. The spec says so in §7.3.3.
  - **`@ouispec/agent-core`:** `ResumeContinuation` (`{ requestIds }`, 1 to `RESUME_MAX_REQUESTS` = 8 ids of at most `RESUME_REQUEST_ID_MAX_CHARS` = 200 characters) and `resumeRefusal`; `resume` on `AgentClientConfig.sendMessage`'s params beside `approval`; `settledWork?: SettledWorkSource` on the client config (`SettledWork` is oui-spec's `OUISettledWork`); `RESUME_MAX_IN_A_ROW` (3) and `RESUME_GATHER_MS` (1,500).
  - **`@ouispec/agent-react`:** with `config.settledWork` (wire it to `runtime.onSettled`), the provider resumes for work of a turn of the open conversation that this tab ran and that ended by itself (answered, handed back for time, failed, or out of time). Never for a turn the person stopped, one their newer message superseded, one a person on the staff took over, or one that ended waiting for an approval; never while a turn runs or starts, a conversation loads, an approval card or a choice waits, or a person on the staff holds the conversation; a conversation switch or a new conversation forgets the turns before. Work ending within 1.5 s of the last goes in one turn, and at most 3 turns in a row are started this way before the person writes again. The turn goes through `sendMessage` like an approval's continuation: empty `content`, no message shown, the page's context as a message carries it, and `resume: { requestIds }`. Every decision is in the debug log. Nothing new on `useAgent()`.
  - **`@ouispec/agent-worker`:** the turn payload takes `resume` (`payloadRefusal` refuses a malformed one, and `resume` with `approval`). The turn takes each request only when the conversation's history holds the tool call with its id and that call's latest result still says it is running, so a client never reads another conversation's results and an outcome is never reported twice. It reads each final answer from the realtime server and gives it to the model as that call's result, in `ui_wait`'s words (`laterAnswerFor`), in place of "still running", stored under the call's own id so later turns read the outcome; an approved call keeps its approval on it. In place of a message the model is told, in a `<resumed>` note, that nobody wrote, why the turn started (each work named by its declared title), and to tell the person briefly what came of it after checking the page, going on with their earlier request if it needed the outcome. A final answer that can no longer be read is said so, and nothing is stored for it. When nothing is left to report, the turn completes without calling the model. The answer that reports work running now says the assistant is brought back to report it when it finishes after the turn, while the person's window is open. The turn's logs, usage line, result and `recordTurnComplete` carry `resumed` (`ResumedTurn`).
  - **`@ouispec/contract`:** the integrator guide says how a resumed turn works (`60-runtime.md`).

  Platforms: pass `resume` from your `sendMessage` to the worker's turn payload unchanged, and store no user message for its empty content.

### Patch Changes

- Updated dependencies
  - oui-spec@0.14.0
  - @ouispec/agent-core@0.25.0
  - @ouispec/agent-events@0.25.0
  - @ouispec/bindings@0.12.3

## 0.24.0

### Minor Changes

- The assistant can wait for work an action started: `ui_wait`, a fourth UI tool.

  A UI action that starts work (a job, an export) waits for its outcome in the call for 20 s at most (`jobWaitMs`); work still going then is reported running, and nothing starts a turn when it ends. So an assistant whose request needed the outcome had no way to get it: on a studio page it started a one-minute image job, was told it was running, ended its turn asking the person to tell it when the job was done, and was never told.

  `ui_wait` waits for such work, named by its `jobId` (as the call's answer gave it) or its `action`, or the work started last, until it ends, its own `timeoutMs` passes, or the turn must answer (`waitDeadline`), whichever is first. It answers as the action's call would have: its outcome, what the page offers now, and what it shows. Work still running then is reported running, never done; a stop ends the wait and says the work may still be running. The answer that reports work running says when to wait for it and that nothing reports its end after the turn. The time a step spends in `ui_wait` does not count as the step's length when the turn decides whether to hand back for time, since the wait bounds itself.

  - `AGENT_UI_TOOLS.wait` (`ui_wait`), `UI_WAIT_TOOL`, and `buildUITools(...).wait`; `UIToolDependencies.running` shares the turn's running work across rebuilt tools (`RunningWork`, `RunningWorkLog`).
  - A host tool named `ui_wait` is withheld, as one named after any UI tool is.
  - `StepClock.waited(ms)`.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.24.0

## 0.23.2

### Patch Changes

- A line of the page's index drops what the model does not use: the word "takes", "(takes nothing)", and the type of a text, list or object. An enum's first values and a number's range stay. Measured with a live model on a long form: names alone, or a long enum as a count, made it describe twice as often and a turn cost more than the shorter index saved; this form describes no more often and costs the same. A studio page's index is about 11% shorter.

## 0.23.1

### Patch Changes

- The root exports `DEFAULT_PAGE_STATE_CHARS`, `observationSchemas`, `observationsText`, `pageStateFit` and the `PageStateFit` type. 0.23.0's changelog said it did, and it did not.

## 0.23.0

### Minor Changes

- A long form's page state fits what the model reads, and an index carries only what is read.

  - **`@ouispec/bindings`:** in the page state, a list's rows that all take one value schema leave it to their action's definition, which offers exactly that schema. A row keeps its own schema when the list's rows differ. On a form with a control per field per row, the same schema on row after row was three quarters of the page state.
  - **`oui-spec` (§7.3.8):** an observation in index form is its id, and its schema reduced to what leads to an `x-rows` declaration (`observationIndexEntry`, `OUIObservationIndexEntry`). A surface in full form keeps the whole declaration.
  - **`@ouispec/agent-worker`:**
    - Page state over budget: a form of short lists now fits. After the frame around the page is left out, short lists lose their rows' schemas, then become index rows, then counts, and the summary says how to read a list. A page or room is left out, or text cut off, only after all of that.
    - The index over budget: surfaces are listed by id in a fixed order, the frame first, then shared surfaces, then pages and rooms, the longest mounted first, so what the person opened last keeps its lines longest.
    - `Turn usage` gives `ui.snapshotBytes`, `ui.snapshotCuts` and `ui.pageState` (`chars`, `outcome`, `omitted`).
    - The root exports `DEFAULT_PAGE_STATE_CHARS`, `observationSchemas`, `observationsText` and `pageStateFit`, so a product can hold its pages to these limits in a test.

### Patch Changes

- Updated dependencies
  - oui-spec@0.13.0
  - @ouispec/bindings@0.12.0
  - @ouispec/agent-core@0.23.0
  - @ouispec/agent-events@0.23.0

## 0.22.4

### Patch Changes

- **A choice offered twice with no reply says its card's context as the reply** (`requireReplyBeforeChoice`). When a sent-back `present_options` comes back with still no reply, it goes through as before. What its card says first (`context`) is now said as the turn's reply instead, sent to the room and stored as the step's text, and the card shows its question alone. So the person and the history both get a reply, and the card doesn't repeat it. A card with an empty context goes through as it is.

  The send-back (`REPLY_BEFORE_CHOICE_ERROR`) now says what the reply is: the plain text written outside any tool call, which the card and its context are not. Measured on DEOS (2026-10-31): sent back, the model offered the card again with its answer in `context` and no reply, in 2–3 turns per eval run.

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
