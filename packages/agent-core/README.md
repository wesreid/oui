# @ouispec/agent-core

What the rest of the agent SDK shares: the turn protocol's event names and payload types, the schema and entity types a product's tools are declared with, intent resolution, the UI-surface types a tab sends with a turn, and the approval types and `argsHash` an irreversible call is bound by.

```sh
npm install @ouispec/agent-core
```

It has no runtime of its own. `@ouispec/agent-worker` (the agent), `@ouispec/agent-realtime` (the server between the agent and the browser) and `@ouispec/agent-react` (the browser) build on it, and all four release together under one version.

- The turn events come from `@ouispec/agent-events`, and the approval messages from `@ouispec/contract`'s `approvals.json`.
- `argsHash` and the approval rules are `oui-spec`'s. `@ouispec/agent-core/approval-vectors.json` re-exports its test vectors, so an engine in another language can hold its own hash to them.

## Verifying an approval receipt

A tool's own API refuses an irreversible request no user approved with `verifyApprovalReceipt`. The realtime server signs a receipt when it redeems an approval, and the worker sends it on the approved call as the `OUI-Approval-Receipt` header (`APPROVAL_RECEIPT_HEADER`). The function runs on WebCrypto, the same in Node and in the browser build.

```ts
import { APPROVAL_RECEIPT_HEADER, argsHash, verifyApprovalReceipt } from '@ouispec/agent-core';

const checked = await verifyApprovalReceipt(request.headers.get(APPROVAL_RECEIPT_HEADER) ?? '', {
  jwks: 'https://realtime.example.com/.well-known/oui-approval-jwks.json', // or the JWKS document itself
  expectedArgsHash: await argsHash(toolInput), // the call as you received it
  audience: 'https://api.example.com', // your own origin
});
// { ok: true, claims } or { ok: false, reason, error }
```

- `expectedArgsHash`: for a generated API tool, the tool's input as the worker's executor received it, one object holding every path, query and body parameter by its declared name; for an operation whose input is its body, that body.
- `jwks` as a URL is fetched, cached for the response's `max-age`, and fetched again when a receipt names a key id it lacks, at most once a minute. A key set that cannot be read refuses with `key`.
- It checks, in order: the header (`alg` `EdDSA`, `typ` `oui-approval-receipt+jwt`, a `kid`, no `crit`), a published key with that id, the signature, the claims' shape, `exp` and `iat` with 60 s of clock skew, `aud`, then `argsHash`. The refusal reasons are `malformed`, `key`, `signature`, `expired`, `audience` and `args`.
- **Single use is yours.** The receipt's `jti` is the call's idempotency key. Record each one you act on for at least two minutes, and answer a repeat with the first result, or refuse it.

Any JOSE library verifies a receipt too: accept only `EdDSA` with this `typ`, read the key from the JWKS by `kid`, and then check `exp`, `aud` and `argsHash` as above. `@ouispec/agent-core/receipt-vectors.json` holds receipts, the keys they were signed with, and the result each must give, for an implementation in any language.

See [the integrator guide](https://github.com/wesreid/oui/blob/main/packages/contract/INTEGRATOR-GUIDE.md) for how the pieces fit, and [VERSIONING.md](https://github.com/wesreid/oui/blob/main/VERSIONING.md) for what a release may change.
