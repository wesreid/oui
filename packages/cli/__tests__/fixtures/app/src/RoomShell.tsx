import type { ReactNode } from 'react';
import { Button } from '@closurestudio/ui';

import { SITE_CATALOG } from './site-actions';
import { useBoard } from './useBoard';
import { useRoom } from './useRoom';

/** A frame that holds rooms open on every page: one of its own, and one a page also registers. */
export function RoomShell({ children }: { children?: ReactNode }) {
  useRoom(SITE_CATALOG);
  useBoard();
  return (
    <div>
      <Button agent={{ id: 'shell.assistant', description: 'Open the assistant panel' }} onClick={() => {}}>
        Assistant
      </Button>
      {children}
    </div>
  );
}
