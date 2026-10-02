# OUI - The OpenUI Specification

**The machine-readable contract for agent-controllable user interfaces.**

> _"Oui"_ — French for "yes." As in: yes, an AI agent can control this UI.

<!-- Badges -->

[![npm](https://img.shields.io/npm/v/oui-spec)](https://www.npmjs.com/package/oui-spec)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![CI](https://github.com/wesreid/oui/actions/workflows/ci.yml/badge.svg)](https://github.com/wesreid/oui/actions/workflows/ci.yml)

---

## The Problem

AI agents that control UIs today rely on fragile, expensive hacks:

- **Computer vision** — screenshot the screen, feed it to a vision model, infer what's clickable, guess coordinates, click, screenshot again to see if it worked. Slow, expensive, unreliable.
- **DOM scraping** — find elements by CSS selector, simulate clicks and keystrokes. Breaks on every layout change. Requires intimate knowledge of the app's internal structure.
- **MCP tool servers** — powerful for backend operations, but have no concept of _UI state_. The agent can call APIs but can't observe what the user is seeing or coordinate with the frontend.

All of these share a fundamental flaw: **the agent is guessing what the application can do by examining its implementation details.** It's like reading a restaurant menu by peering into the kitchen.

## The Solution

OUI inverts the model. **The application declares a typed semantic surface** — what it can do, what state is observable, and what parameters each operation accepts. The agent reads this manifest and operates through typed function calls. No pixels. No DOM. No guessing.

```
OpenAPI  + HTTP Server  = any client can consume the API
OUI     + UI App        = any agent can control the UI
```

```mermaid
flowchart TD
    Agent[Agent Runtime / LLM]
    Manifest[OUI Manifest]
    Runtime[Client Surface Runtime]
    Surface[UI Surface]
    App[Application State]

    Agent -->|reads| Manifest
    Agent -->|action request + requestId| Runtime
    Runtime -->|runs handler| Surface
    Surface -->|changes| App
    App -->|UI settles| Runtime
    Runtime -->|action result + surfaces after it| Agent
```

### Every Action Is Answered

Every action request carries a `requestId`, and the client answers it exactly
once with an `OUIActionResult` (spec §7.3):

| Event                | Direction        | Carries                                                                                                                                     |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ns}:dispatch`      | runtime → client | `OUIActionRequest` — `requestId`, `surfaceId`, `actionId`, `params`                                                                         |
| `{ns}:action:result` | client → runtime | `OUIActionResult` — success or error, the client's observations once the UI settled, its surfaces' hash, and its surfaces when they changed |
| `{ns}:observation`   | client → runtime | state updates as they happen                                                                                                                |

The result includes what the client can do **after** the action. An action can
change that: navigating unmounts one page's surfaces and mounts another's. An
agent that only knew the capability set from before the action would be acting
on the page it just left.

Surfaces are heavy (every action's schema), so a result repeats them only when
the agent runtime does not hold them: the runtime sends the `surfacesHash` it
holds as the request's `knownSurfaces`, and the result carries `surfaces` only
when the client's hash differs. A result the receiver refuses (too large,
invalid) is acknowledged as refused, and the client sends it again trimmed,
with `delivery` saying what was left out and why: the agent always learns the
action's outcome. A request is acknowledged on receipt when the sender asks,
and a repeat of a request whose answer is on its way gets no second copy.

An async action (`async: true`) is acknowledged at once with `interim: true`,
and answered a second time, under the same `requestId`, when its polling
finishes. Progress in between is published as observations.

An earlier version of this package had no result channel: dispatch was
fire-and-forget and results were expected to arrive as observations. An agent
could not tell whether an action ran, and its integrator reported success
before the browser had done anything. The spec always required a result; the
package now implements it.

---

## Quick Start

The simplest possible OUI surface — a counter the agent can increment:

```typescript
// counter.surface.ts
import { defineSurface } from "oui-spec/core";

export const counterSurface = defineSurface({
  id: "counter",
  name: "Counter",
  description: "A simple counter that can be incremented or reset",
  actions: [
    {
      id: "increment",
      description: "Increment the counter by a given amount",
      input: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount to add (default 1)" },
        },
      },
      handler: async (params, ctx) => {
        const amount = (params.amount as number) ?? 1;
        ctx.setCount(ctx.count + amount);
        return { success: true, data: { newValue: ctx.count + amount } };
      },
    },
    {
      id: "reset",
      description: "Reset the counter to zero",
      input: { type: "object", properties: {} },
      handler: async (_params, ctx) => {
        ctx.setCount(0);
        return { success: true, data: { newValue: 0 } };
      },
    },
  ],
  observations: [
    {
      id: "current_value",
      description: "The current counter value",
      schema: { type: "object", properties: { value: { type: "number" } } },
    },
  ],
});
```

Then create **one surface runtime per client** and provide it at the root. The
runtime keeps the client's own record of what is mounted, answers every request
that arrives on the socket, and produces the snapshot an agent works from:

```tsx
// App.tsx
import { createSurfaceRuntime } from "oui-spec/core";
import { SurfaceRuntimeProvider } from "oui-spec/react";

