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

Wrap the app in `<AgentBindingProvider registry={registry}>` (from `@ouispec/bindings/react`) so every bound control registers into it. Send `runtime.snapshot()` as the message context with every turn, and pass `runtime.grantApproval` to the agent client as `grantApproval` (see approvals).

- `form: 'index'` sends the page's actions as an index and not as definitions (below). It needs an agent worker that reads the index (`agent-sdk-worker` 9 or later). Leave it out for an older worker.
- `accept` refuses any action request that arrives while the assistant has no turn in progress in this tab.
- A disabled control is not offered, except while a job it started is still running, or for a moment after its own press disabled it (it is reported busy, not gone).
- A control the build does not declare, or a live schema wider than the declared one, is reported through `onDefect`; the conformance kit keeps both from shipping.

### What travels, and what does not

A page's action definitions weigh what its whole catalogue weighs. On a studio page that is several hundred kilobytes: more than one socket frame carries, and far more than a model should read on every call. So definitions do not travel unless they are asked for:

- **The snapshot and every answer carry an index of the page's actions.** Each entry has the action's id, title, the first sentence of its description, its effect, and one line saying what it takes ("none", "value: number 0–100 px", "one of 60 shapes by effect"). The line is derived from the action's input schema by rule.
- **The assistant fetches a definition when it needs one.** The surface runtime answers `oui.describe` itself, with the action's live definition, including options the page loaded at run time.
- **The assistant has three UI tools, whatever the page offers:**
  - `ui_act` runs one action by its id.
  - `ui_describe` says what actions take. A large input comes back as an outline, and one part of it is opened by path.
  - `ui_read` reads part of the page's state.

  When the client sends knowledge, a fourth: `ui_guide` reads what the prompt leaves out of it. The knowledge is bounded in the prompt (12,000 characters): small entries whole, a large one cut at a line with how much is left, and workflows by name; `ui_guide` reads the rest of an entry a page at a time, or one workflow with its steps.
- **The page's index is in the page state the model reads,** with its own budget, so the assistant's context stays about the same size however many actions the app has.
- **Only the newest answer carries the page's state to the model.** Every earlier answer of the turn keeps what its action did (its result, the rows it changed, what the page offers since) and says where the state is, so a turn of many actions costs about what one does, plus what each did.
- **UI actions are not counted against a per-tool quota:** they run as the person, bounded by the turn's steps and deadline. The same call with the same input a fourth time in a turn is refused, as a loop.
- **Every answer is fitted to a byte budget before it is sent** (480 KB by default, 256 KB for a snapshot). The action's own result is kept whole. Long lists in the page's state are cut first, and the answer says where, so the assistant can read the rest with `ui_read` or a room's `query`.
- **The assistant never changes a page it cannot see.** After an answer that arrived without the page's state, or no answer, the worker runs only reads until one succeeds. After two refused changes in a row, the assistant stops and tells the person what it could not confirm.

Nothing here is written per feature: the index, the outlines and the fitting are computed from the declarations.
