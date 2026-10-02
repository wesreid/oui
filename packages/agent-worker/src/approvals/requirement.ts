/**
 * What a tool's declaration says about approval (ADR-0228 §2.1), for every
 * kind of tool the worker runs: a UI action from the client's surfaces, a
 * generated API tool (its effect from the operation's `x-agent`), a host tool.
 * The rule itself is OUI's `requiresApproval` (through oui-bindings), which the browser applies too; a host's
 * policy may require approval of more, never of less.
 */
import { DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS } from '@ouispec/agent-core';
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

/** What the model reads on a tool whose calls need approval, in place of any "confirm first" instruction. */
export const APPROVAL_TOOL_NOTE =
  "Needs the user's approval: calling it shows them an approval card with exactly these arguments, and it runs only when " +
  'they approve it there. Call it directly when they ask for it. Do not ask for a yes in chat first, and never treat a typed ' +
  'yes as approval.';
