---
"@ouispec/agent-worker": minor
---

A call that waited for approval says, in its stored result, how the approval ended.

- **What was wrong:** once the approved run's result replaced "waiting for approval", nothing in the history said an approval had happened. On the next turn the assistant could not tell the person had approved anything, and took back having said so. A declined or expired approval left the call showing "waiting for approval" on every later turn.
- **Approved:** the result carries `approval: { decided: "approved", by: "user", at, ran, summary }` first, with the summary "Approved by the user on the approval card, and run once." An object result gains the field; any other result is kept beside it as `result`.
- **Declined:** the continuation turn stores, under the call's own id, a result with `approval.decided: "declined"`, `notRun: true` and "Declined by the user on the approval card. It was not run."
- **Expired:** the same with `approval.decided: "expired"` (no `by`: nobody decided it) and "The approval expired before it was used. It was not run."
- **Approved but unavailable or refused when run:** `approval.decided: "approved"`, `ran: false`.
- **An approval already used** leaves the call's result as it is: that run's result stands.
- **Hosts:** a continuation turn can now persist a `tool` message for a decline or an expiry too, under the original call id. A host that gives the model the last stored result of a call (as the worker's own history conversion does) needs no change.
- **Tests:** the model's history in the continuation turn and on a later turn read back from the store, for approved, declined, expired and already-used.
