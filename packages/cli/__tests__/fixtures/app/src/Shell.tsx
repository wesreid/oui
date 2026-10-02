import type { ReactNode } from 'react';
import { Button } from '@closurestudio/ui';

/** The app's frame: on every page, whatever page is open. */
export function Shell({ children }: { children?: ReactNode }) {
  return (
    <div>
      <Button agent={{ id: 'shell.assistant', description: 'Open the assistant panel' }} onClick={() => {}}>
        Assistant
      </Button>
      {children}
    </div>
  );
}
