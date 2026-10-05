# @ouispec/agent-realtime

## 0.7.0

0.6.0 was not published; its changes ship in 0.7.0.

### Minor Changes

- Released with the rest of the agent SDK at one version (VERSIONING.md): no change of its own beyond the SDK's.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.10.0
  - @ouispec/agent-core@0.7.0
  - @ouispec/agent-events@0.7.0

## 0.5.0

### Minor Changes

- A running turn can be stopped, and a message sent while a turn runs supersedes it (Closure ADR-0252, phase 1).

  - **oui-spec:** an action request may name its turn (`turnId`, carried by the socket transport), and `acceptCurrentTurn` is the `accept` rule for a client that runs one turn at a time: a request a stopped or superseded turn sends late is refused, and one that names no turn (an older worker) is accepted while a turn is in progress, as before.
  - **agent-events:** `agent:turn_complete` declares `stopReason` (`user_stop`, `superseded`); the UI dispatch declares `turnId`.
  - **agent-core:** the turn-stop event, reason, record and marker types; `DoneEvent.stopReason`; `AgentStoredMessage.stopped`; `AgentClientConfig.stopTurn`; why an approval was withdrawn.
  - **agent-realtime:** a turn's stop is kept for its worker: the `agent:turn_stop` client event (taken only from the turn's token-guarded room, kept under the socket's user), `POST` and `GET /internal/turns/:turnId/stop`. An approval can be expired now with why (`settle` with `expire`), in one script with decide and redeem.
  - **agent-worker:** a turn watches for a stop for as long as it runs, fails open, and ignores a stop once it has begun its own end. A stopped turn settles what was in flight (every call keeps exactly one result), stores what it had produced from the worker's own record, then announces with `stopReason`. Every UI request names its turn. Host hooks: `getHistory` is told the turns this one supersedes; `persistMessages` is given `stopped` and may answer `{ stored: false }`; `recordTurnStart` may answer `{ run: false }`; `recordTurnComplete` is given `stopReason`. `TurnOutcome` gains `stopped` and `refused`.
  - **agent-react:** `stopTurn`, `isStopping` and `acceptedTurnId` on `useAgent`; a message sent while a turn runs makes the new turn the tab's at once; a stopped turn's message keeps what it had said, marked `stopped`.

### Patch Changes

- Updated dependencies
  - oui-spec@0.9.0
  - @ouispec/agent-events@0.5.0
  - @ouispec/agent-core@0.5.0

## 0.4.0

### Minor Changes

- The approval store can say that an approval expired without its call having run, and gives one turn at a time the claim to store that.

  - **A memory beside each approval** (`approval:{id}:seen`: the user, the conversation and the expiry time), kept 30 days past the approval's expiry. A decline or a redemption removes it in the same Lua script that declines or redeems, so an approval that was declined or used is never read as expired.
  - **An approval the user gave and nobody used** is told apart: approving rewrites the memory with `decided: "approved"` (same TTL, in the approving script), and `settle` returns it. Without this, an approved call whose turn died would be told as "expired before the user decided it".
  - **`POST /internal/approvals/:id/settle` `{ userId, conversationId }`**, always `200`:
    - `open`: pending, or approved and not yet used;
    - `claimed`: its keys have lapsed in Redis with the memory still there, so it expired without having run, and this caller holds the claim to store that;
    - `already`: another caller holds the claim, or it has been confirmed;
    - `unknown`: declined, used, another user's or conversation's, never asked for, or no longer remembered.
  - **The claim is a lease** of two minutes (`SET NX PX`), so of two turns asking together exactly one is `claimed`. With `confirm: true` the caller says it has stored the result, and the claim lasts as long as the memory. An unconfirmed claim lapses and can be claimed again; there is no release.
  - **A confirmation with no live claim** (the lease lapsed while the host was storing) is kept, and logged at warn: the expiry may have been stored twice.
  - **Expiry is Redis's clock.** Neither this server's clock nor the caller's is consulted.
  - **`ApprovalStore`** gains `settleExpired` and `confirmExpirySettled`; `createApprovalStore` takes an optional `expiryClaimLeaseMs`.
  - **Rollout:** the realtime server and the worker ship in either order. A worker from before this change never calls the route.
  - **Approvals created before this upgrade stay "waiting"** in their conversations: they have no memory, so the store answers `unknown` for them.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - oui-spec@0.8.0
  - @ouispec/agent-core@0.2.2
  - @ouispec/agent-events@0.2.2

## 0.2.0

### Minor Changes

- The assistant scales to a whole app, and reads what a page holds. This release breaks 0.1: read the list before upgrading.

  **The page sends an index of its actions (needs `oui-spec` 0.7).**
  - A client created with `createSurfaceRuntime({ form: 'index' })` sends one line per action. The worker fetches a definition from the page when an action is first used (`oui.describe`). A client that sends every definition keeps working.
  - The model is given three UI tools whatever the page offers: `ui_act` (run one action by its id), `ui_describe` (what actions take) and `ui_read` (part of the page's state). A large definition is described in outline and opened by path. **Breaking:** a UI action is no longer its own model tool, and a stored tool call of one is `ui_act` with `{ action, input }`. Quota, tool policy, approval, the turn record and the `agent:tool_call_*` events still name the action.
  - Nothing that changes the page runs while the page cannot be seen: after an answer that arrived without the page's state, only reads run, and two refused changes end the turn's UI work.
  - Size budgets, checked by `oui generate` and by the conformance kit (`within-budgets`): an index entry is at most 512 bytes, a definition 256 KB, and a surface's index 128 KB.
  - **Breaking exports in `@ouispec/agent-worker`:** `readClientSnapshot` is `readClientPage`; `buildUITools` takes the page and returns `describe` and `read`; a UI result names `page.nowOffers`, `page.actionsAdded` and `page.actionsRemoved` in place of `toolsAdded` and `toolsRemoved`.

  **The assistant reads what the page holds, and knows what a value means.**
  - A room's lists are readable: a row index in the page state, and generated `inspect` and `query` actions. A name is accepted where an id is.
  - An edit says what it changed (`changed`), and that row is kept whole in the page state it comes with.
  - Every number in a generated action says its unit and its space (`x-unit`, `x-space`), and the generator refuses one that does not.
  - The turn keeps a record of what ran and what it could not confirm.

  **Questions, approvals and pictures.**
  - **Breaking:** `present_options` requires `context`: what the person needs to know before choosing. The card shows it above the question.
  - An approved action is one call with one result.
  - A picture in an action's answer (`data.image = { mediaType, base64, width, height }`; PNG, JPEG or WebP, up to 256 KB of base64) is given to the model as an image, and its base64 is kept nowhere.
  - The Lambda and container adapters take `uiActions.maxIndexChars`.

  **Also.**
  - A model that takes no temperature is sent none (`temperature: null`).
  - The contract's JSON Schema subset gains `x-unit`, `x-space`, `x-ref` and `x-rows`, and a room catalog declares its rows.
  - The paint controls' schema takes freeform gradients and patterns.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-core@0.2.0
  - @ouispec/agent-events@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.7.0
  - @ouispec/agent-core@0.1.1
  - @ouispec/agent-events@0.1.1

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/agent-core@0.1.0
  - @ouispec/agent-events@0.1.0
