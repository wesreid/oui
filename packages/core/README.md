# @oui/core

**The integration layer. Define surfaces, execute actions, manage polling.**

`@oui/core` provides `defineSurface()` — the single entry point for declaring an OUI surface with both its schema (what the agent sees) and its implementation (what executes). One definition, no drift between contract and behavior.

---

## Install

```bash
pnpm add @oui/core
```

Peer dependency: `@oui/spec` (installed automatically via workspace protocol).

---

## `defineSurface()`

The core function. Takes a surface definition (schema + handlers) and returns a `DefinedSurface` with manifest extraction, action execution, and polling utilities.

```typescript
import { defineSurface } from '@oui/core';

const mySurface = defineSurface({
  id: 'my-feature',
  name: 'My Feature',
  description: 'What the agent needs to know about this feature',
  actions: [/* ActionDefinition[] */],
  observations: [/* ObservationDefinition[] */],
  activation: { routes: ['/app/my-feature'] },
});

// Extract manifest (schema only, no handlers) for transmission to agent runtime
const manifest = mySurface.toManifest();

// Execute an action by ID
const result = await mySurface.executeAction('do_thing', { name: 'test' }, context);

// Get polling config for an async action
const polling = mySurface.getPollingConfig('render_chart');
```

---

## ActionDefinition

The central type. Declares both the action's schema (what the agent sees as a tool) and its handler (what runs when invoked).

```typescript
import type { ActionDefinition } from '@oui/core';

interface MyContext {
  api: ApiClient;
  state: AppState;
  updateState: (patch: Partial<AppState>) => void;
}

const selectDataset: ActionDefinition<MyContext> = {
  id: 'select_dataset',
  description: 'Select a dataset to visualize',
  input: {
    type: 'object',
    properties: {
      datasetId: { type: 'string', description: 'Dataset ID' },
    },
    required: ['datasetId'],
  },
  output: {
    type: 'object',
    properties: {
      columns: { type: 'array', items: { type: 'string' } },
      rowCount: { type: 'number' },
    },
  },
  usage: 'Call this first before configuring a chart',
  preconditions: 'At least one dataset must exist in the project',
  estimatedDuration: 'instant',
  tags: ['setup'],

  handler: async (params, ctx) => {
    const dataset = await ctx.api.loadDataset(params.datasetId as string);
    ctx.updateState({ selectedDataset: dataset });
    return {
      success: true,
      data: { columns: dataset.columns, rowCount: dataset.rowCount },
    };
  },
};
```

### Handler Return Type: `ActionHandlerResult`

```typescript
interface ActionHandlerResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  /** For async actions: metadata passed to the polling resolver */
  dispatchMeta?: Record<string, unknown>;
}
```

- Return `{ success: true, data }` for successful operations
- Return `{ success: false, error }` for failures
- For async actions, `data` (or `dispatchMeta`) is passed to the polling `resolve` function

---

## Polling Configuration

For actions that kick off long-running work, declare a polling config. The OUI runtime (in `@oui/react` or your own implementation) manages the polling lifecycle after the handler returns.

```typescript
import type { ActionDefinition, ActionPollingConfig } from '@oui/core';

const renderChart: ActionDefinition<MyContext> = {
  id: 'render_chart',
  description: 'Render the configured chart',
  async: true,
  estimatedDuration: '10-30s',
  input: {
    type: 'object',
    properties: {
      quality: { type: 'string', enum: ['draft', 'production'] },
    },
  },

  polling: {
    intervalMs: 2000,
    maxDurationMs: 60000,

    // Called every 2s with the handler's return data + current context
    resolve: async (dispatchResult, ctx) => {
      const { jobId } = dispatchResult as { jobId: string };
      const status = await ctx.api.getRenderStatus(jobId);

      if (status.state === 'complete') {
        return { done: true, data: { status: 'complete', imageUrl: status.imageUrl } };
      }
      if (status.state === 'failed') {
        return { done: true, data: { status: 'failed', error: status.error } };
      }
      return { done: false, data: { status: 'rendering', progress: status.progress } };
    },
  },

  handler: async (params, ctx) => {
    const job = await ctx.api.startRender({
      config: ctx.state.chartConfig,
      quality: params.quality ?? 'draft',
    });
    // Return immediately — polling takes over from here
    return { success: true, data: { jobId: job.id } };
  },
};
```