const runtime = createSurfaceRuntime({ socket }); // your connection, your auth

export function App() {
  return (
    <SurfaceRuntimeProvider runtime={runtime}>
      <CounterPage />
    </SurfaceRuntimeProvider>
  );
}
```

```tsx
// CounterPage.tsx
import { useSurface, useObservation } from "oui-spec/react";
import { counterSurface } from "./counter.surface";

function CounterPage() {
  const [count, setCount] = useState(0);

  // Mounted while the page is. The runtime answers requests for it.
  const surface = useSurface({
    surface: counterSurface,
    context: { count, setCount },
  });

  useObservation(surface, "current_value", { value: count });

  return <div>Count: {count}</div>;
}
```

`runtime.snapshot()` returns `{ surfaces, observations, surfacesHash }` for
everything mounted. An agent runtime that keeps no registry of its own can take it with
each request (for example, with each chat turn); set `announce: false` and the
runtime sends nothing but results over the socket.

That's it. The agent now sees a `counter` surface with two tools (`increment`, `reset`) and one live observation (`current_value`).

---

## The Integration Contract

OUI owns the protocol. You own the connection and the content. That split is
enforced by the type system, not by documentation.

### What OUI owns — and you cannot reimplement

|                    | Owned by OUI                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Socket event names | `{ns}:dispatch`, `{ns}:action:result`, `{ns}:observation`, `{ns}:surface:register`, `{ns}:surface:deregister`       |
| Namespace prefix   | `transport.namespace`, default `'oui'`                                                                              |
| Payload shapes     | `OUIActionRequest`, `OUIActionResult`, `OUIObservationUpdate`, `OUISurfaceRegistration`, `OUISurfaceDeregistration` |
| Result routing     | One `{ns}:action:result` per request, correlated by `requestId`                                                     |

`OUIInstance.transport` is a branded `OwnedTransport`. Only `createOUI`
produces one, so a transport you construct by hand cannot be substituted for
it. This is deliberate: an early integrator satisfied every type in this
package without calling any of its runtime, rebuilt the wire by hand and
hardcoded the namespace. Both ends then agreed only by the coincidence of
matching string literals.

### What you own

|                     | Owned by the integrator                      |
| ------------------- | -------------------------------------------- |
| Connection          | The `socket` — auth, reconnection, lifecycle |
| Surfaces            | What exists, via `defineSurface`             |
| Action schemas      | `input` / `output` JSON Schema per action    |
| Observation schemas | `schema` per observation                     |
| Handlers            | What actually executes                       |

### Requirements enforced at compile time

`createOUI` will not compile unless every requirement is met:

```typescript
createOUI({ socket, surfaces: [alpha, alpha] });
// ✗ Duplicate surface id: "alpha". Registration is keyed by id,
//   so the second would silently replace the first.

