# @ouispec/agent-evals

## 0.11.0

### Minor Changes

- Agent evals as data, on every channel, as a gate in CI (ADR-0260 §3).

  - **agent-evals (new):** scenarios a product writes as JSON or YAML, run against its real agent configuration through the SDK's own turn runner on every channel it serves, from recorded model responses (no network, no credentials) or the live model. Assertions: says and must not say (text, pattern or a judged rubric), a tool called with given arguments, a tool not called, an approval asked for with its readback, a refusal, nothing kept that must not be, and a turn not run while a person holds the conversation. A recording knows what it was recorded against, and fails when the configuration changes. Every tool is stubbed. The `agent-evals` CLI (`--record`, `--live`, `--json`, `--junit`) and `evalCases` for a test runner. An example dealer suite, recorded from Claude on Bedrock.
  - **contract:** `agent-evals.json`, the suite format (`AgentEvalSuite`).
  - **agent-worker:** a turn's `channel` (`ui`, or `chat`, `sms`, `voice`, `phone`): on a conversation channel the model is told an approval is a readback the customer confirms, and the readback is the turn's last words, sent and stored verbatim. `realtime.emit` overrides how turn events are sent; `hostSystemPrompt`; and `@ouispec/agent-worker/testing` gains `recordingFetch`, `replayingFetch` and `scriptedChatCompletions`.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ouispec/contract@0.5.0
  - @ouispec/agent-worker@0.11.0
  - @ouispec/agent-core@0.11.0
