/**
 * The app's router, as small as the generator needs: it reads `<Route>`
 * elements by their `path` and `element` (ADR-0226 §2.4).
 */
import type { ReactElement, ReactNode } from 'react';

export function Routes({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Route(_props: { path: string; element: ReactElement }) {
  return null;
}
