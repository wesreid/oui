import { useRoomRegistration } from '@ouispec/bindings/react';
import type { RoomCatalogData } from '@ouispec/bindings';

// A generic hook: which catalog it registers is its caller's.
export function useRoom(catalog: RoomCatalogData) {
  useRoomRegistration(catalog, { run: () => ({ ok: true }), observations: {}, problems: [] });
}