createOUI({ socket, surfaces: [] });
// ✗ createOUI requires at least one surface. An instance with no
//   surfaces registers nothing and dispatches nowhere.

createOUI({ surfaces: [alpha] });
// ✗ Property 'socket' is missing.

createOUI({ socket, surfaces: [{ id: "x", name: "X" /* ... */ }] });
// ✗ Property '[OUI_BRAND]' is missing — surfaces must come from defineSurface.

const mine: OwnedTransport = createWebSocketTransport(socket);
// ✗ Property '[OUI_BRAND]' is missing in type 'OUITransport'.
```

Duplicate action and observation ids within a surface are validated by
`defineSurface`. Surface-level rules are checked by the type system, so they
fail in your editor rather than at render time in a browser after a deploy.

---

## Architecture

### Request and Result

```mermaid
sequenceDiagram
    participant Agent as Agent Runtime
    participant WS as WebSocket Server
    participant Browser as Browser (surface runtime)

    Agent->>WS: oui:dispatch { requestId, surfaceId, actionId, params }
    WS->>Browser: oui:dispatch
    Note over Browser: Handler runs once (de-duplicated by requestId)
    Note over Browser: Waits until the UI settles
    Browser->>WS: oui:action:result { requestId, success, data, observations, surfacesHash, surfaces if changed }
    WS->>Agent: result for requestId
```

The client waits for the UI to settle before answering: nothing mounted,
unmounted or changed an observation for a quiet window (250 ms by default), and
no hold open. A component whose work mounting cannot show, such as a route's
code or a page's data still loading, keeps the result waiting with
`useSurfaceHold(isLoading)`. If the deadline passes first, the result says
`settled: false`.

### Long operations

The result of an async action is its acknowledgment: the job was started, and
here is its id. The agent is not held until a two-minute render finishes. The
client polls or subscribes, publishes progress as observations, and sends the
request's final result when the job ends.

### Approvals

Some actions can't be undone: an order placed, a payment made, a message sent, something published, or something the person made deleted. An action declares this with `effect: 'transaction'`, or with `confirm: true` for a destructive write. It then runs only on the user's approval of the exact request.

1. The agent runtime stops at the action and shows the user a confirmation built from the action's `title`, `description` and input schema.
2. The user confirms. The approval store answers this tab, and only this tab, with a grant. The tab records it:

   ```ts
   runtime.grantApproval({ approvalId, argsHash, expiresAt });
   ```

3. The request that runs the action carries `approval: { approvalId, argsHash }`. The runtime runs it only when all of these hold:
   - the grant exists in this tab;
   - the grant is unused and unexpired;
   - `argsHash(params)` equals the hash the user approved.

   Otherwise it answers `{ success: false, error: { code: 'APPROVAL_REQUIRED' } }` and never calls the handler. That applies even during a turn the `accept` gate admits.

4. A grant admits one request.

`argsHash` is SHA-256 over the RFC 8785 (JCS) canonical JSON of the params, as lowercase hex. Every implementation (the agent runtime, the approval store, this runtime, and engines in other languages) must reproduce [`spec/approval-vectors.json`](./spec/approval-vectors.json), which is also published as `oui-spec/approval-vectors.json`.

---

## Polling & Async Operations

Many UI operations are not instant. A DataViz chart generation might take 30 seconds. A file export might need to wait for server-side rendering. OUI handles this with **declarative polling configuration**:

```typescript
{
  id: 'generate_chart',
  description: 'Generate a visualization from the configured dataset',
  async: true,
  estimatedDuration: '10-30s',
  input: {
    type: 'object',
    properties: {
      chartType: { type: 'string', enum: ['bar', 'line', 'scatter', 'pie'] },
      dataset: { type: 'string', description: 'Dataset ID to visualize' },
    },
    required: ['chartType', 'dataset'],
  },
  polling: {
    intervalMs: 2000,
    maxAttempts: 30,
    resolve: async (dispatchResult, ctx) => {
      const job = await ctx.api.getJobStatus(dispatchResult.jobId);
      if (job.status === 'complete') {
        return { done: true, data: { status: 'complete', chartUrl: job.outputUrl } };
      }
      return { done: false, data: { status: job.status, progress: job.progress } };
    },
  },
  handler: async (params, ctx) => {
    const job = await ctx.api.startChartGeneration(params);
    return { success: true, data: { jobId: job.id } };
  },
}
```

**What happens at runtime:**

1. Agent dispatches `generate_chart` with params
2. Handler fires, calls the API, returns `{ jobId: 'xyz' }` immediately
3. OUI runtime starts polling every 2 seconds using the `resolve` function
4. Each poll pushes an observation: `{ status: 'processing', progress: 45, interim: true }`
5. When `resolve` returns `{ done: true }`, polling stops and a final observation is pushed
6. The agent sees the final `{ status: 'complete', chartUrl: '...' }` observation on its next invocation

### Subscribe Mode (Alternative to Polling)

If you have realtime infrastructure (WebSocket events, SSE, etc.), you can use subscribe mode instead of polling:

```typescript
polling: {
  intervalMs: 0, // Not used in subscribe mode
  subscribe: {
    event: 'job:complete',
    filter: { jobId: '$dispatchResult.jobId' },
  },
},
```

The `$dispatchResult.` prefix tells the runtime to resolve the filter value from the handler's return data. The transport layer listens for the named event and pushes the observation when it arrives.

---

## Real-World Example: DataViz Surface

A complete DataViz wizard surface — the kind of thing you'd build for an AI-assisted analytics tool:

```typescript
// dataviz.surface.ts
import { defineSurface } from "oui-spec/core";
import type { DataVizContext } from "./types";

