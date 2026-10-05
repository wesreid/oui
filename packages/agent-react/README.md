# @ouispec/agent-react

The agent in a React app: the provider that runs turns against the product's API and realtime server, the hooks a chat UI is built from, and the card where a person approves an irreversible action.

```sh
npm install @ouispec/agent-react
```

- `AgentProvider` and `useAgent`: the conversation, its messages and tool calls, sending a turn, and the turn's stream. The socket is a seam (`realtime.createSocket`), so a product supplies its own connection and credentials.
- `stopTurn`, `isStopping` and `acceptedTurnId` on `useAgent`: the person's Stop for the turn in progress, and the turn whose UI requests the tab runs now (give it to the tab's OUI runtime: `accept: acceptCurrentTurn(agent.acceptedTurnId)`). A message sent while a turn runs supersedes it; a stopped turn's message keeps what it had said, marked `stopped`.
- `ApprovalCard`: shows what an irreversible call will do and takes the person's decision. It can't be bound to the agent: only a person's click approves.
- `useFeedback`, `storedToAgentMessages`, and the view annotations.

React 18 or 19 is a peer dependency. It releases with the rest of the agent SDK, under one version: see [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md).
