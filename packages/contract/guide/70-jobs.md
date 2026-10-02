## Work that outlives the call: the job effect

A binding or room action whose work finishes later — a render, an export, an order that fills — declares `effect: { kind: 'job', estimatedDuration?, timeoutMs? }`, and its handler returns `{ ok: true, pending: { jobId } }`. The action is reported `started` at once, then settles on the job's outcome: `complete` when its completion arrives, `failed` when its failure does, and after `timeoutMs` (default five minutes) a `timeout` failure, never a late success. With no tracker, or no job id, it is `unverified`: started, but not confirmable from the page. Three rules make this hold, and the kit checks the first: every `run` returns its callback's result; a job is tracked at dispatch, not at the first poll; a disabled job control is still followed.

`transaction` settles the same way.

<!-- schema: action-effect.json -->

<!-- schema: action-effect.json#/$defs/JobSettlement -->

### A job tracker from the product's declared events

The tracker is the seam between the product's events and its actions. Build it from the product's event declarations (ADR-0227 §2.4) rather than by hand: each event's payload schema, the rooms it goes to, the field that names the job, and whether it completes or fails a kind of job.

```ts
import { createEventCatalog } from '@ouispec/agent-events';
import { createDeclaredJobTracker } from '@ouispec/bindings/oui';
import declarations from './events.json';

export const jobTracker = createDeclaredJobTracker({
  events: createEventCatalog(declarations),
  source: socket,       // { subscribe(rooms), unsubscribe(rooms), on(event, handler) }
  kind: 'report',       // the declared job kind a job id names
});
```

It joins the room the completion declares for one job (`report:{jobId}`), and settles on the declared completion with its declared result fields, or on the declared failure with its declared reason. Work no declared kind describes (work the tab does itself) plugs in as a `JobTrackerExtension`, which may read declared events only. An event name the declarations do not hold fails where it is used: the realtime server refuses it, the worker refuses the tool, the tracker refuses to start.

<!-- schema: event-declarations.json -->

<!-- schema: event-declarations.json#/$defs/EventDeclaration -->