export const datavizSurface = defineSurface<DataVizContext>({
  id: "dataviz-wizard",
  name: "Data Visualization Wizard",
  description:
    "AI-controllable data visualization builder. Supports dataset selection, chart configuration, filtering, and export.",
  version: "1.0.0",

  activation: {
    routes: ["/studio/dataviz", "/studio/dataviz/*"],
    condition: "User has an active project with at least one dataset",
  },

  actions: [
    {
      id: "select_dataset",
      description:
        "Select a dataset to visualize. Must be called before configuring a chart.",
      input: {
        type: "object",
        properties: {
          datasetId: {
            type: "string",
            description: "The dataset ID from available_datasets observation",
          },
        },
        required: ["datasetId"],
      },
      handler: async (params, ctx) => {
        const dataset = await ctx.api.loadDataset(params.datasetId as string);
        ctx.updateState({ selectedDataset: dataset, step: "configure" });
        return {
          success: true,
          data: { columns: dataset.columns, rowCount: dataset.rowCount },
        };
      },
    },
    {
      id: "configure_chart",
      description: "Configure the chart type, axes, and visual options",
      input: {
        type: "object",
        properties: {
          chartType: {
            type: "string",
            enum: ["bar", "line", "scatter", "pie", "heatmap", "treemap"],
          },
          xAxis: { type: "string", description: "Column name for x-axis" },
          yAxis: { type: "string", description: "Column name for y-axis" },
          colorBy: {
            type: "string",
            description: "Column to use for color encoding (optional)",
          },
          aggregation: {
            type: "string",
            enum: ["sum", "avg", "count", "min", "max"],
            description: "Aggregation function for y-axis",
          },
        },
        required: ["chartType", "xAxis", "yAxis"],
      },
      preconditions: "A dataset must be selected first (select_dataset)",
      handler: async (params, ctx) => {
        ctx.updateState({ chartConfig: params, step: "preview" });
        return {
          success: true,
          data: { configured: true, chartType: params.chartType },
        };
      },
    },
    {
      id: "apply_filter",
      description: "Add a filter to narrow the visualized data",
      input: {
        type: "object",
        properties: {
          column: { type: "string" },
          operator: {
            type: "string",
            enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"],
          },
          value: { description: "Filter value — type depends on the column" },
        },
        required: ["column", "operator", "value"],
      },
      handler: async (params, ctx) => {
        const filters = [...ctx.state.filters, params];
        ctx.updateState({ filters });
        return { success: true, data: { filterCount: filters.length } };
      },
    },
    {
      id: "render_chart",
      description:
        "Render the configured chart. This is async — the chart is generated server-side.",
      async: true,
      estimatedDuration: "5-20s",
      input: {
        type: "object",
        properties: {
          quality: {
            type: "string",
            enum: ["draft", "production"],
            description: "Render quality",
          },
        },
      },
      polling: {
        intervalMs: 2000,
        maxDurationMs: 60000,
        resolve: async (dispatchResult, ctx) => {
          const result = dispatchResult as { jobId: string };
          const status = await ctx.api.getRenderStatus(result.jobId);
          if (status.state === "complete") {
            return {
              done: true,
              data: {
                status: "complete",
                imageUrl: status.imageUrl,
                renderTimeMs: status.durationMs,
              },
            };
          }
          if (status.state === "failed") {
            return {
              done: true,
              data: { status: "failed", error: status.error },
            };
          }
          return {
            done: false,
            data: { status: "rendering", progress: status.progress },
          };
        },
      },
      handler: async (params, ctx) => {
        const job = await ctx.api.startRender({
          dataset: ctx.state.selectedDataset.id,
          config: ctx.state.chartConfig,
          filters: ctx.state.filters,
          quality: (params.quality as string) ?? "draft",
        });
        return { success: true, data: { jobId: job.id } };
      },
    },
    {
      id: "export_chart",
      description: "Export the rendered chart as PNG, SVG, or PDF",
      input: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["png", "svg", "pdf"] },
          width: {
            type: "number",
            description: "Export width in pixels (default 1200)",
          },
          height: {
            type: "number",
            description: "Export height in pixels (default 800)",
          },
        },
        required: ["format"],
      },
      preconditions: "A chart must be rendered first (render_chart)",
      handler: async (params, ctx) => {
        const url = await ctx.api.exportChart(
          ctx.state.renderedChart.id,
          params,
        );
        return {
          success: true,
          data: { downloadUrl: url, format: params.format },
        };
      },
    },
  ],

  observations: [
    {
      id: "available_datasets",
      description:
        "List of datasets available for visualization in the current project",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            rowCount: { type: "number" },
            columns: { type: "array", items: { type: "string" } },
          },
        },
      },
      updateFrequency: "on-change",
    },
    {
      id: "wizard_state",
      description:
        "Current state of the DataViz wizard — which step the user is on and what is configured",
      schema: {
        type: "object",
        properties: {
          step: {
            type: "string",
            enum: ["select", "configure", "preview", "export"],
          },
          selectedDatasetId: { type: "string" },
          chartConfig: { type: "object" },
          filters: { type: "array" },
          renderedChartUrl: { type: "string" },
        },
      },
      updateFrequency: "on-change",
    },
  ],
});
```

### Using the Surface in React

```tsx
// DataVizPage.tsx — rendered inside a SurfaceRuntimeProvider
import { useSurface, useObservation } from "oui-spec/react";
import { datavizSurface } from "./dataviz.surface";

