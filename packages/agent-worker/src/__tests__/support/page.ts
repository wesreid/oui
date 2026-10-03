/**
 * Test support: the page as the worker holds it, from surfaces written out in
 * full. A client that sends definitions gives the worker the same page, and
 * the definitions to describe its actions from (ui/page-index.ts).
 */
import type { OUISurface } from 'oui-spec/spec';
import { pageFromSurfaces, type HeldDefinitions, type PageSurface } from '../../ui/page-index.js';

/** The page for `surfaces`, with their definitions kept in `held`. */
export function pageOf(surfaces: readonly OUISurface[], held: HeldDefinitions = new Map()): PageSurface[] {
  return pageFromSurfaces(surfaces as OUISurface[], held);
}

/** A model's call of one action of the page, as it makes it: through `ui_act`. */
export function act(action: string, input: Record<string, unknown> = {}): { toolName: 'ui_act'; input: { action: string; input: Record<string, unknown> } } {
  return { toolName: 'ui_act', input: { action, input } };
}
