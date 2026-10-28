/**
 * What a tool's declaration says about approval, for every
 * kind of tool the worker runs: a UI action from the client's surfaces, a
 * generated API tool (its effect from the operation's `x-agent`), a host tool.
 * The rule itself is OUI's `requiresApproval` (through oui-bindings), which the browser applies too; a host's
 * policy may require approval of more, never of less.
 */
import { DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS, type ApprovalChannel } from '@ouispec/agent-core';
import { effectKind, requiresApproval } from '@ouispec/bindings';
import type { RegisteredTool, ToolEffect } from '../tools/types.js';

export interface ApprovalRequirement {
  effect: ToolEffect | undefined;
  destructive: boolean;
  /** Whether the declaration alone requires the user's approval of each call. */
  required: boolean;
  /** The effect as the approval store and its token name it: its kind, or `write` when none is declared. */
  effectName: string;
  /** How long an approval of it lasts. */
  ttlMs: number;
}

export function approvalRequirement(tool: RegisteredTool): ApprovalRequirement {
  const effect = tool.effect;
  const destructive = tool.destructive === true;
  const minutes = effect && typeof effect === 'object' && effect.kind === 'transaction' ? effect.approvalMinutes : undefined;
  return {
    effect,
    destructive,
    required: requiresApproval(effect, destructive),
    effectName: effect === undefined ? 'write' : effectKind(effect),
    ttlMs: minutes ? Math.min(minutes * 60_000, MAX_APPROVAL_TTL_MS) : DEFAULT_APPROVAL_TTL_MS,
  };
}

/** What the model reads on a tool whose calls need approval, in place of any "confirm first" instruction: in a UI, the card. */
export const APPROVAL_TOOL_NOTE =
  "Needs the user's approval: calling it shows them an approval card with exactly these arguments, and it runs only when " +
  'they approve it there. Call it directly when they ask for it. Do not ask for a yes in chat first, and never treat a typed ' +
  'yes as approval.';

/**
 * The same on a conversation channel (chat, SMS, voice, phone), where there is
 * no card: the customer is sent the readback, verbatim, and their next message
 * confirms it or not.
 */
export const READBACK_APPROVAL_TOOL_NOTE =
  "Needs the customer's confirmation: calling it sends them a readback of exactly these arguments, word for word, and it runs " +
  'only if they confirm that readback in their next message. Call it directly when they ask for it. Do not read the details ' +
  'back or ask for a yes yourself first, and never treat a yes given before the readback as confirmation.';

/**
 * A UI action on a conversation channel: the person's page runs it only on its
 * own grant, from a click on its card, so it is approved there and nowhere
 * else. A yes said or sent in the conversation does not approve it.
 */
export const SCREEN_APPROVAL_TOOL_NOTE =
  "Needs the user's approval on their screen: calling it shows them an approval card with exactly these arguments, and it runs " +
  'only when they approve it there. Call it directly when they ask for it, and tell them the card is on their screen. A yes ' +
  'they say or send in this conversation does not approve it.';

/** The conversation channels a voice reads the readback out on: it says the host's `spokenReadback` when there is one. */
export const VOICE_APPROVAL_CHANNELS: ReadonlySet<ApprovalChannel> = new Set<ApprovalChannel>(['voice', 'phone']);

/**
 * What the model reads on a tool whose calls need approval, for the turn's
 * channel: the card in a UI; the readback on a conversation channel; and, for
 * a UI action on a conversation channel, the card on the person's screen.
 */
export function approvalToolNote(channel: ApprovalChannel = 'ui', toolKind: RegisteredTool['kind'] = 'backend'): string {
  if (channel === 'ui') return APPROVAL_TOOL_NOTE;
  return toolKind === 'ui' ? SCREEN_APPROVAL_TOOL_NOTE : READBACK_APPROVAL_TOOL_NOTE;
}