export function DataVizPage() {
  const { state, updateState, api } = useDataVizWizard();

  const surface = useSurface({
    surface: datavizSurface,
    context: { state, updateState, api },
  });

  // Keep observations equal to the state they describe
  useObservation(surface, "wizard_state", {
    step: state.step,
    selectedDatasetId: state.selectedDataset?.id,
    chartConfig: state.chartConfig,
    filters: state.filters,
    renderedChartUrl: state.renderedChart?.imageUrl,
  });
  useObservation(surface, "available_datasets", state.datasets);

  return <DataVizWizardUI state={state} />;
}
```

### What the Agent Sees

The agent runtime receives the manifest and exposes these tools to the LLM:

```
Tools available:
  - select_dataset(datasetId: string) — Select a dataset to visualize
  - configure_chart(chartType, xAxis, yAxis, ...) — Configure chart type and axes
  - apply_filter(column, operator, value) — Add a data filter
  - render_chart(quality?) — Render the chart (async, 5-20s)
  - export_chart(format, width?, height?) — Export as PNG/SVG/PDF

Observations:
  - available_datasets — [{id, name, rowCount, columns}]
  - wizard_state — {step, selectedDatasetId, chartConfig, ...}
```

The agent can orchestrate the full wizard: select data → configure chart → filter → render → export. All through typed, validated function calls. No screenshots. No DOM selectors.

---

## Subpath Imports

The `oui-spec` package exposes subpath exports for granular imports:

```typescript
import { createOUI, defineSurface } from "oui-spec/core";
import { useSurface, useObservation } from "oui-spec/react";
import type { SocketLike } from "oui-spec/transport";
import type { OUISurface, OUIAction } from "oui-spec/spec";

