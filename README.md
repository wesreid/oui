# OUI — Open UI Specification

**The machine-readable contract for agent-controllable user interfaces.**

> *"Oui"* — French for "yes." As in: yes, an AI agent can control this UI.

---

## What is OUI?

OUI is a specification and runtime protocol that allows any UI application to declare a **semantic control surface** — a typed, machine-readable API for its capabilities — that AI agents can discover and invoke programmatically.

It is the UI equivalent of [OpenAPI](https://www.openapis.org/). Where OpenAPI describes what an HTTP API can do, OUI describes what a user interface can do.

```
OpenAPI Spec  + HTTP Server  = any client can consume the API
OUI Manifest  + UI App       = any agent can control the UI
```

## Why?

AI agents that control UIs today rely on:
- **Computer vision** — screenshot the screen, identify elements, click coordinates
- **DOM scraping** — find elements by CSS selector, simulate clicks/keystrokes
- **Brittle heuristics** — break when layout changes, slow, unreliable

OUI takes a different approach: **the app declares what it supports.** The agent doesn't need to see pixels or parse HTML. It invokes typed, semantic actions and receives structured results.

| | Vision/DOM Approach | OUI Approach |
|--|---------------------|-------------|
| Discovery | Infer from screenshots or HTML | App declares capabilities |
| Actions | Click (x, y), type "hello" | `invoke('create_document', { title: 'hello' })` |
| Feedback | "Did the screen change?" | `{ success: true, documentId: 'abc' }` |
| Reliability | Breaks on layout/style changes | Stable semantic contract |
| Efficiency | Multiple screenshots + vision model | Single typed function call |
| Complex flows | 47 simulated interactions | One composite action |
| Consent | Accesses everything visible | App controls what's exposed |

## Core Concepts

### 1. Surface

A **Surface** is a controllable boundary within an application. It declares:
- **Actions** — operations the agent can invoke (with typed inputs and outputs)
- **Observations** — state the agent can read (with typed schemas)
- **Activation conditions** — when this surface is available

### 2. Action

An **Action** is a single operation the agent can perform. It has:
- A unique identifier
- A description (for LLM context)
- An input schema (JSON Schema — what params it accepts)
- An output schema (what the result looks like)
- A handler (the actual implementation)

### 3. Observation

An **Observation** is a piece of application state the agent can read. It updates in real-time as the app state changes, giving the agent situational awareness without needing screenshots.

### 4. Manifest

A **Manifest** is the complete declaration of a surface — its actions, observations, and metadata. This is what the agent runtime reads to generate tools and understand the application.

## Example

```typescript
import { defineSurface } from '@oui/core';

export const todoSurface = defineSurface({
  id: 'todo-app',
  description: 'A simple todo list application',

  actions: [
    {
      id: 'add_todo',
      description: 'Add a new todo item to the list',
      input: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The todo text' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['title'],
      },
      output: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          created: { type: 'boolean' },
        },
      },
      handler: async (params) => {
        const todo = await createTodo(params.title, params.priority);
        return { id: todo.id, created: true };
      },
    },
    {
      id: 'mark_complete',
      description: 'Mark a todo item as completed',
      input: {
        type: 'object',
        properties: {
          todoId: { type: 'string' },
        },
        required: ['todoId'],
      },
      handler: async (params) => {
        await completeTodo(params.todoId);
        return { success: true };
      },
    },
  ],

  observations: [
    {
      id: 'todo_list',
      description: 'Current state of all todos',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            completed: { type: 'boolean' },
            priority: { type: 'string' },
          },
        },
      },
    },
  ],
});
```

An agent consuming this surface sees two tools (`add_todo`, `mark_complete`) and one observation (`todo_list`). It can invoke actions and read state without any knowledge of the app's DOM, styling, or framework.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Agent Runtime                        │
│  (Closure Agent SDK, LangChain, AutoGPT, etc.)  │
│                                                  │
│  Reads manifests → generates tools → invokes     │
├─────────────────────────────────────────────────┤
│              OUI Protocol                        │
│  (manifest exchange, action execution, results)  │
├────────────────────┬────────────────────────────┤
│  UI Surface A      │  UI Surface B              │
│  (React app)       │  (Vue app)                 │
│                    │                            │
│  defineSurface()   │  defineSurface()           │
│  actions + obs     │  actions + obs             │
└────────────────────┴────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@oui/spec` | TypeScript types + JSON Schema for the OUI specification |
| `@oui/core` | `defineSurface()`, manifest validation, protocol types |
| `@oui/react` | React bindings — `useSurface()` hook, `SurfaceProvider` |
| `@oui/vue` | Vue bindings (planned) |
| `@oui/svelte` | Svelte bindings (planned) |
| `@oui/transport` | Protocol transport layer (WebSocket, postMessage, etc.) |
| `@oui/devtools` | Inspector/debugger for surfaces in development |

## Relationship to OpenAPI

OUI and OpenAPI are complementary:

- **OpenAPI** describes HTTP endpoints — request/response over the network
- **OUI** describes UI capabilities — actions/observations within an application

An application might expose BOTH: an OpenAPI spec for its REST API and an OUI manifest for its UI. An agent that needs to "use the app" consumes the OUI surface. An agent that needs to "call the API" consumes the OpenAPI spec.

## Principles

1. **App-declared, not inferred.** The application explicitly states what it supports. Agents don't guess from pixels or DOM.
2. **Semantic, not structural.** Actions are named operations ("create_document"), not DOM paths ("click #btn-create").
3. **Typed end-to-end.** Inputs and outputs have JSON Schema. The agent knows exactly what to send and what to expect.
4. **Bidirectional.** Actions return results. The agent knows what happened — not just that something was dispatched.
5. **Framework-agnostic.** The spec works with React, Vue, Svelte, vanilla JS, native apps — anything that can declare actions and handle invocations.
6. **Consent-based.** The app controls what's exposed. Users and developers decide what agents can do.
7. **Observable.** The agent can read relevant state without screenshots. The app pushes state changes.
8. **Composable.** Multiple surfaces can coexist. A complex app exposes many surfaces (one per feature/page).

## Status

🚧 **Early development.** The spec is being designed alongside the [Closure Agent SDK](https://github.com/closurestudio/closure-agent-sdk), which will be the first runtime to consume OUI surfaces.

## License

MIT
