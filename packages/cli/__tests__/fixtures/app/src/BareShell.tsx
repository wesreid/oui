import type { ReactNode } from 'react';
import { Button } from '@closurestudio/ui';

/** A frame whose control is not bound. */
export function BareShell({ children }: { children?: ReactNode }) {
  return (
    <div>
      <Button onClick={() => {}}>Sign out</Button>
      {children}
    </div>
  );
}
