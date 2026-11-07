## In the tab: connecting the bindings

One OUI surface runtime per tab holds everything the assistant may do there. `connectBindings` keeps it equal to what the build's manifest declares and the page has mounted, and answers every action the assistant takes with its real result and what the page offers afterwards. There is no server-side registry of surfaces and no dispatch marker in tool results: the tab sends its snapshot with each message, and the agent runtime dispatches each UI tool call to the tab and waits for the answer.

```ts
import { createSurfaceRuntime } from 'oui-spec/core';
import { createBindingRegistry } from '@ouispec/bindings';
import { connectBindings } from '@ouispec/bindings/oui';
import manifest from './agent/generated/oui-manifest.json';

export const runtime = createSurfaceRuntime({ form: 'index', announce: false, accept: () => assistantTurnInProgress() });
export const registry = createBindingRegistry();

connectBindings({
  registry,
  runtime,
  manifest,
  jobs: jobTracker,               // below: how a job action settles
  navigation: appNavigation,      // { navigate, location, subscribe }: going to a page by its address
  onDefect: defect => log.error('OUI binding defect', defect),
});
```

Wrap the app in `<AgentBindingProvider registry={registry}>` (from `@ouispec/bindings/react`) so every bound control registers into it. Send `runtime.snapshot()` as the message context with every turn, pass `runtime.grantApproval` to the agent client as `grantApproval` (see approvals), and `{ subscribe: (listener) => runtime.onSettled(listener) }` as `settledWork` (see resuming after work, below).

- `form: 'index'` sends the page's actions as an index and not as definitions (below). It needs an agent worker that reads the index (`agent-sdk-worker` 9 or later). Leave it out for an older worker.
- `accept` refuses any action request that arrives while the assistant has no turn in progress in this tab.
- A disabled control is not offered, except while a job it started is still running, or for a moment after its own press disabled it (it is reported busy, not gone).
- A control the build does not declare, or a live schema wider than the declared one, is reported through `onDefect`; the conformance kit keeps both from shipping.

### What travels, and what does not

A page's action definitions weigh what its whole catalogue weighs. On a studio page that is several hundred kilobytes: more than one socket frame carries, and far more than a model should read on every call. So definitions do not travel unless they are asked for:

- **The snapshot and every answer carry an index of the page's actions.** Each entry has the action's id, title, the first sentence of its description, its effect, and one line saying what it takes ("none", "value: number 0–100 px", "one of 60 shapes by effect"). The line is derived from the action's input schema by rule.
- **The assistant fetches a definition when it needs one.** The surface runtime answers `oui.describe` itself, with the action's live definition, including options the page loaded at run time.
- **The assistant has four UI tools, whatever the page offers:**
  - `ui_act` runs one action by its id.
  - `ui_describe` says what actions take. A large input comes back as an outline, and one part of it is opened by path.
  - `ui_read` reads part of the page's state.
  - `ui_wait` waits for work an action started (a job, an export) that was still running when the action's call answered. A call waits for its work's outcome only briefly (20 s by default, `jobWaitMs`), so a turn is never held by a job queued for minutes. Work still going then is reported running, never done. When the rest of the request needs the outcome (to check what was made, or to act on it), the assistant calls `ui_wait`: it waits until the work ends, its own `timeoutMs` passes, or the turn must answer, whichever is first, and answers as the action's call would have, with the outcome and the page after it. A stop ends the wait; the time spent in it does not count as a step's length when the turn decides whether to hand back. Work that ends after the turn is reported by a resumed turn (below).

  When the client sends knowledge, a fifth: `ui_guide` reads what the prompt leaves out of it. The knowledge is bounded in the prompt (12,000 characters): small entries whole, a large one cut at a line with how much is left, and workflows by name; `ui_guide` reads the rest of an entry a page at a time, or one workflow with its steps.
