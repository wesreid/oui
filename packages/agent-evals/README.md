# @ouispec/agent-evals

Agent evals as data, run against your real agent configuration on every channel you serve, as a gate in CI.

```sh
npm install --save-dev @ouispec/agent-evals
```

- **Scenarios are data.** A suite is a JSON or YAML file (the contract's `agent-evals.json`): what the customer says turn by turn, their answer to an approval, a person on the staff taking the conversation over and handing it back, and what must hold after each turn. That covers what the reply must and must not say (text, a regular expression, or a rubric a judge model decides), the tools called with given arguments, the tools not called, an approval asked for with its readback, a refusal, what the turn must not store, and a turn not run while a person holds the conversation.
- **Your real configuration.** `defineEvals({ agent })` returns the same persona, tools, `ToolPolicy` and `TurnPolicy` your worker runs with. The harness runs them through the SDK's own turn runner, and replaces only what reaches the outside: the model's network, storage, the realtime server, and each tool's execution, by its stub. A tool call with no stub fails the case: an eval never reaches a backend.
- **Every channel.** Name your channels (`web_chat`, `sms`, `voice`) and what each changes: how an approval is confirmed (the card, or a readback the next message confirms), and whether a message was spoken. Every scenario runs on every channel, so the channels cannot drift apart.
- **Recorded in CI, live on demand.** `agent-evals` replays each scenario's recording through your real provider package, with no network and no credentials. `agent-evals --record` runs the live model and writes the recordings; `--live` runs it without writing. A recording knows the configuration it was made against: change the prompt, a tool or a scenario, and its replay fails until you record it again.

```sh
agent-evals                      # replay: the CI gate (exit 1 on any failed assertion)
agent-evals --record             # run the live model and write the recordings
agent-evals --channel sms --scenario price-only --junit evals.xml
```

In a test runner, `evalCases(config)` gives one case per scenario and channel; `await evalCase.assert()` throws with every failure.

The package ships an example in `examples/dealer`: a fake dealer agent, and its first acceptance cases (AI disclosure, dealer price and no payments, an injected instruction, an SSN refused and not stored, a request for a person, a booking confirmed by its readback, a take-over and hand-back) on web chat, SMS and voice, recorded from Claude on Bedrock.

The integrator guide (`@ouispec/contract/INTEGRATOR-GUIDE.md`, "Evals") documents the suite format. The package releases with the rest of the agent SDK, under one version: see [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md). Specified by ADR-0260 §3.
