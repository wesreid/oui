## Evals: one scenario set, every channel, in CI

`@ouispec/agent-evals` runs scenarios you write as data against your **real** agent configuration (its persona or system prompt, its tools, its `ToolPolicy` and `TurnPolicy`) through the SDK's own turn runner, on every channel you serve, and fails your CI when an assertion does not hold (ADR-0260 §3). In CI it replays recorded model responses: no credentials, no network, the same answer every run.

**A suite** is a JSON or YAML file (`AgentEvalSuite`). A scenario's turns are the customer's messages (`user`), the customer's answer to a waiting approval (`approval: approve | decline`), and a person on the staff taking over, writing and handing back (`staff`). After a turn, `expect` says what must hold, and `expectOn.<channel>` what must also hold on one channel:

| Assertion | Holds when |
|---|---|
| `says`, `mustNotSay` | each matcher matches the reply; none does. A string is found ignoring case; `{ pattern, flags }` is a regular expression; `{ rubric }` is decided by a judge model |
| `toolCalled` | the agent called each tool, its arguments holding the given ones as a subset |
| `toolNotCalled` | it called none of them (`*`: no tool at all) |
| `approvalRequested` | the turn stopped for the customer's approval of that call, with a readback that is present and matches (`false`: it stopped for none) |
| `refusal` | the reply declines (`true`: the usual phrasing; or a matcher) |
| `doesNotStore` | the matchers appear nowhere the turn stored: its text, its tool arguments, its tool results |
| `held` | the turn ran no model call, because a person held the conversation |

```yaml
version: 1
name: dealer
stubs:
  inventory_search:
    - when: { stock: T2417 }
      result: { success: true, data: { stock: T2417, price: 31995, status: available } }
scenarios:
  - id: price-only
    title: Quotes the dealer price and no payments
    turns:
      - user: Is T2417 still available, and what's the price?
        expect:
          toolCalled: [{ name: inventory_search, args: { stock: T2417 } }]
          says: ["31,995"]
          mustNotSay: [{ pattern: "per month|/mo|APR", flags: i }]
```

**Every tool is stubbed.** A stub is data in the suite or the scenario (`when`, a subset of the call's arguments; `result`), first match wins, the scenario's first; or a function in the configuration. A call to a tool with no stub fails the scenario: an eval never reaches your backend.

**Channels.** Your configuration names them, and what each changes: `approvals` (the card, `ui`, or a conversation channel, `chat`, `sms`, `voice`, `phone`, where the readback is sent and the next message confirms it), `input` (what each customer message carries as `context.input`, so a voice channel marks it spoken), and `context`. The turn carries its channel, and the worker tells the model about approvals in that channel's terms. Every scenario runs on every channel of its suite unless it names fewer, so a change that breaks SMS and not web chat fails.

```ts
// agent-evals.config.mjs
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { defineEvals } from '@ouispec/agent-evals';
import { dealerAgent } from './src/dealer-agent.js'; // the parts your worker runs with

export default defineEvals({
  root: new URL('.', import.meta.url),
  suites: ['evals/dealer.evals.yaml'],
  cassettes: 'evals/cassettes',
  channels: {
    web_chat: { approvals: 'ui' },
    sms: { approvals: 'sms' },
    voice: { approvals: 'voice', input: { mode: 'voice', language: 'en' } },
  },
  model: ({ fetch, mode }) =>
    createAmazonBedrock({
      region: 'us-east-1',
      fetch,
      ...(mode === 'replay' ? { credentialProvider: async () => ({ accessKeyId: 'replay', secretAccessKey: 'replay' }) } : {}),
    })('us.anthropic.claude-sonnet-4-6'),
  agent: ({ channel }) => dealerAgent({ channel }), // persona, tools, toolPolicy, turnPolicy
});
```

**Run it.** `agent-evals` (in CI: replays the recordings), `agent-evals --record` (runs the live model and writes them), `agent-evals --live` (runs it and writes nothing). `--channel` and `--scenario` narrow a run; `--json` and `--junit` write reports. It exits 1 when any case fails, listing each failed assertion with its turn, channel and the reply. In a test runner, `evalCases(config)` gives one case per scenario and channel, each throwing with every failure.

**A recording knows what it was recorded against**: your system prompt, your tools' names, descriptions and schemas, the scenario's turns and the channel. Change any of them and its replay fails until you record it again, rather than passing on answers to a question no longer asked.

The package ships an example: a fake dealer tool set, with scenarios for disclosure, price and no payments, an injected instruction, an SSN refused and not stored, a request for a person, a booking that runs only after its readback is confirmed, and a take-over and hand-back, on web chat, SMS and voice.

<!-- schema: agent-evals.json -->

<!-- schema: agent-evals.json#/$defs/AgentEvalExpectation -->

<!-- schema: agent-evals.json#/$defs/AgentEvalStubCase -->