### Polling Lifecycle

1. Handler executes and returns `{ success: true, data: { jobId } }`
2. Runtime starts calling `resolve(data, context)` every `intervalMs` milliseconds
3. Each call pushes an observation update with `{ interim: true }` or `{ interim: false }`
4. When `resolve` returns `{ done: true }`, the interval is cleared and a final observation is pushed
5. If `maxAttempts` or `maxDurationMs` is exceeded, polling stops with a timeout observation

### Subscribe Mode

For realtime infrastructure, use `subscribe` instead of `resolve`:

```typescript
polling: {
  intervalMs: 0,
  subscribe: {
    event: 'job:complete',
    filter: { jobId: '$dispatchResult.jobId' },
  },
},
```

The transport layer resolves `$dispatchResult.*` references from the handler's return value and listens for the named event.

---

## ObservationDefinition

Declares a piece of observable state. The optional `getValue` function enables pull-based observation reading.

```typescript
import type { ObservationDefinition } from '@oui/core';

const wizardState: ObservationDefinition = {
  id: 'wizard_state',
  description: 'Current wizard step and configuration',
  schema: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: ['select', 'configure', 'preview', 'export'] },
      selectedDatasetId: { type: 'string' },
      chartType: { type: 'string' },
    },
  },
  getValue: () => store.getState().wizard, // optional pull accessor
};
```

---

## Context Pattern

The `TContext` generic lets you pass application state and utilities to action handlers without globals:

```typescript
interface DataVizContext {
  api: DataVizApiClient;
  state: WizardState;
  updateState: (patch: Partial<WizardState>) => void;
  goToStep: (step: string) => void;
}

const surface = defineSurface<DataVizContext>({
  id: 'dataviz-wizard',
  // ...
  actions: [
    {
      id: 'go_to_step',
      description: 'Navigate to a specific wizard step',
      input: { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] },
      handler: async (params, ctx) => {
        ctx.goToStep(params.step as string);
        return { success: true };
      },
    },
  ],
});
```

In React, the context comes from component state/hooks and is passed to `useSurface()`.

---

## Manifest Extraction

`toManifest()` strips handlers and returns a pure `OUISurface` object suitable for transmission to the agent runtime:

```typescript
const surface = defineSurface({ /* ... */ });

// This is what gets sent over the wire to the agent
const manifest = surface.toManifest();
// manifest: OUISurface (from @oui/spec) — no handler functions, no resolve functions
```

The manifest includes `polling` config (intervals, limits, subscribe events) but NOT the `resolve` function — that stays client-side.

---

## Validation

`defineSurface()` validates at construction time:

- No duplicate action IDs within a surface
- No duplicate observation IDs within a surface

If validation fails, it throws immediately with a descriptive error:

```
[OUI] Duplicate action ID "render_chart" in surface "dataviz-wizard"
```

---

## Exports

```typescript
// Core function
export { defineSurface } from '@oui/core';

// Types
export type {
  SurfaceDefinition,
  ActionDefinition,
  ActionPollingConfig,
  ActionHandlerResult,
  ObservationDefinition,
  DefinedSurface,
} from '@oui/core';

// Re-exported from @oui/spec for convenience
export type {
  OUISurface, OUIAction, OUIObservation, OUIActivation,
  OUIActionRequest, OUIActionResult, OUIObservationUpdate,
  OUIProtocolEvent, JSONSchema,
} from '@oui/core';

export { OUI_PROTOCOL_EVENTS } from '@oui/core';
```

---

## License

MIT
