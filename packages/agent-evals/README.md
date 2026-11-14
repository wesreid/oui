# @ouispec/agent-evals

Agent evals as data, run against your real agent configuration on every channel you serve, as a gate in CI.

```sh
npm install --save-dev @ouispec/agent-evals
```

- **Scenarios are data.** A suite is a JSON or YAML file (the contract's `agent-evals.json`): what the customer says turn by turn, their answer to an approval, a person on the staff taking the conversation over and handing it back, and what must hold after each turn. That covers what the reply must and must not say (text, a regular expression, or a rubric a judge model decides), the tools called with given arguments, the tools not called, how many times a tool or a page action was called (`calls`), an approval asked for with its readback, a refusal, what the turn must not store, a turn not run while a person holds the conversation, the turn's token budgets and the share read from the prompt cache (`usage`), the choice buttons it offered (`choices`), and where the page went and what ran on it (`page`).
- **Your real configuration.** `defineEvals({ agent })` returns the same persona, tools, `ToolPolicy`, `TurnPolicy`, hooks (`beforeTurn`, `filterEvent`, `approvals.preview` and `approvals.validateBeforeApproval`), `modelProviderOptions`, `forcedToolChoice` and `uiActions` settings your worker runs with. The harness runs them through the SDK's own turn runner, and replaces only what reaches the outside: the model's network, storage, the realtime server, the person's page, and each tool's execution, by its stub. A tool call with no stub fails the case: an eval never reaches a backend.
- **A page that answers.** A suite declares the page its turns are sent from (`page`): surfaces of its own, or your own controls from your generated manifest (`defineEvals({ page: { manifest, knowledge } })`), mounted with a real binding registry and `connectBindings` as your tab mounts them. It runs on a real oui-spec surface runtime, answers `ui_act`, `ui_describe` and `ui_read`, and goes where `app.navigate` sends it; the next turn is sent from there. What your pages show that is not a control (`shown`: the Home's numbers, a list's cards) and the problems they show (`problems`) are declared in the runtime's own shape and reported in the page state as your tab reports them, a long list indexed by its rows and read further with `ui_read`. A control bound to a query parameter (`query`) shows the address's value through your page's declared query, follows `app.navigate`'s query, and writes its value back to the address. `createFixturePage` builds one for your own tests.
- **Your conversation store.** `history` plugs in your store (`EvalHistory`), or your window over the whole conversation (`createMemoryHistory({ window })`), so later turns read what your worker reads. Each read is given the turn it is for (`request.turn`: its id, scenario, channel, customer, context and page).
- **Every channel.** Name your channels (`web_chat`, `sms`, `voice`) and what each changes: how an approval is confirmed (the card, or a readback the next message confirms), and whether a message was spoken. Every scenario runs on every channel, so the channels cannot drift apart.
- **Recorded in CI, live on demand.** `agent-evals` replays each scenario's recording through your real provider package, with no network and no credentials. `agent-evals --record` runs the live model and writes the recordings; `--live` runs it without writing. A recording knows the configuration it was made against: change the prompt, a tool, a scenario or its page, and its replay fails until you record it again.
- **A judge that answers.** A rubric's verdict is asked for as structured output and asked again when it is no verdict (`judgeOptions`). A judge that never gives one is reported apart from a failure: the case is `unjudged` (`JUDGE`, a JUnit `error`, exit 3 when nothing failed).

```sh
agent-evals                      # replay: the CI gate (exit 1 on any failed assertion, 3 when only the judge failed)
agent-evals --record             # run the live model and write the recordings
agent-evals --channel sms --scenario price-only --junit evals.xml
```

In a test runner, `evalCases(config)` gives one case per scenario and channel; `await evalCase.assert()` throws with every failure.

## A model matrix: one run against every candidate model

The same suites, on every model you might run your agent on, several times each, judged by one fixed model, so the cheapest model that does your work well enough is chosen by your own scenarios rather than a public benchmark.

```sh
agent-evals --models models.json --runs 5 --estimate            # what it will cost; calls no model
agent-evals --live --models models.json --runs 5 --max-cost 400 \
  --json results.json --html leaderboard.html --markdown summary.md
agent-evals --record --models all --runs 5                       # the same, writing each model's recordings
agent-evals --models all --runs 5 --html leaderboard.html        # in CI: replays them, no network
```

- **Candidates are data.** Each model your registry declares: `{ id, label, providerOptions, capabilities: { promptCache, forcedToolChoice, temperature, vision, contextWindow }, prices: { input, output, cacheRead, cacheWrite } }`, prices in US dollars per million tokens. Give them as `models` in the configuration (`--models all`, or some by id, comma-separated) or in a file (`--models models.json`, `.yaml` or a module). The configuration's `model` factory is handed each one (`seam.candidate`) and builds it; a case whose factory builds another model fails rather than measuring the wrong one. Each candidate's turns send its own `providerOptions` in place of the agent's, a cache breakpoint only where it caches, no forced tool choice and no temperature where it takes none.
- **One judge.** Rubrics are decided by `judgeModel` (`{ id, label, providerOptions, prices }`), the same model for every candidate and never one of them. Its verdicts are priced apart from the candidates' cost.
- **What each call used.** Input, output, cache-read and cache-write tokens as the provider reported them; the time to its first token and in all; why it finished. Per turn: model calls, invalid tool calls (input the tool's schema refused or that would not parse, or a tool that does not exist) and refusals (a call the provider stopped for its content, or a reply in the words of a refusal on a turn that expects none; `refusal` in the configuration sets the words). A recording keeps its calls' times, so a replay reports the live run's latency.
- **Per model.** Pass rate over the cases judged, with its mean, least and most across runs; the pass rate in each category (`tags` on a suite or a scenario); tokens with the cache split; cost per run and **cost per completed task** (everything it spent, failures included, over the cases it passed); first-token and model time p50 and p90; invalid tool calls; refusals. And the picks: for all scenarios and for each category, the cheapest model per completed task among those within `--within` points (default 2) of the best pass rate.
- **Reports.** `--json` writes the results (`format: "agent-evals-matrix"`: every case with its turns, each model's summary, the picks and the spend); `--html` a leaderboard page that loads nothing (a sortable table, the picks, the categories, and every scenario's results by model); `--markdown` a summary. The same results give the same bytes. `runMatrix`, `leaderboardHtml` and `matrixMarkdown` do the same in code.
- **A spend limit.** The cost is estimated before anything runs, from each turn's token budget (its `usage` bounds: `inputTokens.max`, or `callInputTokens.max` × `modelCalls.max`, `outputTokens.max` and `cachedShare.min`; else the configuration's `budgets.turn`) at each model's prices, plus one verdict per rubric at the judge's (`budgets.judgeCall`). Input not declared as read from the cache is priced as written to it on a model that caches, so the estimate does not fall short. `--estimate` prints it and calls no model. `--max-cost <usd>` runs nothing when the estimate is over it, and, while the run goes, refuses the next model request once the run has spent it: the run stops, and reports what it ran, the cases it stopped left out of every figure.

A matrix exits 0 when every case ran (a model failing a scenario is a result, not an error), 1 when a case could not run as written (a recording missing or stale, the wrong model built), 2 when it could not start, and 4 when the spend limit stopped it. `--concurrency <n>` runs cases side by side; a recording is filed under its model, and each run after the first apart (`<suite>/<model>/<scenario>.<channel>.run-<n>.json`).

The package ships an example in `examples/dealer`: a fake dealer agent, and its first acceptance cases (AI disclosure, dealer price and no payments, an injected instruction, an SSN refused and not stored, a request for a person, a booking confirmed by its readback, a take-over and hand-back) on web chat, SMS and voice, recorded from Claude on Bedrock.

The integrator guide (`@ouispec/contract/INTEGRATOR-GUIDE.md`, "Evals") documents the suite format. The package releases with the rest of the agent SDK, under one version: see [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md).
