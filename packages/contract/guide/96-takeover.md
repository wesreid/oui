## Staff take over a conversation, and hand it back

A person on the product's staff can take a live conversation from the agent, answer the customer as themselves in the same conversation, and hand it back (ADR-0260 §2). While a person **holds** the conversation the agent does not answer: a turn that is running stops at a safe point and keeps what it had produced, marked `taken_over`; a turn that arrives is not run by the model and stores nothing. On hand-back the agent's next turn reads the whole exchange, the person's messages under their name, in its history.

**Who may take over is yours to decide.** The realtime server keeps the hold and enforces it, and never decides staff permissions: its routes take the internal key, and your API calls them after its own check that this person may take this conversation, as it does before it asks for a room token.

| Your API's route does | Then calls (internal key) |
|---|---|
| Take over: check the staff member may; withdraw the conversation's waiting approval (`POST /internal/approvals/{id}/settle` with `expire: 'taken_over'`); store a take-over entry | `POST /internal/conversations/{id}/hold` with `TakeOverRequest` |
| Send as staff: store the message with `role: 'staff'` and its speaker | `POST /internal/conversations/{id}/messages` with `AnnounceMessageRequest` (refused unless the speaker holds it) |
| Hand back: store a hand-back entry | `POST /internal/conversations/{id}/hold/release` with `HandBackRequest`: with `userId`, only the holder may; without it, you release it on your own authority (an idle policy, a manager) |
| Every customer and agent message you store | `POST /internal/conversations/{id}/messages`, so the staff watching see it |

`GET /internal/conversations/{id}/hold` answers who holds it (204: nobody). `createHttpConversationClient({ url, apiKey })` from `@ouispec/agent-worker` calls all of them. The three events they send, `agent:conversation_taken_over`, `agent:conversation_handed_back` and `agent:conversation_message`, are the server's own: `/api/emit` refuses them, so no event says a conversation changed hands when it did not.

**The conversation's room.** The events go to the rooms you name in each request: the conversation's own room (name it as you like, `support:conversation:{id}`, and have your `RoomPolicy` require a token for it), and any of your own (a team's board). The event catalog reserves the room name `conversation` for it, as it reserves `turn`; your declaration document may not declare a room by that name. Mint the conversation room's token for the customer whose conversation it is, and for each staff member who may watch it.

**What you store, and hand back.** A staff message is a stored message with `role: 'staff'`, its `content` and its `speaker` (`StaffSpeaker`). The take-over and the hand-back are stored too, as `role: 'staff'` entries with no content and `takeover: 'taken_over' | 'handed_back'`. `getHistory` returns each as `{ role: 'staff', content, speaker, takeover? }`; `getConversation` returns them on `messages`, and the conversation's current `hold`. The worker gives them to the model as the business's side of the conversation, under the person's name, so the agent knows what they told the customer and never takes their words for its own. A customer cannot forge one: the customer's text only ever reaches the model as the customer's.

**In the customer's tab.** Give `AgentClientConfig` a `conversationRoom(conversationId)` that returns `{ room, roomToken }`. The provider joins the room for the open conversation; `useAgent().hold` says who holds it; a person's messages arrive as messages with `role: 'staff'` and their `speaker`; the take-over and hand-back as `role: 'staff'` messages with `takeover`. The customer keeps typing: their messages reach your API as always, and `isProcessing` stays false while the conversation is held.

**In the staff console.** Give `AgentClientConfig` a `staff` seam (`getConversation`, `takeOver`, `handBack`, `sendMessage`: your routes above) and `conversationRoom`, and use `useStaffConversation(conversationId)` inside the provider: it loads the conversation, follows it live, and takes over, sends and hands back.

**An anonymous customer.** Nothing requires a signed-in user. Issue a website visitor a session token when your widget loads (after your origin check and rate limit), with a visitor id as `userId`; have your `AuthAdapter` verify it, and mint the visitor's conversation-room and turn-room tokens only for its own conversation. Its turns, stops and approvals are then the visitor's.

**What stays yours:** who is on duty, the alert to staff and how long they have to answer it, the mobile take-over screen, warm transfer on a phone call, and when an idle conversation goes back to the agent. Each has its seam above: your route before the hold, the events in your own rooms, `release` without a `userId`.

<!-- schema: conversation-takeover.json#/$defs/StaffSpeaker -->

<!-- schema: conversation-takeover.json#/$defs/ConversationHold -->

<!-- schema: conversation-takeover.json#/$defs/TakeOverRequest -->

<!-- schema: conversation-takeover.json#/$defs/HandBackRequest -->

<!-- schema: conversation-takeover.json#/$defs/AnnounceMessageRequest -->

<!-- schema: conversation-takeover.json#/$defs/ConversationMessage -->

<!-- schema: conversation-takeover.json#/$defs/ConversationTakenOverEvent -->

<!-- schema: conversation-takeover.json#/$defs/ConversationHandedBackEvent -->
