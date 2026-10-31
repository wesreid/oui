# @ouispec/agent-evals

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