- **The page's index is in the page state the model reads,** with its own budget, so the assistant's context stays about the same size however many actions the app has.
- **Only the newest answer carries the page's state to the model.** Every earlier answer of the turn keeps what its action did (its result, the rows it changed, what the page offers since) and says where the state is, so a turn of many actions costs about what one does, plus what each did.
- **UI actions are not counted against a per-tool quota:** they run as the person, bounded by the turn's steps and deadline. What is refused is a loop: the same call with the same input, once it has changed nothing three times in a row. Undo five times is five undos.
- **Every answer is fitted to a byte budget before it is sent** (480 KB by default, 256 KB for a snapshot). The action's own result is kept whole. Long lists in the page's state are cut first, and the answer says where, so the assistant can read the rest with `ui_read` or a room's `query`.
- **What a page shows keeps an index too.** A page reports its displays' facts under `shown` in its state, and a display that describes one row of a list (a card each) carries the row as `item`. The page state declares `x-rows` on `shown` (`ref: item.key`, `title: item.title`, `index: [id]`), and the bindings report each display's rows together. The manifest records each display a page or shell shows (`displays`: its binding id, title, description and the labels the build can read), so a test can name it as the build does. A page reports what it shows while its surface is mounted: while one of its controls is, or, with none mounted (a page of figures, a Home whose cards gave way to a conversation), while a display its manifest entry records reports its facts; where several pages record that display, the page at the address. Over budget, the page's own facts stay whole, and a long list of cards keeps its first rows whole and the rest as index rows (the display, the row's key and title), the rows an action just changed whole. When even the index does not fit, the list says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time.
- **The assistant never changes a page it cannot see.** After an answer that arrived without the page's state, or no answer, the worker runs only reads until one succeeds. After two refused changes in a row, the assistant stops and tells the person what it could not confirm.

Nothing here is written per feature: the index, the outlines and the fitting are computed from the declarations.

### Resuming after work that outlived its turn

When work the assistant started (a job, an export) finishes after the turn that started it has ended, the assistant comes back by itself and reports the outcome in the same chat, as long as the person's window is open. Nobody writes anything; the tab starts the turn.

1. **The tab's runtime says the work ended.** `runtime.onSettled(listener)` is called once for each request that was first answered `interim: true`, when its final answer (done, failed, timed out, or abandoned because its surface left the page) has been sent and the realtime server has acknowledged it, so the outcome is in the server's result store (kept 35 minutes). The event names the request, the turn that sent it, the surface and action, and whether the work succeeded (`OUISettledWork`).
2. **The agent provider decides** (`config.settledWork`, agent-react). It resumes only for a turn of the open conversation that this tab ran and that has ended by itself: answered, handed back for time, failed, or out of time. It never resumes for a turn the person stopped (a stop means stop), one their newer message superseded (the newer turn read the page), one a person on the staff took over, or one that ended waiting for an approval. It does not resume while a turn runs or starts (that turn's page state, or its `ui_wait`, carries the outcome), while a conversation loads, while an approval card or a choice waits on the person, or while a person on the staff holds the conversation. Switching conversations or starting a new one forgets the turns before. Work that ends within 1.5 s of the last goes in one turn (`RESUME_GATHER_MS`, up to 8 requests), and at most 3 turns are started this way in a row before the person writes again (`RESUME_MAX_IN_A_ROW`): a resumed turn may start more work, bounded. Every decision is in the provider's debug log.
3. **The turn goes through `sendMessage`**, like the turn after an approval: `content` is empty, no message of the person's is shown, the context is what a message carries (so the host attaches the fresh snapshot), and `resume: { requestIds }` (`ResumeContinuation`) names the requests. The platform passes it unchanged to the worker as the turn payload's `resume`, and stores no user message for the empty content. A payload with `resume` takes 1 to 8 non-empty request ids of at most 200 characters, and never also `approval` (`resumeRefusal`).
4. **The worker reports it.** A request is taken only when this conversation's history holds the tool call with its id (a UI action's request id is its call's id) and that call's latest result still says it is running; any other is left out and logged, so a client never reads another conversation's results, and an outcome is never reported twice. Each one's final answer is read from the realtime server and becomes that call's result, in the words `ui_wait` gives once work ends, in place of "still running": the model reads one call with one result, and the result is stored under the call's own id, so every later turn reads the outcome. In place of a message the model is told that nobody wrote anything, that the turn started because work it started in an earlier turn finished after that turn ended (each named by its declared title), that the outcome is now the call's result, and to tell the person briefly what came of it, checking the page before claiming anything, and to go on with their earlier request if it needed this outcome. A final answer that can no longer be read is said so, with the advice to check the page, and nothing is stored for it. When nothing is left to report, the turn ends at once without calling the model. The turn is marked `resumed` in the worker's logs, its usage line, its result and `recordTurnComplete`.

Without `settledWork`, or with the window closed, the outcome reaches the assistant in the page state of the person's next message.