// Or import everything from the root
import { createOUI, defineSurface, useSurface } from "oui-spec";
```

`oui-spec/transport` also exports `createWebSocketTransport` and
`createDirectTransportPair`. These exist for tests and for embedding OUI in a
runtime that owns its own wiring — they are **not** the integration path, and
they return a plain `OUITransport` rather than the branded `OwnedTransport` that
OUI's own APIs accept. If you are integrating an application, use `createOUI`.

| Subpath              | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `oui-spec/spec`      | TypeScript types + JSON Schema for the OUI specification. Zero runtime deps. |
| `oui-spec/core`      | `createOUI()`, `defineSurface()`, manifest extraction, action execution.     |
| `oui-spec/react`     | `useSurface()` hook, `useObservation()` helper. React bindings.              |
| `oui-spec/transport` | Two-channel transport layer. WebSocket (Socket.IO), direct (in-memory).      |

---

## How OUI Relates to OpenAPI

OUI and OpenAPI are **complementary**, not competing:

|                      | OpenAPI                     | OUI                            |
| -------------------- | --------------------------- | ------------------------------ |
| **Describes**        | HTTP endpoints              | UI capabilities                |
| **Operates on**      | Network requests            | Application state              |
| **Agent uses it to** | Call backend APIs           | Control frontend UIs           |
| **State awareness**  | None (stateless HTTP)       | Observations push live state   |
| **Async model**      | Webhooks / polling (manual) | Built-in polling runtime       |
| **Schema format**    | JSON Schema                 | JSON Schema                    |
| **Transport**        | HTTP                        | WebSocket, postMessage, direct |

An application can expose **both**: an OpenAPI spec for its REST API and an OUI manifest for its UI. An agent that needs to "call the API" uses OpenAPI. An agent that needs to "use the app" uses OUI.

They even share JSON Schema for parameter validation — a deliberate design choice so the ecosystem tooling (validators, code generators, documentation) works with both.

---

## Comparison Table

|                        | Vision / Screenshot            | DOM Scraping              | MCP Tools                 | **OUI**                                 |
| ---------------------- | ------------------------------ | ------------------------- | ------------------------- | --------------------------------------- |
| **Discovery**          | Infer from pixels              | Parse HTML structure      | Read tool manifests       | Read surface manifest                   |
| **Actions**            | Click (x, y)                   | `querySelector().click()` | `call_tool(name, params)` | `dispatch(surfaceId, actionId, params)` |
| **Feedback**           | Screenshot & compare           | Check DOM changed         | Tool returns response     | Observation pushed async                |
| **UI awareness**       | Full (but expensive)           | Structural only           | None                      | Declared observations                   |
| **Reliability**        | Breaks on style/layout changes | Breaks on DOM changes     | Stable (typed)            | Stable (typed)                          |
| **Cost per action**    | ~$0.01-0.05 (vision model)     | Near zero                 | Near zero                 | Near zero                               |
| **Latency**            | 2-10s (screenshot + inference) | <100ms                    | <100ms                    | <100ms                                  |
| **Async operations**   | Poll screenshots               | Poll DOM                  | Not built-in              | Declarative polling runtime             |
| **Consent model**      | Everything visible             | Everything in DOM         | Server declares tools     | App declares surface                    |
| **Framework coupling** | None                           | Tight (HTML-specific)     | None                      | None (spec is universal)                |
| **Complex workflows**  | Dozens of screenshots          | Dozens of selectors       | Multiple tool calls       | Multiple requests, each answered        |

---

## Principles

1. **App-declared, not inferred.** The application explicitly states what it supports. Agents don't guess from pixels or DOM.
2. **Semantic, not structural.** Actions are named operations (`render_chart`), not DOM paths (`click #btn-render`).
3. **Typed end-to-end.** Inputs and outputs use JSON Schema. The agent knows exactly what to send and expect.
4. **Every action is answered.** One result per request, correlated by `requestId`, carrying what the client can do after it. Long jobs are acknowledged at once and answered again when they finish.
5. **The client is the record.** The client's surface runtime knows what is mounted; an agent can take its snapshot rather than trust a registry that can drift from it.
6. **Framework-agnostic.** The spec works with React, Vue, Svelte, vanilla JS, native apps — anything that can handle a function call and emit an event.
7. **Observable.** The agent reads relevant state without screenshots. The app pushes state changes when they happen.
8. **Consent-based.** The app controls what's exposed. Users and developers decide what agents can do.
9. **Composable.** Multiple surfaces coexist. A complex app exposes many surfaces (one per feature/page).
10. **Complementary.** OUI doesn't replace OpenAPI, MCP, or any other standard. It fills the "UI control" gap they leave open.
11. **Unbypassable.** A contract an integrator can satisfy without using is not a contract. OUI brands the values it owns with a `unique symbol`, so structural typing cannot be used to substitute a hand-rolled transport or surface. Requirements fail at compile time, with the offending id named.

