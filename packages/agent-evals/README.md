# @ouispec/agent-evals

Agent evals as data, run against your real agent configuration on every channel you serve, as a gate in CI.

```sh
npm install --save-dev @ouispec/agent-evals
```

- **Scenarios are data.** A suite is a JSON or YAML file (the contract's `agent-evals.json`): what the customer says turn by turn, their answer to an approval, a person on the staff taking the conversation over and handing it back, and what must hold after each turn. That covers what the reply must and must not say (text, a regular expression, or a rubric a judge model decides), the tools called with given arguments, the tools not called, how many times a tool or a page action was called (`calls`), an approval asked for with its readback, a refusal, what the turn must not store, a turn not run while a person holds the conversation, the turn's token budgets and the share read from the prompt cache (`usage`), the choice buttons it offered (`choices`), and where the page went and what ran on it (`page`).
- **Your real configuration.** `defineEvals({ agent })` returns the same persona, tools, `ToolPolicy`, `TurnPolicy`, hooks (`beforeTurn`, `filterEvent`, `approvals.preview` and `approvals.validateBeforeApproval`), `modelProviderOptions`, `forcedToolChoice` and `uiActions` settings your worker runs with. The harness runs them through the SDK's own turn runner, and replaces only what reaches the outside: the model's network, storage, the realtime server, the person's page, and each tool's execution, by its stub. A tool call with no stub fails the case: an eval never reaches a backend.
- **A page that answers.** A suite declares the page its turns are sent from (`page`): surfaces of its own, or your own controls from your generated manifest (`defineEvals({ page: { manifest, knowledge } })`), mounted with a real binding registry and `connectBindings` as your tab mounts them. It runs on a real oui-spec surface runtime, answers `ui_act`, `ui_describe` and `ui_read`, and goes where `app.navigate` sends it; the next turn is sent from there. What your pages show that is not a control (`shown`: the Home's numbers, a list's cards) and the problems they show (`problems`) are declared in the runtime's own shape and reported in the page state as your tab reports them, a long list indexed by its rows and read further with `ui_read`. A control bound to a query parameter (`query`) shows the address's value through your page's declared query, follows `app.navigate`'s query, and writes its value back to the address. A part whose controls follow what is done on it, such as a form asked one step at a time, is rendered in code by a page model (`page.models`): it says what it shows where the page is and what each of its controls does, and is rendered again after each run. `createFixturePage` builds one for your own tests.
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

## A declared page that shows what it was given

A surface declared in the suite reports the `state` it is given, and each action leaves the `state` its fixture says. An action that `writes` also puts what its input gives into that state once it succeeds, so the next observation shows what was typed or chosen, as your page does, and a model never writes a line again because the page still shows it empty:

```yaml
page:
  at: /scripts/s-1
  surfaces:
    - id: room:script
      name: Script
      description: A script's lines.
      routes: [/scripts/:scriptId]
      state:
        state:
          lists:
            line.text:
              - { key: line-1, title: Line 1, value: Spring is here. }
              - { key: line-2, title: Line 2, value: '' }
      actions:
        - id: script_line_text
          description: Types the words of a line.
          input: { type: object, properties: { item: { type: string }, value: { type: string } } }
          # The row `item` names, in the list at state › lists › line.text, takes the input's `value`.
          writes: [{ to: [state, lists, line.text], item: item }]
        - id: script_title
          description: Renames the script.
          input: { type: object, properties: { value: { type: string } } }
          # A field: the input's `value` replaces state › title.
          writes: [{ to: [state, title] }]
```

- **`to`** is a path of whole keys into the surface's state, its observation id first, so a key may hold dots (`line.text`). With **`item`** (the input property that names the row), `to` holds a list, and the row's `field` (default `value`) takes the input's `value` (or the property named by `value`). Rows are addressed by `ref` (default `key`) and named by `title` (default `title`).
- **A row is named as your page names it**: by its key, else its title, exactly or ignoring case and outer spaces (the bindings' own `resolveRef`). The action runs, is recorded and matches its `cases` with the row's key. A name several rows share fails the call (`AMBIGUOUS_ITEM`), and one no row has fails it once it would write (`ITEM_NOT_FOUND`), each listing the rows on screen.
- **Only a run that succeeds writes**, after its own `state`: never one its `result`, or the `cases` entry its input holds, fails. An input that leaves the value out writes nothing, and the fixture you wrote is never changed, so each case starts from the same page.
- **A page that declares no `writes` is the page it was**, and a recording's fingerprint covers `writes`, so adding one replays the old recording as stale.

`page.ran` and `page.ranInCase` judge a run's `item` the same way where the run addressed a list the page knows (a control's `rows`, a model's, or a list an action `writes`): `{ action: script_line_text, input: { item: line-2 } }` holds a run the agent gave as "Line 2", and an `item` that names no row of that list fails, naming the row it looked for and the rows the list holds. Everything that held before still holds. `EvalPage.rowsOf(run)` gives the rows a run addressed, and `resolveRow` resolves a name among rows as the page does.

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
