# @oui/spec

**The schema layer for the OUI protocol. Zero runtime dependencies.**

This package defines the TypeScript types and JSON Schema interfaces that form the formal contract between OUI surfaces and agent runtimes. It is the single source of truth for what a surface _is_, what an action _looks like_, and how protocol events are structured.

---

## Install

```bash
pnpm add @oui/spec
```

---

## What's in the Box

Pure TypeScript type definitions. No runtime code. No dependencies. This package emits `.d.ts` files and trivial re-exports — it exists solely to provide the shared type contract that all other `@oui/*` packages depend on.

---

## Key Types

### `OUISurface`

The top-level surface declaration. Describes a controllable boundary within an application.

```typescript
import type { OUISurface } from '@oui/spec';

const manifest: OUISurface = {
  id: 'dataviz-wizard',
  name: 'Data Visualization Wizard',
  description: 'AI-controllable data visualization builder',
  version: '1.0.0',
  actions: [/* ... */],
  observations: [/* ... */],
  activation: { routes: ['/studio/dataviz'] },
};
```

### `OUIAction`

A single operation the agent can invoke. Becomes a "tool" in the LLM's tool list.

```typescript
import type { OUIAction } from '@oui/spec';

const action: OUIAction = {
  id: 'render_chart',
  description: 'Render the configured chart server-side',
  input: {
    type: 'object',
    properties: {
      quality: { type: 'string', enum: ['draft', 'production'] },
    },
  },
  output: {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
  },
  async: true,
  estimatedDuration: '5-20s',
  polling: {
    intervalMs: 2000,
    maxDurationMs: 60000,
  },
};
```

### `OUIObservation`

A piece of application state the agent can read. Pushed in real-time as the app changes.

```typescript
import type { OUIObservation } from '@oui/spec';

const observation: OUIObservation = {
  id: 'wizard_state',
  description: 'Current wizard step and configuration',
  schema: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: ['select', 'configure', 'preview', 'export'] },
      selectedDatasetId: { type: 'string' },
    },
  },
  updateFrequency: 'on-change',
};
```

### `OUIActionPolling`

Declarative polling configuration for async actions. The OUI runtime manages the polling lifecycle automatically after the action handler returns.

```typescript
import type { OUIActionPolling } from '@oui/spec';

const polling: OUIActionPolling = {
  intervalMs: 2000,
  maxAttempts: 30,
  // OR: subscribe to a realtime event instead of polling
  subscribe: {
    event: 'job:complete',
    filter: { jobId: '$dispatchResult.jobId' },
  },
};
```

### `OUIActivation`

When a surface is available — route-based, entity-based, or custom conditions.

```typescript
import type { OUIActivation } from '@oui/spec';

const activation: OUIActivation = {
  routes: ['/studio/dataviz', '/studio/dataviz/*'],
  entity: { type: 'project' },
  condition: 'User has at least one dataset uploaded',
};
```

### Protocol Types

Wire protocol types for transport implementations:

| Type | Purpose |
|------|---------|
| `OUIActionRequest` | Action dispatch from agent → surface |
| `OUIActionResult` | Execution result (used internally by observation pushes) |
| `OUIObservationUpdate` | State push from surface → agent |
| `OUISurfaceRegistration` | Surface becoming active |
| `OUISurfaceDeregistration` | Surface becoming inactive |
| `OUIProtocolEvent` | Discriminated union of all protocol events |

### `JSONSchema`

A subset of JSON Schema used for action inputs/outputs and observation schemas. Supports the constructs needed for tool parameter descriptions without pulling in a full JSON Schema library.

---

## Protocol Event Constants

```typescript
import { OUI_PROTOCOL_EVENTS } from '@oui/spec';

// OUI_PROTOCOL_EVENTS.SURFACE_REGISTER    → 'surface:register'
// OUI_PROTOCOL_EVENTS.SURFACE_DEREGISTER  → 'surface:deregister'
// OUI_PROTOCOL_EVENTS.ACTION_REQUEST      → 'action:request'
// OUI_PROTOCOL_EVENTS.ACTION_RESULT       → 'action:result'
// OUI_PROTOCOL_EVENTS.OBSERVATION_UPDATE  → 'observation:update'
```

---

## Design Decisions

- **No runtime code.** This package is pure types + one `const` object. It can be imported anywhere without adding bundle weight.
- **JSON Schema subset.** We support the JSON Schema constructs that are useful for describing tool parameters — not the entire spec. This keeps the type definitions readable and focused.
- **Protocol events are a discriminated union.** `OUIProtocolEvent` uses a `type` discriminant so transport layers can route events with a single switch statement.
- **Polling is declarative.** `OUIActionPolling` describes _what_ to poll and _when to stop_, not _how_ to poll. The runtime (`@oui/core` / `@oui/react`) implements the actual polling loop.

---

## License

MIT
