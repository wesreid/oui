# OUI Specification

**Version:** 0.1.0  
**Status:** Draft  
**Date:** 2026-07-27  
**Authors:** Closure Studio  

---

## Abstract

This document defines the **Open UI Specification (OUI)** — a machine-readable contract that allows any user interface application to declare a semantic control surface for consumption by AI agent runtimes. OUI enables agents to discover, understand, and invoke application capabilities through typed, structured interactions rather than brittle visual or DOM-based approaches.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Surface Object](#3-surface-object)
4. [Action Object](#4-action-object)
5. [Observation Object](#5-observation-object)
6. [Activation Object](#6-activation-object)
7. [Protocol](#7-protocol)
8. [Transport Layer](#8-transport-layer)
9. [Security Considerations](#9-security-considerations)
10. [Conformance](#10-conformance)

---

## 1. Introduction

### 1.1 Purpose

OUI defines a standard interface through which AI agents can programmatically control user interfaces. It replaces fragile vision-based or DOM-scraping approaches with an application-declared, typed, semantic contract.

An application that implements OUI declares:
- **What it can do** (Actions)
- **What state is observable** (Observations)
- **When capabilities are available** (Activation)

An agent runtime that consumes OUI:
- **Discovers** available capabilities at runtime
- **Invokes** typed operations and receives structured results
- **Observes** application state changes in real-time

### 1.2 Problem Statement

Current approaches for AI agents to interact with user interfaces are fundamentally unreliable:

| Approach | Failure Mode |
|----------|-------------|
| Screenshot + Vision Model | Breaks on theme changes, responsive layouts, overlays |
| DOM Scraping | Breaks on framework updates, CSS refactors, dynamic rendering |
| Coordinate Clicking | Breaks on window resize, scroll position, element reflow |
| Accessibility Tree | Incomplete for custom components, missing semantics |

All of these approaches attempt to **infer** application capabilities from implementation details. OUI inverts this: the application **declares** its capabilities explicitly.

### 1.3 Relationship to OpenAPI

OUI is the UI-side complement to the [OpenAPI Specification](https://spec.openapis.org/oas/latest.html):

```
OpenAPI Spec  + HTTP Server  = any client can consume the API
OUI Manifest  + UI App       = any agent can control the UI
```

| Dimension | OpenAPI | OUI |
|-----------|---------|-----|
| Describes | HTTP endpoints | UI capabilities |
| Consumer | HTTP clients | Agent runtimes |
| Transport | HTTP request/response | Protocol events (WebSocket, postMessage, etc.) |
| Discovery | Static spec document (JSON/YAML) | Dynamic registration (surfaces appear/disappear) |
| Statefulness | Stateless (per-request) | Stateful (observations persist, surfaces have lifecycle) |

An application MAY expose both an OpenAPI spec for its REST API and an OUI manifest for its UI. These serve different consumers: programmatic API clients vs. interactive agent runtimes.

### 1.4 Design Principles

1. **App-declared, not inferred.** The application explicitly states what it supports.
2. **Semantic, not structural.** Actions are named operations, not DOM paths.
3. **Typed end-to-end.** Inputs and outputs conform to JSON Schema.
4. **Bidirectional.** Actions return structured results; agents know what happened.
5. **Framework-agnostic.** Works with any UI technology that can declare actions and handle invocations.
6. **Consent-based.** The application controls what is exposed to agents.
7. **Observable.** Agents read structured state, not pixels.
8. **Composable.** Multiple surfaces coexist; complex apps expose many surfaces.

### 1.5 Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

Field types reference [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-core.html). All schemas in this specification are expressed as JSON Schema unless otherwise noted.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Surface** | A controllable boundary within an application that declares a set of actions and observations. Represents a cohesive unit of functionality (e.g., a page, a feature, a component) that an agent can interact with. |
| **Action** | A single, named operation that an agent can invoke on a surface. Has typed input parameters and a typed return value. Becomes a "tool" in the agent runtime's tool set. |
| **Observation** | A piece of application state that the agent can read. Observations are pushed to the agent when state changes, providing situational awareness without screenshots. |
| **Manifest** | The serializable, schema-only representation of a surface — its metadata, actions (without handlers), and observations. This is what crosses the wire to the agent runtime. |
| **Agent Runtime** | The system that consumes OUI manifests, presents actions as tools to an LLM, and coordinates invocations. Examples: Closure Agent SDK, LangChain, custom orchestrators. |
| **Transport** | The communication layer between a surface and the agent runtime. OUI is transport-agnostic; bindings are defined for WebSocket, postMessage, and direct function call. |
| **Activation** | Conditions under which a surface is available. A surface that is not activated MUST NOT be presented to the agent as available. |
| **Protocol Event** | A typed message exchanged between surfaces and the agent runtime over the transport layer. |
| **Correlation ID** | A unique identifier (`requestId`) that links an action request to its corresponding result, enabling asynchronous request/response over any transport. |
| **Handler** | The implementation function that executes when an action is invoked. Handlers are local to the surface and never cross the wire. |

---

## 3. Surface Object

A Surface is the top-level object in OUI. It represents a self-contained, controllable boundary within an application.

### 3.1 Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique identifier for this surface. MUST be unique within the application scope. SHOULD use kebab-case (e.g., `document-editor`, `dataviz-wizard`). |
| `name` | `string` | ✅ | Human-readable display name for the surface. Used in agent UIs and logs. |
| `description` | `string` | ✅ | Natural-language description of what this surface does. This text is included in the agent's LLM context to inform tool selection. SHOULD be concise but descriptive (1–3 sentences). |
| `version` | `string` | | Semantic version of this surface's contract (e.g., `1.0.0`). When present, agent runtimes MAY use this for compatibility checking. |
| `actions` | `OUIAction[]` | ✅ | Array of actions available on this surface. MUST contain at least one action. |
| `observations` | `OUIObservation[]` | | Array of observable state exposed by this surface. MAY be empty or omitted. |
| `activation` | `OUIActivation` | | Conditions under which this surface is active. If omitted, the surface is considered always active when registered. |
| `metadata` | `object` | | Arbitrary key-value pairs for implementation-specific extensions. Agent runtimes SHOULD pass metadata to the LLM context if it aids decision-making. |

### 3.2 Identifier Requirements

Surface IDs:
- MUST match the pattern `^[a-z][a-z0-9-]*[a-z0-9]$` (lowercase letters, digits, hyphens; must start with a letter and end with a letter or digit)
- MUST be between 2 and 64 characters in length
- MUST be unique within a single application's registration scope

### 3.3 Description Best Practices

The `description` field is critical — it is the primary signal an LLM uses to decide whether to interact with a surface. Effective descriptions:
- State the surface's **purpose** (what it lets you do)
- Mention the **domain** (what kind of data/entities it works with)
- Are **concise** (avoid implementation details)

### 3.4 Example

```json
{
  "id": "document-editor",
  "name": "Document Editor",
  "description": "Rich text document editor. Supports creating, editing, formatting, and exporting documents.",
  "version": "1.2.0",
  "actions": [ ... ],
  "observations": [ ... ],
  "activation": {
    "routes": ["/documents/*"]
  },
  "metadata": {
    "maxDocumentSize": "10MB",
    "supportedFormats": ["markdown", "html", "pdf"]
  }
}
```

### 3.5 Lifecycle

A surface has the following lifecycle states:

```
[Defined] → [Registered] → [Active] → [Deregistered]
                              ↕
                          [Inactive]
```

- **Defined:** The surface is declared in code but not yet connected to a transport.
- **Registered:** The surface has been announced to the agent runtime via a `surface:register` event.
- **Active:** The surface's activation conditions are met; its actions are available for invocation.
- **Inactive:** The surface is registered but its activation conditions are not currently met. The agent runtime MUST NOT invoke actions on an inactive surface.
- **Deregistered:** The surface has been removed via a `surface:deregister` event. All references MUST be cleaned up.

---

## 4. Action Object

An Action represents a single operation an agent can perform on a surface. Each action is presented to the LLM as a callable tool.

### 4.1 Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique action identifier within this surface. Becomes the tool name in the agent runtime. MUST use snake_case (e.g., `create_document`, `set_font_size`). |
| `description` | `string` | ✅ | Natural-language description of what this action does. Included in LLM context. SHOULD clearly state the effect and when to use it. |
| `input` | `JSONSchema` | ✅ | JSON Schema defining the action's input parameters. The agent runtime validates payloads against this schema before dispatching. |
| `output` | `JSONSchema` | | JSON Schema defining the action's return value. When present, agent runtimes MAY validate results. If omitted, the result is still returned to the agent as untyped data. |
| `confirm` | `boolean` | | Default: `false`. If `true`, the agent runtime MUST obtain user confirmation before executing this action. Use for destructive, irreversible, or high-impact operations. |
| `async` | `boolean` | | Default: `false`. If `true`, the action returns immediately with a tracking identifier. The actual result is delivered later via an `action:result` event. |
| `usage` | `string` | | Human-readable hint about when this action is appropriate. Supplements `description` with situational guidance (e.g., "Use after the user has selected a document"). |
| `preconditions` | `string` | | Natural-language description of conditions that should be met before invocation. Expressed for the LLM's benefit, not as executable validation logic. |
| `estimatedDuration` | `string` | | Human-readable duration hint. One of: `"instant"`, `"< 1s"`, `"1-5s"`, `"5-30s"`, `"30-120s"`, `"> 2min"`, or a custom string. Helps agents manage user expectations. |
| `tags` | `string[]` | | Categorization tags (e.g., `["write", "destructive"]`, `["read-only"]`). Agent runtimes MAY use tags for filtering or policy enforcement. |

### 4.2 Identifier Requirements

Action IDs:
- MUST match the pattern `^[a-z][a-z0-9_]*[a-z0-9]$` (lowercase letters, digits, underscores; must start with a letter and end with a letter or digit)
- MUST be between 2 and 64 characters in length
- MUST be unique within a single surface

### 4.3 Input Schema

The `input` field MUST be a valid JSON Schema object. The top-level schema SHOULD have `type: "object"` with a `properties` map. The `required` array specifies which properties are mandatory.

**Requirements:**
- Every property SHOULD include a `description` field to inform the LLM
- The schema MUST be self-contained (no external `$ref` references in manifest form)
- Default values SHOULD be specified where applicable

**Example:**

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "The document title",
      "minLength": 1,
      "maxLength": 255
    },
    "format": {
      "type": "string",
      "enum": ["markdown", "html", "plain"],
      "default": "markdown",
      "description": "The document format"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Optional categorization tags"
    }
  },
  "required": ["title"]
}
```

### 4.4 Output Schema

The `output` field, when present, defines the shape of the successful result's `data` payload. It follows the same JSON Schema rules as `input`.

If `output` is omitted, the action still returns a result — the `data` field is simply untyped from the spec's perspective.

### 4.5 Execution Semantics

#### 4.5.1 Synchronous Actions (`async: false` or omitted)

1. Agent runtime sends an `action:request` event with a unique `requestId`
2. Surface validates the input against the action's `input` schema
3. Surface executes the handler
4. Surface sends an `action:result` event with the same `requestId`
5. Agent runtime correlates the result and returns it to the LLM

The entire cycle MUST complete within the transport's configured timeout (see [Section 7.5](#75-timeouts)).

#### 4.5.2 Asynchronous Actions (`async: true`)

1. Agent runtime sends an `action:request` event with a unique `requestId`
2. Surface acknowledges receipt immediately with an `action:result` containing a tracking ID in `data`
3. When the operation completes, the surface sends a follow-up `action:result` with the same `requestId` and the final result

The initial acknowledgment MUST arrive within the transport timeout. The final result has no protocol-level timeout — the agent runtime tracks pending async operations independently.

#### 4.5.3 Confirmed Actions (`confirm: true`)

When an action has `confirm: true`:

1. Agent runtime receives the action invocation from the LLM
2. Agent runtime presents a confirmation prompt to the human user
3. If confirmed: proceeds with normal execution flow
4. If denied: returns a result with `success: false` and error code `ACTION_DENIED`

The confirmation UX is the agent runtime's responsibility. The surface is not involved in the confirmation flow.

### 4.6 Error Handling

When an action fails, the `action:result` MUST have `success: false` and include an `error` object:

```json
{
  "requestId": "req-abc123",
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Parameter 'title' must not be empty",
    "details": {
      "field": "title",
      "constraint": "minLength",
      "expected": 1,
      "actual": 0
    }
  },
  "timestamp": 1706000000000
}
```

#### Standard Error Codes

| Code | Description |
|------|-------------|
| `ACTION_NOT_FOUND` | The specified `actionId` does not exist on this surface |
| `VALIDATION_ERROR` | Input parameters failed schema validation |
| `PRECONDITION_FAILED` | Action preconditions are not met |
| `ACTION_DENIED` | User denied confirmation for a `confirm: true` action |
| `EXECUTION_ERROR` | Handler threw an unhandled exception |
| `TIMEOUT` | Action exceeded its execution timeout |
| `SURFACE_UNAVAILABLE` | The target surface is not currently active |
| `INTERNAL_ERROR` | An unexpected internal error occurred |

Implementations MAY define additional error codes. Custom codes SHOULD use a namespaced format (e.g., `app:quota_exceeded`).

### 4.7 Example

```json
{
  "id": "create_document",
  "description": "Create a new document in the workspace. Returns the document ID and URL.",
  "input": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "Document title", "minLength": 1 },
      "template": { "type": "string", "enum": ["blank", "meeting-notes", "project-brief"], "default": "blank" }
    },
    "required": ["title"]
  },
  "output": {
    "type": "object",
    "properties": {
      "documentId": { "type": "string" },
      "url": { "type": "string", "format": "uri" },
      "createdAt": { "type": "string", "format": "date-time" }
    }
  },
  "confirm": false,
  "async": false,
  "usage": "Use when the user wants to create a new document. Prefer a descriptive title.",
  "estimatedDuration": "< 1s",
  "tags": ["write", "create"]
}
```

---

## 5. Observation Object

An Observation exposes a piece of application state to the agent runtime. Observations give agents situational awareness — they know what's on screen, what data is loaded, and what the current context is — without needing screenshots or DOM access.

### 5.1 Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique identifier within the surface. MUST use snake_case. |
| `description` | `string` | ✅ | Natural-language description of what this observation represents. Included in LLM context. |
| `schema` | `JSONSchema` | ✅ | JSON Schema defining the shape of the observation's value. |
| `updateFrequency` | `string` | | One of `"realtime"`, `"on-change"`, or `"polling"`. Defaults to `"on-change"`. Informs the agent runtime about expected update patterns. |

### 5.2 Identifier Requirements

Observation IDs follow the same rules as action IDs:
- MUST match `^[a-z][a-z0-9_]*[a-z0-9]$`
- MUST be between 2 and 64 characters
- MUST be unique within a single surface
- MUST NOT collide with action IDs on the same surface

### 5.3 Update Semantics

Observations are state snapshots pushed from the surface to the agent runtime.

#### 5.3.1 Update Frequencies

| Frequency | Behavior |
|-----------|----------|
| `realtime` | Value is pushed on every frame/tick/render cycle. Use sparingly — appropriate for continuously changing values (cursor position, audio level). |
| `on-change` | Value is pushed whenever the underlying state changes. This is the default and RECOMMENDED mode for most observations. |
| `polling` | The agent runtime must explicitly request the value. The surface does not push updates proactively. |

#### 5.3.2 Push Model (Default)

For `realtime` and `on-change` observations:

1. When the surface is registered, it SHOULD emit an initial `observation:update` for each observation with the current value
2. When the underlying state changes, the surface emits an `observation:update` event
3. The agent runtime maintains the latest value for each observation
4. Values are included in the LLM's context on the next interaction

#### 5.3.3 Pull Model (`polling`)

For `polling` observations:

1. The agent runtime sends an `observation:request` event specifying the surface and observation IDs
2. The surface responds with an `observation:update` event containing the current value

Pull-mode observations are useful for expensive-to-compute state that shouldn't be pushed continuously.

### 5.4 Value Semantics

- Each `observation:update` carries the **complete** current value — not a delta or patch
- Implementations SHOULD deduplicate updates (don't push if the value hasn't changed)
- The value MUST conform to the observation's declared `schema`
- A value of `null` indicates the observation is currently unavailable (e.g., no document is open)

### 5.5 Example

```json
{
  "id": "document_state",
  "description": "Current state of the active document including title, word count, and selection",
  "schema": {
    "type": "object",
    "properties": {
      "documentId": { "type": "string" },
      "title": { "type": "string" },
      "wordCount": { "type": "integer" },
      "selectedText": { "type": "string", "description": "Currently selected text, empty if no selection" },
      "cursorPosition": {
        "type": "object",
        "properties": {
          "line": { "type": "integer" },
          "column": { "type": "integer" }
        }
      },
      "isDirty": { "type": "boolean", "description": "True if document has unsaved changes" }
    }
  },
  "updateFrequency": "on-change"
}
```

---

## 6. Activation Object

Activation defines the conditions under which a surface is available to the agent. Surfaces that fail their activation conditions MUST NOT be presented to the agent as available tools.

### 6.1 Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `routes` | `string \| string[]` | | URL path pattern(s) where this surface is active. Supports glob patterns (e.g., `/documents/*`, `/settings/**`). |
| `entity` | `object` | | An entity that must be loaded/present for this surface to activate. |
| `entity.type` | `string` | ✅ (if `entity` present) | The entity type (e.g., `"document"`, `"project"`, `"user-profile"`). |
| `entity.id` | `string` | | A specific entity ID. If omitted, any entity of the given type satisfies the condition. |
| `condition` | `string` | | Free-form natural-language description of additional activation conditions. Not executable — serves as documentation for the agent runtime and developers. |

### 6.2 Evaluation Rules

- If `activation` is omitted entirely, the surface is **always active** when registered
- If multiple fields are present, **all conditions** must be met (logical AND)
- Route patterns are matched against the current application URL path
- Entity conditions are evaluated by the application and communicated via registration/deregistration events

### 6.3 Route Patterns

Route patterns follow simplified glob syntax:

| Pattern | Matches |
|---------|---------|
| `/documents` | Exactly `/documents` |
| `/documents/*` | `/documents/abc` but not `/documents/abc/edit` |
| `/documents/**` | `/documents/abc`, `/documents/abc/edit`, `/documents/abc/edit/v2` |
| `/users/*/settings` | `/users/123/settings` |

### 6.4 Dynamic Activation

Applications with complex activation logic SHOULD manage surface lifecycle explicitly:
- Register the surface (via `surface:register`) when conditions are met
- Deregister (via `surface:deregister`) when conditions are no longer met

The `activation` field in the manifest serves as **documentation** of when the surface is expected to be available. The actual lifecycle is managed by the application.

### 6.5 Example

```json
{
  "routes": ["/projects/*/dataviz", "/projects/*/charts"],
  "entity": {
    "type": "project"
  },
  "condition": "User must have edit permissions on the project"
}
```

---

## 7. Protocol

The OUI Protocol defines the message exchange between agent runtimes and surfaces. It is transport-agnostic — the same message types and semantics apply regardless of whether communication occurs over WebSocket, postMessage, or direct function calls.

### 7.1 Protocol Events

All communication consists of typed protocol events. Each event has a `type` string and a `payload` object.

| Event Type | Direction | Description |
|-----------|-----------|-------------|
| `surface:register` | Surface → Runtime | A surface is announcing itself as available |
| `surface:deregister` | Surface → Runtime | A surface is announcing it is no longer available |
| `action:request` | Runtime → Surface | The agent is invoking an action |
| `action:result` | Surface → Runtime | The surface is returning an action's result |
| `observation:update` | Surface → Runtime | An observation value has changed |
| `observation:request` | Runtime → Surface | The agent is requesting a polling observation's current value |

### 7.2 Surface Registration and Deregistration

#### 7.2.1 Registration

When a surface becomes active, it MUST send a `surface:register` event:

```json
{
  "type": "surface:register",
  "payload": {
    "surface": {
      "id": "document-editor",
      "name": "Document Editor",
      "description": "Rich text editor for documents",
      "version": "1.2.0",
      "actions": [ ... ],
      "observations": [ ... ],
      "activation": { ... }
    },
    "timestamp": 1706000000000
  }
}
```

**Requirements:**
- The `surface` field contains the complete manifest (schema only, no handlers)
- The agent runtime MUST acknowledge registration by making the surface's actions available as tools
- If a surface with the same `id` is already registered, the new registration MUST replace the old one (hot-reload semantics)

#### 7.2.2 Deregistration

When a surface becomes inactive or is destroyed, it MUST send a `surface:deregister` event:

```json
{
  "type": "surface:deregister",
  "payload": {
    "surfaceId": "document-editor",
    "timestamp": 1706000000000
  }
}
```

**Requirements:**
- The agent runtime MUST remove the surface's actions from the available tool set
- Any pending action requests targeting this surface MUST be resolved with error code `SURFACE_UNAVAILABLE`
- Observation state for this surface MUST be discarded

### 7.3 Action Request and Result

#### 7.3.1 Action Request

When the agent invokes an action, the runtime sends an `action:request`:

```json
{
  "type": "action:request",
  "payload": {
    "requestId": "req-f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "surfaceId": "document-editor",
    "actionId": "create_document",
    "params": {
      "title": "Q4 Planning",
      "template": "meeting-notes"
    },
    "timestamp": 1706000000000
  }
}
```

**Requirements:**
- `requestId` MUST be a globally unique string. UUID v4 is RECOMMENDED.
- `params` MUST conform to the action's declared `input` schema
- The agent runtime SHOULD validate `params` before sending; the surface MUST validate upon receipt

#### 7.3.2 Action Result (Success)

```json
{
  "type": "action:result",
  "payload": {
    "requestId": "req-f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "success": true,
    "data": {
      "documentId": "doc-789",
      "url": "/documents/doc-789",
      "createdAt": "2026-07-27T10:30:00Z"
    },
    "durationMs": 142,
    "timestamp": 1706000000142
  }
}
```

#### 7.3.3 Action Result (Failure)

```json
{
  "type": "action:result",
  "payload": {
    "requestId": "req-f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "success": false,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Parameter 'title' is required",
      "details": { "field": "title" }
    },
    "durationMs": 3,
    "timestamp": 1706000000003
  }
}
```

**Requirements:**
- The `requestId` in the result MUST exactly match the request's `requestId`
- Exactly one `action:result` MUST be sent for each `action:request` (for sync actions)
- For async actions: one immediate acknowledgment result, then one final result (both with the same `requestId`)
- If `success` is `false`, the `error` field MUST be present
- If `success` is `true`, the `error` field MUST NOT be present

### 7.4 Observation Updates

#### 7.4.1 Push Update

```json
{
  "type": "observation:update",
  "payload": {
    "surfaceId": "document-editor",
    "observationId": "document_state",
    "value": {
      "documentId": "doc-789",
      "title": "Q4 Planning",
      "wordCount": 1247,
      "selectedText": "",
      "cursorPosition": { "line": 42, "column": 8 },
      "isDirty": true
    },
    "timestamp": 1706000001000
  }
}
```

#### 7.4.2 Pull Request

```json
{
  "type": "observation:request",
  "payload": {
    "surfaceId": "document-editor",
    "observationId": "document_state",
    "requestId": "obs-req-001",
    "timestamp": 1706000002000
  }
}
```

The surface responds with a standard `observation:update` event.

**Requirements:**
- The `value` MUST conform to the observation's declared `schema`
- Surfaces SHOULD batch rapid observation updates (e.g., debounce to max 10 updates/second for `on-change` observations)
- The agent runtime MUST handle out-of-order updates gracefully — always use the latest `timestamp`

### 7.5 Timeouts

Timeouts prevent resource leaks and provide predictable failure modes.

| Scenario | Default Timeout | Configurable |
|----------|----------------|--------------|
| Synchronous action execution | 30,000 ms | Yes |
| Action acknowledgment (async) | 5,000 ms | Yes |
| Surface registration response | 10,000 ms | Yes |
| Observation pull request | 5,000 ms | Yes |

When a timeout expires:
- The agent runtime MUST generate a synthetic `action:result` with `success: false` and error code `TIMEOUT`
- The agent runtime MUST NOT retry automatically (retry policy is the agent's decision)
- The surface MAY still complete the operation; late results SHOULD be silently discarded by the runtime

### 7.6 Error Handling

#### 7.6.1 Transport-Level Errors

If the transport connection is lost:
- All registered surfaces MUST be considered deregistered
- All pending action requests MUST be resolved with error code `SURFACE_UNAVAILABLE`
- On reconnection, surfaces MUST re-register

#### 7.6.2 Protocol-Level Errors

If a protocol event is malformed:
- The receiving party MUST ignore the event
- The receiving party SHOULD log a warning
- The receiving party MUST NOT crash or close the connection

#### 7.6.3 Application-Level Errors

Errors within action handlers are captured and returned as `action:result` with `success: false`. Unhandled exceptions MUST be caught by the surface runtime and returned with error code `EXECUTION_ERROR`.

### 7.7 Ordering Guarantees

- Events from a single surface MUST be delivered in order
- Events from different surfaces have no ordering guarantee relative to each other
- The agent runtime MUST process `action:result` events before dispatching subsequent `action:request` events for the same surface (no concurrent actions on a single surface unless explicitly supported)

---

## 8. Transport Layer

OUI is transport-agnostic. This section defines normative bindings for three transports. Implementations MAY support additional transports provided they satisfy the protocol semantics defined in [Section 7](#7-protocol).

### 8.1 Transport Interface

All transports MUST implement the following abstract interface:

```typescript
interface OUITransport {
  /** Send a protocol event to the remote side */
  send(event: OUIProtocolEvent): void;

  /** Register a handler for incoming protocol events */
  onEvent(handler: (event: OUIProtocolEvent) => void): void;

  /** Establish the transport connection */
  connect(): Promise<void>;

  /** Tear down the transport connection */
  disconnect(): void;

  /** Current connection state */
  readonly state: 'disconnected' | 'connecting' | 'connected';
}
```

### 8.2 WebSocket Binding

**Use case:** Browser application communicating with a server-side agent runtime, or any networked scenario.

#### 8.2.1 Connection

- The surface connects to the agent runtime's WebSocket endpoint
- URL format: `ws[s]://{host}:{port}/oui/v1`
- The connection MUST use TLS (`wss://`) in production environments

#### 8.2.2 Message Format

Each WebSocket message is a UTF-8 encoded JSON string representing a single `OUIProtocolEvent`:

```json
{
  "type": "action:request",
  "payload": { ... }
}
```

- Messages MUST be valid JSON
- Binary messages MUST NOT be used for protocol events
- Maximum message size: 1 MB (configurable)

#### 8.2.3 Connection Lifecycle

```
Client (Surface)                    Server (Agent Runtime)
     |                                      |
     |--- WebSocket Connect --------------->|
     |<-- 101 Switching Protocols ----------|
     |                                      |
     |--- surface:register ---------------->|
     |                                      |
     |<-- action:request -------------------|
     |--- action:result ------------------->|
     |                                      |
     |--- observation:update -------------->|
     |                                      |
     |--- surface:deregister -------------->|
     |--- Close Connection ---------------->|
```

#### 8.2.4 Reconnection

- On unexpected disconnection, the surface SHOULD attempt reconnection with exponential backoff
- Initial retry delay: 1 second
- Maximum retry delay: 30 seconds
- Backoff multiplier: 2x
- On successful reconnection, the surface MUST re-register all active surfaces

#### 8.2.5 Heartbeat

- The transport SHOULD implement WebSocket ping/pong frames
- Ping interval: 30 seconds
- If no pong is received within 10 seconds, the connection SHOULD be considered dead

### 8.3 postMessage Binding

**Use case:** Surface running in an iframe or web worker communicating with a parent/host page agent runtime.

#### 8.3.1 Message Format

```javascript
window.parent.postMessage({
  __oui__: true,
  event: {
    type: "surface:register",
    payload: { ... }
  }
}, targetOrigin);
```

- All OUI messages MUST include the `__oui__: true` discriminator field
- The `targetOrigin` MUST be set to the specific expected origin (never `"*"` in production)
- Receivers MUST verify `event.origin` matches the expected source

#### 8.3.2 Channel Establishment

1. The host page creates an iframe or web worker
2. The embedded surface sends a handshake message: `{ __oui__: true, handshake: "oui-v1" }`
3. The host acknowledges: `{ __oui__: true, handshake: "oui-v1-ack" }`
4. The surface proceeds with `surface:register`

#### 8.3.3 Security

- Messages from unexpected origins MUST be silently ignored
- The host SHOULD validate that the iframe's `src` matches a trusted allowlist before accepting registration
- Structured clone serialization ensures no prototype pollution

### 8.4 Direct Function Call Binding

**Use case:** Surface and agent runtime in the same JavaScript process (e.g., API surfaces, server-side rendering, testing).

#### 8.4.1 Interface

When both sides are in the same process, the transport reduces to direct function invocation:

```typescript
interface DirectTransport {
  /** Surface calls this to emit events to the runtime */
  emitToRuntime(event: OUIProtocolEvent): void;

  /** Runtime calls this to emit events to the surface */
  emitToSurface(event: OUIProtocolEvent): void;
}
```

#### 8.4.2 Synchronous vs. Asynchronous

Even in direct-call mode:
- Action handlers MUST be invoked asynchronously (via `await` or microtask)
- The protocol's event-based semantics are preserved — the runtime still receives `action:result` events
- This ensures behavioral consistency regardless of transport

#### 8.4.3 Testing

Direct function call transport is the RECOMMENDED approach for unit and integration testing of surfaces. It allows tests to:
- Register a surface
- Send action requests
- Assert on action results
- Verify observation updates

All without network overhead or browser infrastructure.

### 8.5 Transport Selection

| Scenario | Recommended Transport |
|----------|----------------------|
| Web app ↔ remote agent server | WebSocket |
| Iframe plugin ↔ host app | postMessage |
| Web worker ↔ main thread | postMessage |
| Same-process SDK integration | Direct function call |
| Server-side rendering | Direct function call |
| Automated testing | Direct function call |
| Electron main ↔ renderer | postMessage or WebSocket |
| React Native | WebSocket |

---

## 9. Security Considerations

OUI surfaces expose application capabilities to external agent runtimes. Security is a first-class concern.

### 9.1 Consent Model

#### 9.1.1 Developer Consent

- Only capabilities that are **explicitly declared** in a surface are exposed. OUI never infers or auto-discovers capabilities.
- Developers choose what to expose. If an action is not in the manifest, it does not exist to the agent.
- The `metadata` field MUST NOT be used to expose sensitive information (API keys, internal IDs not meant for agents).

#### 9.1.2 User Consent

- Agent runtimes SHOULD inform users which surfaces are active and what actions are available
- Agent runtimes MUST honor the `confirm` flag on actions
- Users SHOULD be able to disable specific surfaces or actions at runtime
- Agent runtimes SHOULD log all action invocations for user auditability

### 9.2 Action Confirmation

The `confirm: true` flag is the primary mechanism for protecting high-impact operations:

| Operation Type | Confirm Recommended |
|---------------|-------------------|
| Read-only / query | No |
| Create / add | Situational |
| Update / modify | Situational |
| Delete / destroy | Yes |
| External side effects (send email, publish) | Yes |
| Financial transactions | Yes |
| Permission changes | Yes |

Agent runtimes MUST NOT bypass confirmation. The confirmation prompt MUST clearly describe:
- Which action is being invoked
- What parameters are being passed
- The expected effect (from the action's `description`)

### 9.3 Scope Limiting

#### 9.3.1 Surface Scoping

Applications SHOULD scope surfaces narrowly:
- One surface per feature or page (not one monolithic surface for the entire app)
- Only expose actions relevant to the surface's domain
- Prefer many small surfaces over few large ones

#### 9.3.2 Input Validation

- Surfaces MUST validate all input parameters against the declared `input` schema before execution
- Surfaces MUST NOT trust input from the agent runtime without validation
- String inputs SHOULD be bounded (`maxLength`) to prevent injection attacks
- Array inputs SHOULD be bounded (`maxItems`) to prevent resource exhaustion

#### 9.3.3 Output Sanitization

- Action results MUST NOT include sensitive data not intended for the agent (e.g., internal tokens, other users' PII)
- Observation values MUST NOT expose data beyond what the current user is authorized to see

### 9.4 Transport Security

| Transport | Security Requirement |
|-----------|---------------------|
| WebSocket | MUST use TLS (`wss://`) in production. SHOULD authenticate the connection (e.g., via token in initial handshake). |
| postMessage | MUST validate `origin`. MUST NOT use `targetOrigin: "*"` in production. |
| Direct call | Inherits the process's security context. No additional requirements. |

### 9.5 Rate Limiting

- Surfaces SHOULD implement rate limiting on action execution to prevent abuse
- Agent runtimes SHOULD implement rate limiting on action requests to prevent runaway loops
- Observation updates SHOULD be throttled to prevent flooding (RECOMMENDED: max 10 updates/second per observation)

### 9.6 Capability Enumeration

The manifest is readable by the agent runtime. This means:
- Do not include security-sensitive information in action descriptions
- Do not expose admin-only actions to non-admin agent sessions
- Consider per-role surface variants if different users have different capabilities

---

## 10. Conformance

### 10.1 Conformance Levels

This specification defines two conformance targets:

#### 10.1.1 OUI-Compliant Surface

An application surface is **OUI-compliant** if it:

1. **Declares a valid manifest.** The surface's manifest conforms to the schemas defined in Sections 3–6. All REQUIRED fields are present. All field values conform to their specified types and constraints.

2. **Implements the protocol.** The surface correctly sends and receives protocol events as defined in Section 7. Specifically:
   - Sends `surface:register` on activation with a complete manifest
   - Sends `surface:deregister` on deactivation
   - Receives `action:request` events and returns `action:result` events with correct `requestId` correlation
   - Emits `observation:update` events according to declared `updateFrequency`

3. **Validates inputs.** The surface validates `action:request` parameters against the declared `input` schema before executing the handler.

4. **Handles errors gracefully.** Action handlers never throw unhandled exceptions that crash the surface. All failures are reported as `action:result` with `success: false`.

5. **Respects timeouts.** Synchronous actions complete within 30 seconds (or the configured timeout). Async actions acknowledge within 5 seconds.

6. **Implements at least one transport.** The surface is reachable via at least one of the defined transport bindings (WebSocket, postMessage, or direct call).

#### 10.1.2 OUI-Compliant Agent Runtime

An agent runtime is **OUI-compliant** if it:

1. **Consumes manifests correctly.** Parses surface manifests and presents actions as tools to the LLM with correct descriptions and input schemas.

2. **Implements the protocol.** Correctly sends and receives all protocol events:
   - Processes `surface:register` and `surface:deregister` events
   - Sends well-formed `action:request` events with unique `requestId` values
   - Correlates `action:result` events by `requestId`
   - Processes `observation:update` events and makes values available to the LLM

3. **Validates before dispatch.** Validates action parameters against the declared `input` schema before sending `action:request`.

4. **Honors confirmation.** Presents confirmation prompts for `confirm: true` actions. Never bypasses.

5. **Implements timeouts.** Enforces timeout limits and generates synthetic timeout results when exceeded.

6. **Cleans up on disconnect.** Removes surfaces and resolves pending requests on transport disconnection.

### 10.2 Versioning

This specification is versioned using [Semantic Versioning](https://semver.org/):

- **MAJOR** version: incompatible protocol changes
- **MINOR** version: backwards-compatible additions (new optional fields, new event types)
- **PATCH** version: clarifications and editorial fixes

Surfaces and runtimes SHOULD declare which spec version they implement. Compatibility negotiation is out of scope for v0.1 but is expected in a future version.

### 10.3 Extension Points

The specification provides explicit extension mechanisms:

| Extension Point | Mechanism |
|----------------|-----------|
| Surface metadata | The `metadata` field on `OUISurface` accepts arbitrary key-value pairs |
| Custom error codes | Namespaced codes (e.g., `app:custom_error`) alongside standard codes |
| Custom protocol events | Implementations MAY define additional event types prefixed with `x-` (e.g., `x-analytics:track`) |
| Transport extensions | Custom transports that implement the `OUITransport` interface |

Extensions MUST NOT conflict with the standard protocol. Receivers that encounter unknown event types MUST silently ignore them.

### 10.4 Compliance Testing

A reference test suite will be provided in the `@oui/compliance` package (planned). It will verify:

- Manifest schema validity
- Protocol event correctness (registration, action round-trip, observation delivery)
- Timeout behavior
- Error handling
- Transport binding correctness

Until the compliance suite is available, implementations SHOULD self-verify against the requirements in Sections 10.1.1 and 10.1.2.

---

## Appendix A: Full Protocol Event Schema

```typescript
type OUIProtocolEvent =
  | { type: 'surface:register'; payload: OUISurfaceRegistration }
  | { type: 'surface:deregister'; payload: OUISurfaceDeregistration }
  | { type: 'action:request'; payload: OUIActionRequest }
  | { type: 'action:result'; payload: OUIActionResult }
  | { type: 'observation:update'; payload: OUIObservationUpdate }
  | { type: 'observation:request'; payload: OUIObservationRequest };
```

### OUISurfaceRegistration

```typescript
{
  surface: OUISurface;   // Complete manifest
  timestamp: number;     // Unix epoch milliseconds
}
```

### OUISurfaceDeregistration

```typescript
{
  surfaceId: string;     // ID of surface being removed
  timestamp: number;
}
```

### OUIActionRequest

```typescript
{
  requestId: string;     // UUID v4 recommended
  surfaceId: string;     // Target surface
  actionId: string;      // Target action
  params: object;        // Input conforming to action's input schema
  timestamp: number;
}
```

### OUIActionResult

```typescript
{
  requestId: string;     // Correlates to request
  success: boolean;
  data?: unknown;        // Present when success = true
  error?: {              // Present when success = false
    code: string;
    message: string;
    details?: unknown;
  };
  durationMs?: number;   // Execution time
  timestamp: number;
}
```

### OUIObservationUpdate

```typescript
{
  surfaceId: string;
  observationId: string;
  value: unknown;        // Conforms to observation's schema
  timestamp: number;
}
```

### OUIObservationRequest

```typescript
{
  surfaceId: string;
  observationId: string;
  requestId: string;
  timestamp: number;
}
```

---

## Appendix B: Complete Example — Todo Application

This appendix shows a full OUI manifest for a todo application, demonstrating all object types.

```json
{
  "id": "todo-app",
  "name": "Todo Application",
  "description": "A task management application. Supports creating, completing, prioritizing, and filtering todo items.",
  "version": "1.0.0",
  "actions": [
    {
      "id": "add_todo",
      "description": "Add a new todo item to the list",
      "input": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "The todo text",
            "minLength": 1,
            "maxLength": 500
          },
          "priority": {
            "type": "string",
            "enum": ["low", "medium", "high"],
            "default": "medium",
            "description": "Priority level"
          },
          "dueDate": {
            "type": "string",
            "format": "date",
            "description": "Optional due date (ISO 8601 date)"
          }
        },
        "required": ["title"]
      },
      "output": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "created": { "type": "boolean" }
        }
      },
      "estimatedDuration": "instant",
      "tags": ["write", "create"]
    },
    {
      "id": "complete_todo",
      "description": "Mark a todo item as completed",
      "input": {
        "type": "object",
        "properties": {
          "todoId": {
            "type": "string",
            "description": "The ID of the todo to complete"
          }
        },
        "required": ["todoId"]
      },
      "output": {
        "type": "object",
        "properties": {
          "success": { "type": "boolean" },
          "completedAt": { "type": "string", "format": "date-time" }
        }
      },
      "estimatedDuration": "instant",
      "tags": ["write", "update"]
    },
    {
      "id": "delete_todo",
      "description": "Permanently delete a todo item",
      "input": {
        "type": "object",
        "properties": {
          "todoId": {
            "type": "string",
            "description": "The ID of the todo to delete"
          }
        },
        "required": ["todoId"]
      },
      "confirm": true,
      "estimatedDuration": "instant",
      "tags": ["write", "destructive"]
    },
    {
      "id": "bulk_complete",
      "description": "Mark multiple todo items as completed at once",
      "input": {
        "type": "object",
        "properties": {
          "todoIds": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1,
            "maxItems": 100,
            "description": "Array of todo IDs to complete"
          }
        },
        "required": ["todoIds"]
      },
      "output": {
        "type": "object",
        "properties": {
          "completed": { "type": "integer" },
          "failed": { "type": "integer" }
        }
      },
      "async": true,
      "estimatedDuration": "1-5s",
      "tags": ["write", "bulk"]
    }
  ],
  "observations": [
    {
      "id": "todo_list",
      "description": "Current state of all visible todo items, reflecting active filters",
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "title": { "type": "string" },
            "completed": { "type": "boolean" },
            "priority": { "type": "string", "enum": ["low", "medium", "high"] },
            "dueDate": { "type": "string", "format": "date" },
            "createdAt": { "type": "string", "format": "date-time" }
          }
        }
      },
      "updateFrequency": "on-change"
    },
    {
      "id": "active_filter",
      "description": "Currently active filter applied to the todo list",
      "schema": {
        "type": "object",
        "properties": {
          "status": { "type": "string", "enum": ["all", "active", "completed"] },
          "priority": { "type": "string", "enum": ["all", "low", "medium", "high"] }
        }
      },
      "updateFrequency": "on-change"
    },
    {
      "id": "stats",
      "description": "Summary statistics for the todo list",
      "schema": {
        "type": "object",
        "properties": {
          "total": { "type": "integer" },
          "active": { "type": "integer" },
          "completed": { "type": "integer" },
          "overdue": { "type": "integer" }
        }
      },
      "updateFrequency": "on-change"
    }
  ],
  "activation": {
    "routes": ["/todos", "/todos/**"]
  },
  "metadata": {
    "maxTodos": 1000,
    "supportedPriorities": ["low", "medium", "high"]
  }
}
```

---

## Appendix C: Relationship to Existing Standards

| Standard | Relationship to OUI |
|----------|-------------------|
| [OpenAPI](https://spec.openapis.org/oas/latest.html) | Complementary. OpenAPI describes HTTP APIs; OUI describes UI capabilities. An app may expose both. |
| [JSON Schema](https://json-schema.org/) | Foundation. OUI uses JSON Schema for all input/output/observation type definitions. |
| [JSON-RPC](https://www.jsonrpc.org/specification) | Inspiration. OUI's request/result correlation is similar to JSON-RPC's `id` field, but OUI adds lifecycle (registration, observations). |
| [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) | Inspiration. LSP's capability negotiation and typed messages influenced OUI's protocol design. |
| [Web Components](https://developer.mozilla.org/en-US/docs/Web/API/Web_components) | Orthogonal. Web Components define UI encapsulation at the DOM level; OUI defines semantic capability exposure at the agent level. |
| [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) | Related. MCP defines tools/resources for LLMs in a server context. OUI is specifically designed for UI surfaces with lifecycle, activation, and real-time observations. |
| [WAI-ARIA](https://www.w3.org/WAI/ARIA/apg/) | Complementary. ARIA describes UI semantics for assistive technology; OUI describes UI capabilities for agent technology. |

---

*End of specification.*
