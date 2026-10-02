## In the tab: connecting the bindings

One OUI surface runtime per tab holds everything the assistant may do there. `connectBindings` keeps it equal to what the build's manifest declares and the page has mounted, and answers every action the assistant takes with its real result and what the page offers afterwards. There is no server-side registry of surfaces and no dispatch marker in tool results: the tab sends its snapshot with each message, and the agent runtime dispatches each UI tool call to the tab and waits for the answer.

```ts
import { createSurfaceRuntime } from 'oui-spec/core';
import { createBindingRegistry } from '@ouispec/bindings';
import { connectBindings } from '@ouispec/bindings/oui';
import manifest from './agent/generated/oui-manifest.json';

export const runtime = createSurfaceRuntime({ announce: false, accept: () => assistantTurnInProgress() });
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

- `accept` refuses any action request that arrives while the assistant has no turn in progress in this tab.
- A disabled control is not offered, except while a job it started is still running, or for a moment after its own press disabled it (it is reported busy, not gone).
- A control the build does not declare, or a live schema wider than the declared one, is reported through `onDefect`; the conformance kit keeps both from shipping.
