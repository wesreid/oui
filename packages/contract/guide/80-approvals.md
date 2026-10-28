## Irreversible actions: the approval card

A `transaction` — an order, a payment, a send, a publish — and any `write` declared `destructive` run only on an approval the person gave, bound to the exact call. No policy waives it.

1. The agent worker stops the turn at the call, stores it with its args hash, and the person's tab receives `agent:approval_required` with a preview whose every word comes from the action's declaration, never from the model. A host may write that display copy itself (the worker's `approvals.preview`): to redact a value, or to say it in the person's language, with `spokenReadback` for a voice. The stored call and the args hash it is bound to stay the model's.
2. The tab renders the approval card. In a UI only a click on the card counts: a "yes" typed in chat is a message. On voice, phone, SMS and chat, the verbatim readback (on a voice, its `spokenReadback` when the host wrote one) and an affirmative next turn. The turn says which: its payload's `channel` (`ui` by default; a live call's turns are `voice`, or `phone` when your `resolveTurn` says so), and the worker tells the model about approvals in that channel's terms. On a conversation channel the readback is sent as the turn's last words, its pieces marked `readback: true`, and stored as the agent's; your classifier of the next message decides as the user (`POST /internal/approvals/{id}/decide` with that channel). An action on the person's page is the exception on every channel: its page runs it only on its own grant, from a click on its card, so the model is told the card is on their screen, nothing is read back, and a conversation channel's approve of it is refused (`channel`). A spoken "no" still declines it.
3. The click goes to the approval store on the person's own socket (`approval:decide`). The store answers the decider only, with a single-use token and the call's args hash, and the tab's OUI runtime receives a grant (`grantApproval`).
4. The next turn carries the token, outside the message text. The worker redeems it for the stored call, exactly, and runs it. A UI action then reaches the tab carrying `approval: { approvalId, argsHash }`, and the tab runs it only when that matches its grant.

Render the card with `ApprovalCard` from `@ouispec/agent-react`, drawn with your design system's parts:

```tsx
<ApprovalCard components={{ Card: MyCard, Button: MyButton }} labels={{ approve: 'Place order' }} />
```

5. When the realtime server holds receipt keys, redemption also returns a signed **receipt**, and a host or API tool's approved call carries it to the tool's own API: a generated API tool as the `OUI-Approval-Receipt` header, a host tool on `ctx.approval.receipt`. The API verifies it offline with `verifyApprovalReceipt` from `@ouispec/agent-core` (or any JOSE library) against the server's keys at `/.well-known/oui-approval-jwks.json`, and acts on each receipt's `jti` once. The receipt names the one API it is for, fixed when the approval was stored, and lasts 120 seconds. A UI action gets none.

The card takes no `agent` prop, and a package that ships its own card declares it under `oui.personOnly` (`{ "ApprovalCard": "the person's own approval" }`), so the generator refuses to bind it: the assistant can never operate its own approval. The args hash is SHA-256 over the RFC 8785 canonical JSON of the arguments, lowercase hex; `oui-spec/approval-vectors.json` holds every implementation to it, in any language.

<!-- schema: approvals.json#/$defs/ApprovalRequiredEvent -->

<!-- schema: approvals.json#/$defs/ApprovalDecideResult -->

<!-- schema: approvals.json#/$defs/ApprovalContinuation -->

<!-- schema: approvals.json#/$defs/ActionRequestApproval -->

<!-- schema: approvals.json#/$defs/ApprovalTokenClaims -->

<!-- schema: approvals.json#/$defs/ApprovalReceiptClaims -->
