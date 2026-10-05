# oui-spec

## 0.10.0

### Minor Changes

- Work that failed ends its action as a failure. A polling `resolve` may now return `{ done: true, data, error: { code, message } }`. The runtime then sends the final result with `success: false` and that error, and keeps `data`. The spec says so in §7.3.3: an async action whose work failed sends its final result as a failure.

  `@ouispec/bindings` ends a job whose declared failure arrived this way, with error `JOB_FAILED` and the declared reason as its message, and keeps the outcome as data. Before, a failed job answered `success: true` with `data.status: 'failed'`. The assistant's record of the call then said it succeeded, and so did the stored chat.

## 0.9.0

### Minor Changes

- A running turn can be stopped, and a message sent while a turn runs supersedes it (Closure ADR-0252, phase 1).

  - **oui-spec:** an action request may name its turn (`turnId`, carried by the socket transport), and `acceptCurrentTurn` is the `accept` rule for a client that runs one turn at a time: a request a stopped or superseded turn sends late is refused, and one that names no turn (an older worker) is accepted while a turn is in progress, as before.
  - **agent-events:** `agent:turn_complete` declares `stopReason` (`user_stop`, `superseded`); the UI dispatch declares `turnId`.
  - **agent-core:** the turn-stop event, reason, record and marker types; `DoneEvent.stopReason`; `AgentStoredMessage.stopped`; `AgentClientConfig.stopTurn`; why an approval was withdrawn.
  - **agent-realtime:** a turn's stop is kept for its worker: the `agent:turn_stop` client event (taken only from the turn's token-guarded room, kept under the socket's user), `POST` and `GET /internal/turns/:turnId/stop`. An approval can be expired now with why (`settle` with `expire`), in one script with decide and redeem.
  - **agent-worker:** a turn watches for a stop for as long as it runs, fails open, and ignores a stop once it has begun its own end. A stopped turn settles what was in flight (every call keeps exactly one result), stores what it had produced from the worker's own record, then announces with `stopReason`. Every UI request names its turn. Host hooks: `getHistory` is told the turns this one supersedes; `persistMessages` is given `stopped` and may answer `{ stored: false }`; `recordTurnStart` may answer `{ run: false }`; `recordTurnComplete` is given `stopReason`. `TurnOutcome` gains `stopped` and `refused`.
  - **agent-react:** `stopTurn`, `isStopping` and `acceptedTurnId` on `useAgent`; a message sent while a turn runs makes the new turn the tab's at once; a stopped turn's message keeps what it had said, marked `stopped`.

## 0.8.0

### Minor Changes

- An index entry is smaller: its `definitionHash` is 32 bits (8 hex digits) and it no longer carries `definitionBytes`.

  **`oui-spec` 0.8 (breaking for a reader of the entry type).** `OUIActionIndexEntry.definitionBytes` is removed: nothing read it but size budgets, which measure the definition themselves. `definitionHash` is the first 32 bits of the definition's 64-bit FNV-1a (`DEFINITION_HASH_HEX`): it is only compared with the same action's earlier hash, so a change goes unseen once in 2^32. `surfacesHash`, which is compared across a whole page, stays 64 bits. On a page of 447 actions this takes about 13 KB off the index.

  **Rolling it out: the agent runtime first, then the page.** A hash is opaque to a runtime, which MUST accept one of any length and ignore a `definitionBytes` it is sent (§7.3.8). So move the worker to this release first; a tab still on 0.7 then keeps working with it, and the tab follows. A 0.7 worker given a 0.8 tab's index also works (it compares the hash as a string and never read `definitionBytes`), but only this order is tested.

  **`@ouispec/agent-worker`.** Tested against an index from a 0.7 tab. The `Turn usage` log line carries `ui.indexChars` and `ui.maxIndexChars`: the size of the page's index as the model reads it, and the most it is given before the furthest surfaces are listed by id only.

## 0.7.2

### Patch Changes

- An index entry's description no longer repeats the action's title.

  Descriptions are commonly written to stand alone (`Add artboard: Adds an artboard…`; for a control, `Press "Save": Saves the project`), and an entry carries the title beside the description, so an index named every title twice. `indexEntry` now leaves out an opening of the title and ": ", or of a short lead-in, the quoted title and ": " (`withoutTitleLeadIn`). On a page of 447 actions the index went from 132.8 KB to 124.9 KB, and each line the model reads is shorter by its title.

  An action's definition is unchanged, and so is its `definitionHash`: only the entry's `description` differs. A client and a runtime on different patch versions agree on every hash.

## 0.7.1

### Patch Changes

- A result's observations are the page after the action, for a slow action too.

  - **What was wrong:** the runtime answers once the page has been quiet for `quietMs`, and it measured that from when the request arrived. A handler that awaits its own work first (a save, a restore over the network) returns later than that, so the page had already "been quiet" and the answer was taken at once, before the UI rendered what the handler had just changed. The result said the restore worked; the observations beside it showed the page before it.
  - **Now:** quiet, and the settle timeout, are measured from when the handler returned.
  - **Tests:** a handler that waits four quiet windows and then changes an observation is answered with the changed observation; a handler slower than the settle timeout still gets the whole timeout afterwards.

## 0.7.0

### Minor Changes

- The index form, definitions on demand, and frames that always fit (spec §7.3.8–§7.3.10).

  - **A client can send an index of its actions, not their definitions.**
    - With `createSurfaceRuntime({ form: "index" })`, `runtime.snapshot()` and every result carry `index` (`OUISurfaceIndex[]`) in place of `surfaces`.
    - Each action is `{ id, title, description, effect, confirm, async, input, definitionHash, definitionBytes }`, where `input` is a one-line summary (`summarizeInput`).
    - On a page whose definitions weigh over 200 KB, the index is under 128 KB.
    - The default stays `"full"` until 1.0, so a client upgrades without its agent runtime changing.
  - **`oui.describe` and `oui.read`.** The surface id `oui` is the runtime's own.
    - `describe` returns the live definitions of the actions asked for.
    - `read` returns part of an observation's value by JSON Pointer, a page of a list at a time.
    - Both work in either form.
  - **Frames are fitted before they are sent.**
    - A result is held to 480 KB and a snapshot to 256 KB (`budgets`).
    - Long lists are cut first, then long texts, then whole values.
    - `fit` reports each cut so the rest can be read.
  - **A refused result is trimmed a step at a time:** what the page offers, then the observations, then the data. It used to lose the definitions and the observations together, which left an agent unable to see the page.

  **Changes in behaviour:**

  - A surface can no longer be defined with the id `oui`.
  - A refused result is trimmed in three steps, not two: `delivery.omitted` is first `["surfaces"]` (or `["index"]`).
  - Observations over a frame's budget arrive shortened, with `fit` saying where.

## 0.6.1

### Patch Changes

- Published from the OUI monorepo (`packages/oui-spec`) by its release workflow, with provenance: the package's `repository.directory`, homepage and changelog now point at that directory. No change to the code or the protocol.

## 0.6.0 and earlier

Released from the repository root before the monorepo. Each release's changes are in its GitHub release: [v0.6.0](https://github.com/wesreid/oui/releases/tag/v0.6.0), [v0.5.0](https://github.com/wesreid/oui/releases/tag/v0.5.0), [v0.4.1](https://github.com/wesreid/oui/releases/tag/v0.4.1), [v0.4.0](https://github.com/wesreid/oui/releases/tag/v0.4.0), [v0.3.0](https://github.com/wesreid/oui/releases/tag/v0.3.0).
