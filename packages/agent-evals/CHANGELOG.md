# @ouispec/agent-evals

## 0.37.0

### Minor Changes

- An eval can hold a turn to what the agent writes while it works: `whileWorking` on a turn's expectation.

  - contract: `AgentEvalExpectation.whileWorking` (`silent`, `says`, `mustNotSay`), optional, so every suite that validated still does.
  - agent-evals: each turn's record carries `working`, the text of each step the turn went on from, written before that step's calls; the turn's last step (its answer, or the text before the card or approval it ends on) is never part of it. `silent: true` holds when it is empty, `silent: false` when it is not, and `says` and `mustNotSay` match it, rubrics included. `workingOf(messages)` is exported. A host that lets the person choose how much the agent explains can hold one level to naming what it uses before it acts, and another to writing nothing until its answer.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @ouispec/agent-core@0.37.0
  - @ouispec/bindings@0.17.1
  - @ouispec/contract@0.17.1
  - @ouispec/agent-worker@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies
  - oui-spec@0.16.0
  - @ouispec/bindings@0.17.0
  - @ouispec/agent-worker@0.36.0
  - @ouispec/agent-core@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ouispec/agent-worker@0.35.0
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

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.34.0

## 0.33.4

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.15.0
  - @ouispec/bindings@0.15.0
  - @ouispec/agent-core@0.33.4
  - @ouispec/agent-worker@0.33.4

## 0.33.2

### Patch Changes

- Updated dependencies
  - oui-spec@0.15.0
  - @ouispec/agent-core@0.33.2
  - @ouispec/agent-worker@0.33.2
  - @ouispec/bindings@0.14.7

## 0.33.1

### Patch Changes

