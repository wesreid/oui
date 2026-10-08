/**
 * What the server checks of a declared event, on emit and on relay: that it
 * is declared, that its payload passes its schema, and that each room is one
 * it is declared for. One reading of the declarations for both doors.
 */
import type { EventCatalog } from '@ouispec/agent-events';
import { createPayloadValidator, type PayloadValidator } from '@ouispec/agent-events/validate';

export interface DeclaredEvents {
  catalog: EventCatalog;
  validator: PayloadValidator;
}

export function createDeclaredEvents(catalog: EventCatalog): DeclaredEvents {
  return { catalog, validator: createPayloadValidator(catalog) };
}

/** The rooms an event is declared for, as its patterns. */
function declaredRooms(events: DeclaredEvents, event: string): string {
  return events.catalog
    .get(event)!
    .rooms.map((r) => r.pattern ?? `the ${r.name}'s room`)
    .join(', ');
}

/**
 * Why `data` may not be sent as `event` to `rooms`, or null when it may.
 * `noun` names the data as the caller knows it: an emit's payload, a relay's data.
 */
export function declaredRefusal(
  events: DeclaredEvents,
  event: string,
  data: unknown,
  rooms: readonly string[],
  noun: 'payload' | 'data',
): string | null {
  if (!events.catalog.has(event)) return `event "${event}" is not declared`;
  if (rooms.length === 0) {
    return `"${event}" is declared for ${declaredRooms(events, event)}; name its rooms, a declared event is never broadcast`;
  }
  for (const room of rooms) {
    if (!events.catalog.allowsRoom(event, room)) {
      return `"${event}" may not go to ${room}; it is declared for ${declaredRooms(events, event)}`;
    }
  }
  const problems = events.validator.problems(event, data);
  return problems.length > 0 ? `invalid "${event}" ${noun}: ${problems.join('; ')}` : null;
}
