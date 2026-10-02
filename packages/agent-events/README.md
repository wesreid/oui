# @ouispec/agent-events

Event contracts the product declares. A product writes one declaration document: each event's payload schema, the rooms it goes to, its correlation fields and its role in a job. The platform follows it:

- the realtime server (`@ouispec/agent-realtime`) emits and relays declared events only;
- the worker's async tools (`@ouispec/agent-worker`) wait on a declared completion or failure;
- the UI's job tracker (`@ouispec/bindings/oui`) is built from it;
- a name the document doesn't hold fails the build.

```sh
npm install @ouispec/agent-events
```

```ts
import { createEventCatalog, PLATFORM_EVENTS } from '@ouispec/agent-events';
import declarations from './events.json' with { type: 'json' };

// The platform's own turn events, with the product's.
export const catalog = createEventCatalog(PLATFORM_EVENTS, declarations);
```

| Entry | What it has |
|---|---|
| `@ouispec/agent-events` | `createEventCatalog`, `validateEventDeclarations`, the room helpers, `PLATFORM_EVENTS`. Browser-safe. |
| `@ouispec/agent-events/validate` | Checks a payload against its declared schema. |
| `@ouispec/agent-events/codegen` | Generates the TypeScript for a declaration document. |
| `@ouispec/agent-events/schema.json` | The declaration document's JSON Schema, for editors and other languages. It is `@ouispec/contract`'s `event-declarations.json`. |

The `agent-sdk-events` CLI checks a document and generates its types:

```sh
npx agent-sdk-events check events.json
npx agent-sdk-events types events.json --out src/generated/events.ts [--check]
```

The declaration format is described in [the integrator guide](https://github.com/wesreid/oui/blob/main/packages/contract/INTEGRATOR-GUIDE.md).
