---
"@ouispec/agent-react": patch
---

A turn's end ends the tab's turn only when it is the turn the tab is running.

- **What was wrong:** `AgentProvider` applied every `done` and `error` to the turn in progress without checking whose it was. A turn that stops for the person's approval sends its completion a moment after the card appears. A person who approved at once had already started the continuation, and that late completion switched `isStreaming` off for the whole of it. A host that accepts the assistant's requests only while a turn is in progress then refused every one, and the approved action never ran.
- **Now:** the provider knows its turn from the moment `startTurn` begins. An end that arrives while the start request is in flight is held, and judged once the turn has its id: the turn's own end ends it; an earlier turn's finishes only that turn's message. Once a turn has its id, an end with another turn's id does not end it, clear its room or touch its text.
- **A start that fails** ends the turn as before, and an end held meanwhile is applied as the earlier turn's.
- **Tests:** the exact order seen in production (approval required, approved at once, the stopped turn's completion, then the continuation), the same with a late `error`, an end held and judged by id, a failed start, and the current turn's end after a reconnect.
