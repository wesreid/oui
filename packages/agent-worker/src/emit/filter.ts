/**
 * The host's filter on a turn's events: what leaves the runtime, decided by
 * the host before anything else sees it.
 *
 * A turn's events go to its realtime room, and to a host that observes them
 * (the live-call handler speaks the reply from them, emit/tee.ts). A host that
 * must redact what a turn sends (a card number in a tool call's input, a
 * phone number in a readback) or hold some of it back filters here, once:
 * the room, the observer and the call all receive what the filter returns,
 * and nothing receives what it drops.
 *
 * The filter is synchronous, so events keep the order the turn emitted them
 * in. It is given a copy of each payload, so what it changes reaches no other
 * part of the turn. A filter that throws, or returns something that is not a
 * payload, fails closed: the event is dropped and the failure logged. A
 * redaction that fails must never send what it was there to remove.
 */
import type { RealtimeEmitAdapter } from './types.js';

/** Decides what of one turn event leaves the runtime: the payload to send, changed or not, or null to send nothing. */
export type TurnEventFilter = (event: string, data: Record<string, unknown>) => Record<string, unknown> | null;

/** `adapter`, sending each event as `filter` returns it, and nothing it drops. */
export function filterEmitAdapter(
  adapter: RealtimeEmitAdapter,
  filter: TurnEventFilter,
  onFilterError: (error: unknown, event: string) => void,
): RealtimeEmitAdapter {
  return {
    emit(room, event, data) {
      let kept: unknown;
      try {
        // Every turn event's payload is a JSON object.
        kept = filter(event, structuredClone(data) as Record<string, unknown>);
      } catch (error) {
        onFilterError(error, event);
        return Promise.resolve();
      }
      if (kept === null) return Promise.resolve();
      if (!isPayload(kept)) {
        onFilterError(new Error(`the filter returned ${kept === undefined ? 'undefined' : typeof kept}, not a payload or null`), event);
        return Promise.resolve();
      }
      return adapter.emit(room, event, kept);
    },
  };
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
