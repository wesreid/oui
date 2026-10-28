## Irreversible actions: the approval card

A `transaction` — an order, a payment, a send, a publish — and any `write` declared `destructive` run only on an approval the person gave, bound to the exact call. No policy waives it.

1. The agent worker stops the turn at the call, stores it with its args hash, and the person's tab receives `agent:approval_required` with a preview whose every word comes from the action's declaration, never from the model. A host may write that display copy itself (the worker's `approvals.preview`): to redact a value, or to say it in the person's language, with `spokenReadback` for a voice. The stored call and the args hash it is bound to stay the model's.
2. The tab renders the approval card. In a UI only a click on the card counts: a "yes" typed in chat is a message. On voice, phone, SMS and chat, the verbatim readback (on a voice, its `spokenReadback` when the host wrote one) and an affirmative next turn. The turn says which: its payload's `channel` (`ui` by default; a live call's turns are `voice`, or `phone` when your `resolveTurn` says so), and the worker tells the model about approvals in that channel's terms. On a conversation channel the readback is sent as the turn's last words, its pieces marked `readback: true`, and stored as the agent's; your classifier of the next message decides as the user (`POST /internal/approvals/{id}/decide` with that channel). An action on the person's page is approved by its card, and on `voice`, `phone` and `chat` by its readback too: it is read back like any other call, and its card is on the person's screen as well. On SMS, which has no page beside it, it stays card-only: the model is told the card is on their screen, nothing is read back, and an SMS approve of it is refused (`channel`). A spoken or texted "no" always declines it.
3. The click goes to the approval store on the person's own socket (`approval:decide`). The store answers the decider only, with a single-use token and the call's args hash, and the tab's OUI runtime receives a grant (`grantApproval`). When a page's action is approved by its readback on `voice`, `phone` or `chat`, the engine gets the token and the store pushes a single-use grant (`agent:approval_granted`) to the room the worker stored with the call: the turn's own. A tab whose open conversation it is, and which is in that room, claims it on its own socket (`approval:claim`); only the first claim gets the grant, which lasts two minutes at most, and that tab's runtime takes it. A decline is pushed too (`agent:approval_declined`), and the card says how the person decided. Only the store sends these: the emit API and a client's relay refuse them.
4. The next turn carries the token, outside the message text. The worker redeems it for the stored call, exactly, and runs it. A UI action then reaches the tab carrying `approval: { approvalId, argsHash }`, and the tab runs it only when that matches its grant. A tab that was never given that approval refuses the request on its receipt and neither runs nor answers it, so with the conversation open in two tabs only the one holding the grant runs it; a replayed grant is refused.

Render the card with `ApprovalCard` from `@ouispec/agent-react`, drawn with your design system's parts:

```tsx
<ApprovalCard components={{ Card: MyCard, Button: MyButton }} labels={{ approve: 'Place order' }} />
```

5. When the realtime server holds receipt keys, redemption also returns a signed **receipt**, and a host or API tool's approved call carries it to the tool's own API: a generated API tool as the `OUI-Approval-Receipt` header, a host tool on `ctx.approval.receipt`. The API verifies it offline with `verifyApprovalReceipt` from `@ouispec/agent-core` (or any JOSE library) against the server's keys at `/.well-known/oui-approval-jwks.json`, and acts on each receipt's `jti` once. The receipt names the one API it is for, fixed when the approval was stored, and lasts 120 seconds. A UI action gets none.

The card takes no `agent` prop, and a package that ships its own card declares it under `oui.personOnly` (`{ "ApprovalCard": "the person's own approval" }`), so the generator refuses to bind it: the assistant can never operate its own approval. The args hash is SHA-256 over the RFC 8785 canonical JSON of the arguments, lowercase hex; `oui-spec/approval-vectors.json` holds every implementation to it, in any language.

<!-- schema: approvals.json#/$defs/ApprovalRequiredEvent -->

<!-- schema: approvals.json#/$defs/ApprovalDecideResult -->

<!-- schema: approvals.json#/$defs/ApprovalGrantedEvent -->

<!-- schema: approvals.json#/$defs/ApprovalClaimPayload -->

<!-- schema: approvals.json#/$defs/ApprovalClaimResult -->

<!-- schema: approvals.json#/$defs/ApprovalDeclinedEvent -->

<!-- schema: approvals.json#/$defs/ApprovalContinuation -->

<!-- schema: approvals.json#/$defs/ActionRequestApproval -->

<!-- schema: approvals.json#/$defs/ApprovalTokenClaims -->

<!-- schema: approvals.json#/$defs/ApprovalReceiptClaims -->
