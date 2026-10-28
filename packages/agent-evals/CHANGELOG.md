# @ouispec/agent-evals

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
