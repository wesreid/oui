/**
 * A turn's events, seen by its host as they are sent.
 *
 * A turn streams to its realtime room. A host that also answers the turn's
 * caller directly (the live-call handler, which streams the reply back on the
 * HTTP response) sees the same events, as the turn emits them: one stream of
 * events, two destinations, and no second model call.
 */
import type { RealtimeEmitAdapter } from './types.js';

/** Called with each event a turn emits, before it is sent to the room. */
export type TurnEventObserver = (event: string, data: unknown) => void;

/**
 * `adapter`, also handing each event to `observe` first. The observer is
 * called synchronously and never delays or fails the send: what it throws is
 * given to `onObserverError`, and the event still goes to the room.
 */
export function teeEmitAdapter(
  adapter: RealtimeEmitAdapter,
  observe: TurnEventObserver,
  onObserverError: (error: unknown, event: string) => void,
): RealtimeEmitAdapter {
  return {
    emit(room, event, data) {
      try {
        observe(event, data);
      } catch (error) {
        onObserverError(error, event);
      }
      return adapter.emit(room, event, data);
    },
  };
}
