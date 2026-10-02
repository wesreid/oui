import { useRoomRegistration } from '@ouispec/bindings/react';
import { DEMO_CATALOG } from '@closurestudio/demo-room';
import { useBoard } from '../useBoard';

export function StudioPage() {
  useRoomRegistration(DEMO_CATALOG, {} as never);
  useBoard();
  return null;
}
