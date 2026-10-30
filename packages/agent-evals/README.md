# @ouispec/agent-evals

Agent evals as data, run against your real agent configuration on every channel you serve, as a gate in CI.

```sh
npm install --save-dev @ouispec/agent-evals
```

- **Scenarios are data.** A suite is a JSON or YAML file (the contract's `agent-evals.json`): what the customer says turn by turn, their answer to an approval, a person on the staff taking the conversation over and handing it back, and what must hold after each turn. That covers what the reply must and must not say (text, a regular expression, or a rubric a judge model decides), the tools called with given arguments, the tools not called, how many times a tool or a page action was called (`calls`), an approval asked for with its readback, a refusal, what the turn must not store, a turn not run while a person holds the conversation, the turn's token budgets and the share read from the prompt cache (`usage`), the choice buttons it offered (`choices`), and where the page went and what ran on it (`page`).
- **Your real configuration.** `defineEvals({ agent })` returns the same persona, tools, `ToolPolicy`, `TurnPolicy`, hooks (`beforeTurn`, `filterEvent`, `approvals.preview` and `approvals.validateBeforeApproval`), `modelProviderOptions`, `forcedToolChoice` and `uiActions` settings your worker runs with. The harness runs them through the SDK's own turn runner, and replaces only what reaches the outside: the model's network, storage, the realtime server, the person's page, and each tool's execution, by its stub. A tool call with no stub fails the case: an eval never reaches a backend.
- **A page that answers.** A suite declares the page its turns are sent from (`page`): surfaces of its own, or your own controls from your generated manifest (`defineEvals({ page: { manifest, knowledge } })`), mounted with a real binding registry and `connectBindings` as your tab mounts them. It runs on a real oui-spec surface runtime, answers `ui_act`, `ui_describe` and `ui_read`, and goes where `app.navigate` sends it; the next turn is sent from there. `createFixturePage` builds one for your own tests.
- **Your conversation store.** `history` plugs in your store (`EvalHistory`), or your window over the whole conversation (`createMemoryHistory({ window })`), so later turns read what your worker reads.
- **Every channel.** Name your channels (`web_chat`, `sms`, `voice`) and what each changes: how an approval is confirmed (the card, or a readback the next message confirms), and whether a message was spoken. Every scenario runs on every channel, so the channels cannot drift apart.
- **Recorded in CI, live on demand.** `agent-evals` replays each scenario's recording through your real provider package, with no network and no credentials. `agent-evals --record` runs the live model and writes the recordings; `--live` runs it without writing. A recording knows the configuration it was made against: change the prompt, a tool, a scenario or its page, and its replay fails until you record it again.
- **A judge that answers.** A rubric's verdict is asked for as structured output and asked again when it is no verdict (`judgeOptions`). A judge that never gives one is reported apart from a failure: the case is `unjudged` (`JUDGE`, a JUnit `error`, exit 3 when nothing failed).

```sh
agent-evals                      # replay: the CI gate (exit 1 on any failed assertion, 3 when only the judge failed)
agent-evals --record             # run the live model and write the recordings
agent-evals --channel sms --scenario price-only --junit evals.xml
```

In a test runner, `evalCases(config)` gives one case per scenario and channel; `await evalCase.assert()` throws with every failure.

The package ships an example in `examples/dealer`: a fake dealer agent, and its first acceptance cases (AI disclosure, dealer price and no payments, an injected instruction, an SSN refused and not stored, a request for a person, a booking confirmed by its readback, a take-over and hand-back) on web chat, SMS and voice, recorded from Claude on Bedrock.

The integrator guide (`@ouispec/contract/INTEGRATOR-GUIDE.md`, "Evals") documents the suite format. The package releases with the rest of the agent SDK, under one version: see [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md).
