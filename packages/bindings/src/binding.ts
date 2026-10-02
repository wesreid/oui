/**
 * The semantic binding a design-system control carries (ADR-0220 §2.2): what
 * the control means, in the user's terms, declared where the page uses it.
 *
 * It uses a room catalog entry's vocabulary (`RoomEntryInfo`'s id, title and
 * description; `ActionEffect`; `destructive`), so to the generator a page
 * control and a room entry look the same. What is never written: the input
 * schema, which is derived from the control's own props, and where the control
 * is, which the generator derives from the page's component tree.
 */

import type { ActionEffect } from './effect.js';
import type { AgentBinding, AgentItem, AgentProp, NonAgentBinding } from '@ouispec/contract';

// The binding's shapes are the contract's (`agent-binding.json`), generated from its schema.
export type { AgentBinding, AgentItem, AgentProp, NonAgentBinding };

/**
 * What using the control does.
 * @deprecated Since 0.8: the one vocabulary is `ActionEffect` (ADR-0226 §2.6). Kept for one minor.
 */
export type BindingEffect = ActionEffect;

/**
 * The `agent` prop of a composite with several callbacks (a card with open,
 * duplicate and delete): one binding per slot, and the row they all belong to.
 */
export type AgentSlots<Slot extends string> = { item?: AgentItem } & { [K in Slot]?: AgentProp };

/**
 * One slot's binding of a composite's `agent` prop, with the row the whole
 * composite is (a card's voice, a missing font's replacements) carried into
 * it. A composite registers each slot with this, never with `agent?.slot`:
 * the generator reads `item` beside the slots, so a slot registered without
 * it is a row-keyed action whose rows the page never reports.
 */
export function slotBinding<Slot extends string>(
  slots: AgentSlots<Slot> | undefined | null,
  slot: Slot,
): AgentProp | undefined {
  const prop = slots?.[slot] as AgentProp | undefined;
  if (!prop || isNonAgent(prop) || !slots?.item || prop.item) return prop;
  return { ...prop, item: slots.item };
}

export function isNonAgent(prop: AgentProp | undefined | null): prop is NonAgentBinding {
  return !!prop && typeof (prop as NonAgentBinding).nonAgent === 'string';
}

export function isAgentBinding(prop: unknown): prop is AgentBinding {
  return (
    !!prop &&
    typeof prop === 'object' &&
    typeof (prop as AgentBinding).id === 'string' &&
    typeof (prop as AgentBinding).description === 'string'
  );
}

/** Dotted lower-kebab segments, at least two: `area.control`. */
export const BINDING_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Longest tool name assistant runtimes accept. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** The tool name for a binding or room entry id: `voices.detail.engine` → `voices_detail_engine`. */
export function toolName(id: string): string {
  return id.replace(/[.\-/]/g, '_');
}

/** Why an id is not a valid binding id, or null. */
export function bindingIdProblem(id: string): string | null {
  if (!BINDING_ID_PATTERN.test(id)) {
    return `"${id}" must be dotted lower-kebab with at least two segments, like "voices.library"`;
  }
  if (toolName(id).length > MAX_TOOL_NAME_LENGTH) {
    return `"${id}" makes a tool name longer than ${MAX_TOOL_NAME_LENGTH} characters`;
  }
  return null;
}