---

## Status

🚧 **Active development.** The specification (v0.1) and core packages are functional and in use within the Closure AI Studio platform. The public API is stabilizing but may change before 1.0.

### Roadmap

- [x] Specification v0.1
- [x] `oui-spec/spec` — Types package
- [x] `oui-spec/core` — `defineSurface()` + manifest extraction
- [x] `oui-spec/react` — `useSurface()` hook + observation helpers
- [x] `oui-spec/transport` — WebSocket + Direct transports
- [x] `createOUI()` — gated instantiation; integration requirements enforced at compile time
- [x] `createSurfaceRuntime()` — client-side record of mounted surfaces; every request answered with a result and the snapshot after it
- [x] Approvals — `transaction` and destructive actions run only on a grant from the user's own confirmation, bound to the exact params (0.5.0)
- [x] Results carry surfaces only when they changed (`knownSurfaces` / `surfacesHash`), and a refused result is sent again trimmed, saying why (0.6.0)
- [ ] `oui-spec/devtools` — Surface inspector / debugger
- [ ] `oui-spec/vue` — Vue bindings
- [ ] `oui-spec/validator` — Runtime schema validation
- [ ] Specification v1.0

---

## Contributing

Contributions welcome. Please read the spec at [`spec/OUI-SPEC-v0.1.md`](./spec/OUI-SPEC-v0.1.md) before proposing changes to ensure alignment with the design principles.

`oui-spec` lives in the [OUI monorepo](https://github.com/wesreid/oui) beside the `@ouispec/*` packages. See its [CONTRIBUTING.md](https://github.com/wesreid/oui/blob/main/CONTRIBUTING.md):

```bash
git clone https://github.com/wesreid/oui.git
cd oui
pnpm install
pnpm --filter oui-spec build
pnpm --filter oui-spec test
pnpm --filter oui-spec typecheck
```

---

## License

MIT