- An eval's page can render part of itself in code, from its own state, as the product's component does (`page.models`). What a case must have done by a turn can be checked whichever turn did it (`page.ranInCase`). A cache share is held only where there is a cache.

  - `@ouispec/contract`: a page names the models it shows, and the data each renders from (`AgentEvalPage.models`).
  - `@ouispec/agent-evals`: the configuration gives each model by name (`page: { models }`, an `EvalPageModelFactory`).
    - A model says what it shows where the page is (`render`): the product's controls by binding id, each with its value, live schema, rows and whether it can be used; its displays' facts; its problems.
    - It says what each of its controls does (`run`).
    - It is rendered again after each run and whenever the page goes elsewhere. A row or control that is gone is unregistered, a new one registered, a changed one updated, through the binding registry as the product's tab does.
    - A form asked one step at a time is what it is for: only the step's field is shown, its Next is offered once the step is answered, and its last button once every required step is. A fixed `controls` could not show this.
    - A model's controls are the manifest's. A control named by both a model (`owns`, or what it shows) and `controls`, by two models, or by none in the manifest, is refused. `allControls` mounts around a model's controls.
    - A model's `identity` (the product's declarations it renders from) is in each recording's fingerprint. A recording made before those declarations changed replays as stale.
  - `page.ranInCase`: each action ran on the page in the case by the end of the turn, in this turn or an earlier one, and its last run (a list control's, for its row) held the input given.
    - An agent answers a form until it reaches a question the person must answer, then finishes once they have, so each answer may come in either turn.
  - `usage.cachedShare` is held only on a model that reads a prompt cache (in a matrix, a candidate whose `capabilities.promptCache` is true).
    - A turn of many model calls declares the share it measured, and `--estimate` prices that share as cache reads where there is a cache.
    - Before, a candidate with no cache failed the bound for not reading a cache it does not have.

- Updated dependencies
- Updated dependencies
  - @ouispec/contract@0.14.6
  - @ouispec/agent-worker@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ouispec/contract@0.14.4
  - @ouispec/bindings@0.14.4
  - oui-spec@0.14.1
  - @ouispec/agent-worker@0.33.0

## 0.32.6

### Patch Changes

- What a turn showed the person, a list's control's cases, and reads after the page's work.

  - `says` and `mustNotSay` hold against what the turn showed the person: its reply, then each choice card's question and options (`shownToCustomer`). An agent asks on a card; a rubric that wants a question asked failed when the question was on the card alone.
  - A list's control matches its cases with the row it ran for (`item`): a case for one row (`when: { item: … }`) never held, so choosing a row never went where the case said.
  - A stub case can wait for a page action (`afterRan`: its id or index name, and a subset of its input): a read of what the page's work changed answers as the backend then would, where it answered the same before and after (a capture continued through its links read back as never continued).

- Updated dependencies
  - @ouispec/contract@0.14.3

## 0.32.5

### Patch Changes

- An eval's page runs work that outlives its call as the product's tab does.

  - `@ouispec/contract`: a page's declared action, and a product control, can start a job (`job`: its id, when it settles, and its outcome, `complete` with the result fields or `failed` with the reason), in `AgentEvalPageAction`, `AgentEvalPageControl` and their cases.
  - `@ouispec/bindings`: an action that settles on a job answers `started` with what its handler returned beside `status` and `jobId`, where it dropped the handler's data (a capture's address and the links it found, an export's settings), so the assistant knows what it started while it runs; `startedAnswer` and `jobOutcomePolling` are exported, for a host that builds such an action itself.
  - `@ouispec/agent-evals`: such an action answers started, and settles on the scripted outcome through the runtime's own polling (`jobOutcomePolling`) of a scripted job tracker; a control's job is followed through `connectBindings`' tracker. Requests arrive, and both answers leave, on the tab's socket in memory through OUI's own transport, so the agent waits for the outcome as for the product's: in the call for its job wait, then with `ui_wait`. Before, a fixture's action answered once and never settled, so a capture an agent waited for was reported as nothing running. A job on an action or control whose effect does not settle on one is refused.

- Updated dependencies
  - @ouispec/contract@0.14.2
  - @ouispec/bindings@0.14.2

## 0.32.3

### Patch Changes

- A step is told only about the tools it offers, and a call to a tool it does not offer ends no turn. Nova, 0.32.2: a step its turn policy held to one tool (`activeTools`) still read the SDK's "offer it with present_options", called `present_options` beside the tool it was given, and the call failed (`AI_NoSuchToolError`) without running; it never went into the turn's calls that did not run, so the turn counted it as a question to the user, ended after that round with no reply, and the host fell back.

  - **What a step is told.** Every piece of the SDK's prompt that names a tool is a `ToolRule` (`prompt/step-tools.ts`), said only when the step offers every tool it names, or said without it. What a step offers is one value, worked out once per step from the turn's tools and the policy's limits (`stepOfferedTools`: none with `toolChoice: 'none'`, the forced tool, else the active tools), and every writer of the step's prompt is given it: the tool strategy's choice rules (`present_options`) and the UI rules (`ui_act`, `ui_describe`, `ui_read`), which a persona's prompt carries from `buildAgentSystemPrompt` and the worker takes out of the host's prompt for that step (`systemPromptForTools`, so the host passes nothing); the page index's line on running actions; the files note (`attachmentDataNote`); the client's knowledge (`ui_guide`); the turn's context lines (`look`, `capture_*`, `call_handoff`: a step held to other tools is told it cannot look, start photos or move the call at this step); and the hand-back note. With every tool offered the words are byte for byte what they were. A limited step already sends the provider fewer tools, so it costs no cache the limit had not; steps that offer the same tools are told the same words. Text a host writes itself is sent as written.
  - **A call no tool ran.** A call to a tool its step does not offer, or that the turn never had, or whose input cannot be read, goes into the turn's calls that did not run with its reason: it asks the user nothing and ends no turn. The model reads as its result `{ success: false, notRun: true, unavailable: true, error }` (`unavailableToolError`: the tool is not one it can use now, nothing was shown, carry on or answer in words), or `invalidInput: true` with the parse error, in place of `ai`'s own error, and answers in words in the same turn. The turn's record lists it, the client is sent it as a refused call, and the conversation stores the same result.
  - **The turn policy** sees, on each call in `prepareStep`'s `steps`, whether its tool ran (`ran`) and why not (`notRun`), so a policy can decide on what ran. A `ui_act` call that names no action of the page is counted as not run too.
  - **agent-evals** counts a call to a tool that was not offered (`unavailable`) as an invalid tool call, as it counted `ai`'s error before.

- Updated dependencies
  - @ouispec/agent-worker@0.32.3

## 0.32.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.27.0

## 0.26.0

### Minor Changes

- **A model matrix: one run of your suites against every candidate model, and a leaderboard that says which is cheapest for the work it does well enough.**

  `agent-evals --models <file | ids | all> --runs <n>` runs every scenario × channel × model × run through the same harness as a single run (your real agent configuration, its stubs, its page), and reports each model side by side.

  - **Candidates are data.** `models` in the configuration, or a file (`.json`, `.yaml`, a module): `{ id, label, providerOptions, capabilities: { promptCache, forcedToolChoice, temperature, vision, contextWindow }, prices: { input, output, cacheRead, cacheWrite } }`, prices in US dollars per million tokens (`EvalCandidate`, checked by `checkCandidates`; `selectModels` reads `--models`). The model factory is handed each one as `seam.candidate`, and a case whose factory builds another model fails (`model`). A candidate's turns send its `providerOptions` in place of the agent's `modelProviderOptions`, the cache breakpoint only where it caches, and no forced tool choice or temperature where it takes none (`agentForCandidate`).
  - **One judge.** `judgeModel` (`{ id, label, providerOptions, prices }`) decides every rubric for every candidate, and is never one of them; a matrix whose suites have rubrics needs it. The seam hands it to the factory as `seam.judgeModel`, its provider options reach every verdict, and the judge is built only for a scenario with a rubric.
  - **What each call used.** `EvalModelCall` now carries `noCacheTokens`, `firstTokenMs`, `durationMs` and `finishReason`; a turn's usage its `noCacheTokens`, `firstTokenMs` (to the turn's first token) and `modelMs`. A turn's record carries `invalidToolCalls` (input the tool's schema refused or that would not parse, or no such tool), `refusal` (`provider` for a call stopped for its content, `reply` for a reply in the words of a refusal where none is expected; `refusal` in the configuration sets the words) and `costUsd`; a case's result its `model`, `run`, `costUsd`, `judgeCalls`, `judgeCostUsd` and `stoppedBy`. A recording keeps its agent calls' times (`timings`), so a replay reports the live run's latency.
  - **Per model** (`summarizeModel`): pass rate over the cases judged, with its mean, least and most across runs; each category's pass rate and cost per completed task, by the scenarios' `tags`; tokens with the cache split; model calls per turn; cost in all, per turn, per whole run and **per completed task** (everything spent, failures included, over the cases passed); first-token and model time p50 and p90; invalid tool calls; refusals. And the picks (`leadersOf`): for all scenarios and each category, the cheapest model per completed task among those within `--within` points (default 2) of the best pass rate.
  - **Reports.** `--json` writes the results (`MatrixResults`, `format: "agent-evals-matrix"`, `version: 1`), `--html` a self-contained leaderboard (`leaderboardHtml`: a sortable table, the picks, the categories, the models, every scenario's results by model; it loads nothing), `--markdown` a summary (`matrixMarkdown`). The same results give the same bytes. JUnit names each case's model and run.
  - **A spend limit.** `--estimate` prices the run without calling a model (`estimateRun`, `estimateMatrix`): each turn's budget from its `usage` bounds, else the configuration's `budgets.turn`, at each model's prices, plus one verdict per rubric at the judge's (`budgets.judgeCall`, default 2,000 tokens in and the judge's most out); input not declared as read from the cache is priced as written to it where the model caches. `--max-cost <usd>` runs nothing when the estimate is over it, and refuses the next model request once the run has spent it (`SpendGuard`, `SpendLimitError`): the run stops, says so, and leaves the cases it stopped out of every figure. A matrix exits 0 when every case ran, 1 when a case could not run as written, 2 when it could not start, and 4 when the limit stopped it. `--concurrency <n>` runs cases side by side.
  - **Recordings.** A matrix files each model's recordings apart, and each run after the first apart (`<suite>/<model>/<scenario>.<channel>.run-<n>.json`); its fingerprint takes the candidate and the judge, so a single model's recordings are unchanged.

  `@ouispec/contract`: a suite and a scenario take `tags` (`AgentEvalTagList`), the categories a matrix reports pass rates by; they change nothing the model is asked. The integrator guide describes the matrix.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.14.0
  - @ouispec/agent-core@0.26.0
  - @ouispec/bindings@0.14.0
  - @ouispec/agent-worker@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies
  - oui-spec@0.14.0
  - @ouispec/agent-core@0.25.0
  - @ouispec/agent-worker@0.25.0
  - @ouispec/contract@0.12.3
  - @ouispec/bindings@0.12.3

## 0.24.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.24.0
  - @ouispec/agent-core@0.24.0
  - @ouispec/contract@0.12.1

## 0.23.0

### Patch Changes

- Updated dependencies
  - oui-spec@0.13.0
  - @ouispec/bindings@0.12.0
  - @ouispec/agent-worker@0.23.0
  - @ouispec/agent-core@0.23.0

## 0.22.4

### Patch Changes

- **A choice offered twice with no reply says its card's context as the reply** (`requireReplyBeforeChoice`). When a sent-back `present_options` comes back with still no reply, it goes through as before. What its card says first (`context`) is now said as the turn's reply instead, sent to the room and stored as the step's text, and the card shows its question alone. So the person and the history both get a reply, and the card doesn't repeat it. A card with an empty context goes through as it is.

  The send-back (`REPLY_BEFORE_CHOICE_ERROR`) now says what the reply is: the plain text written outside any tool call, which the card and its context are not. Measured on DEOS (2026-10-31): sent back, the model offered the card again with its answer in `context` and no reply, in 2–3 turns per eval run.

- Updated dependencies
  - @ouispec/agent-worker@0.22.4

## 0.22.2

### Patch Changes

- **A choice is the question that follows a reply.**

  - **A choice ends the turn only when it ran.** A call to a tool that asks the person (`present_options`, `confirm_action`, `request_user_decision`) used to end the turn whether it ran or not. One that was refused by policy, invalid, or sent back now asked nothing, and the step goes back to the model.
  - **Policies are told what the turn has written.** `ToolPolicyContext.replyText` is every word the turn has written up to the call, as the model's stream gave it, including the words before the call in the same step. A turn policy's `prepareStep` gets each step's `text`.
  - **`requireReplyBeforeChoice`** (opt-in, `AgentRuntimeConfig` and the orchestrator's config). A `present_options` call made before the turn has written a word is sent back once, with `REPLY_BEFORE_CHOICE_ERROR`: write the reply, then offer the choice again. A second empty choice goes through, so a turn never ends with neither a reply nor its choice, and never loops. Measured on DEOS (2026-10-30): a third of turns ended on a choice card with no reply, whatever the prompt said.
  - **agent-evals.** `EvalAgentConfig` takes `requireReplyBeforeChoice`, and it is part of a recording's fingerprint. A turn's `choices` leave out a card the runtime sent back, since it was never shown.

- Updated dependencies
  - @ouispec/agent-worker@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.11.0
  - @ouispec/bindings@0.11.0
  - @ouispec/agent-core@0.22.1
  - @ouispec/agent-worker@0.22.1

## 0.22.0

### Minor Changes

- **An eval's page shows what the product's pages show.** The fixture page (`AgentEvalPage`) declares `shown`, each display's facts in the shape `useAgentFacts` reports them (`id`, `title`, `facts` by label, `item` for a card of a list), and `problems`, each page area's problems as `useAgentProblems` reports them (`source`, `problems`). They are registered with the binding registry as the product's displays and page areas register them, so the page state carries the Home's numbers and a list's cards under `shown` exactly as the product's tab does: by display, a long list kept as an index of its rows (`x-rows`), the rest read with `ui_read` at the display's own offset; and the page's problems in its `problems` observation, or the navigation surface's when no page is open. Each is shown on its `routes` and while the address holds its `query`. A surface declared in the suite takes `shown` (its `state` observation, declared with `x-rows`) and `problems` too.

  **The manifest records each page's displays.** The generator writes each display a page or shell shows on its surface (`displays`: binding id, title, description, the labels the build can read; `ManifestDisplay`), so a fixture names a display as the build does: an id the manifest does not record fails the page, a title left out is the manifest's, and an entry with no `routes` is shown where its page is. A page with no display records none; a manifest generated before this release is read as before.

  **A control follows the address's query.** A fixture control bound to a query parameter (`query: view`) takes its value from the page's address, read with the page's declared query as the generator records it in `app.navigate` (`pageQueryOf`, then `readQuery`: its default when the address leaves it out), follows the address when `app.navigate` goes to the page with another query, and writes the value a run gives it back to the address (`writeQuery`), so `/dashboard/service-lane?view=declined` opens on the declined tab. A parameter no page declares, or `query` on a list's control, fails the page.

  **The conversation store is given the turn it reads for.** `EvalHistory.getHistory`, and `createMemoryHistory`'s `window`, now receive `request.turn` beside the worker's request (`EvalHistoryRequest`, `EvalHistoryTurn`): the turn's id and place, its suite, scenario and channel, the customer (`user`), the context it is sent with (the scenario's view, the page's `currentPath`, `oui` and `uiKnowledge`), and where the page is (`at`). A step context written from the page needs no pass-through `beforeTurn`. A store that ignores it is unchanged.

  **Bindings.** `pageQueryOf` reads a page's query schema back into its declaration; `generatedNavigationSurface` is the navigation surface the generator emits, now shared by the generator and the eval page, whose own navigation surface now carries the `problems` observation, as the generator's does.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.10.0
  - @ouispec/bindings@0.10.0
  - @ouispec/agent-core@0.22.0
  - @ouispec/agent-worker@0.22.0

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

- Updated dependencies
  - @ouispec/agent-worker@0.21.0
  - @ouispec/contract@0.9.0
  - @ouispec/agent-core@0.21.0
  - @ouispec/bindings@0.9.0

## 0.20.2

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.8.0
  - @ouispec/agent-worker@0.20.2
  - @ouispec/agent-core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.7.0
  - @ouispec/agent-core@0.20.1
  - @ouispec/agent-worker@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-worker@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.19.0
  - @ouispec/agent-worker@0.19.0
  - @ouispec/contract@0.6.0

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
- Updated dependencies
  - @ouispec/agent-core@0.18.0
  - @ouispec/agent-worker@0.18.0
  - @ouispec/contract@0.5.0
