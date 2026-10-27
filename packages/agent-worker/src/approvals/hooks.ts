/**
 * The host's say over an approval before it is asked for: whether the call
 * may be asked for at all, and the words the person is shown and told.
 *
 * - **`validateBeforeApproval`** checks a call before it is read back. A
 *   booking for a time the product never offered is refused here, and the
 *   model is told why as the call's error and can correct it, instead of the
 *   person approving a readback the tool then refuses.
 * - **`preview`** writes the approval's display copy: what the card shows, the
 *   readback a conversation channel reads or sends, and the readback a voice
 *   speaks. A host redacts a value there (an account number, a phone number),
 *   or writes it in the person's language, with dates, times and numbers as
 *   words. The call that runs is still exactly the model's: the approval store
 *   keeps the original arguments, and the args hash it is bound to is theirs.
 *   Only the preview stored with it, sent to the room and spoken is the
 *   host's.
 *
 * Both fail closed. A validator that throws refuses the call; a preview hook
 * that throws, or returns something that is not a preview, means the approval
 * cannot be asked for, so the call is not run. Falling back to the built
 * preview would show the very values a redacting host removed.
 */
import { APPROVAL_PREVIEW_LIMITS as L, type ApprovalPreview } from '@ouispec/agent-core';
import type { RegisteredTool } from '../tools/types.js';
import type { AgentTurnChannel, AgentTurnInfo } from '../runtime/turn-info.js';

/** What a host's approval hooks are told of the call's turn. */
export interface ApprovalHookContext {
  turn: AgentTurnInfo;
  /** How the turn reached the runtime: `turn.channel`. */
  channel: AgentTurnChannel;
  /**
   * The language to write the person's copy in, as a BCP 47 tag: the
   * language their message was recognised in (on a call, the request's
   * `input.language`). Null when the turn does not say: a typed message.
   */
  locale: string | null;
  userId: string;
  accountId: string;
  conversationId: string;
}

/** What `approvals.preview` is told: the turn, and the preview the SDK built from the action's declaration. */
export interface ApprovalPreviewContext extends ApprovalHookContext {
  /** The SDK's preview, built from the declaration and the call's raw arguments. */
  built: ApprovalPreview;
}

/**
 * Writes an approval's display copy. Return the preview to store, show and
 * read back: `readback` for the card's line and for text channels,
 * `spokenReadback` for a voice (the live-call handler speaks it in place of
 * `readback`). Return `built` unchanged to keep the SDK's.
 */
export type ApprovalPreviewHook = (
  tool: RegisteredTool,
  args: Record<string, unknown>,
  ctx: ApprovalPreviewContext,
) => ApprovalPreview | Promise<ApprovalPreview>;

/** Whether a call may be asked for: `{ ok: false, error }` refuses it, and `error` is the model's to read. */
export type ApprovalValidation = { ok: true } | { ok: false; error: string };

/** Checks a call that needs approval before its readback is shown or spoken. */
export type ValidateBeforeApproval = (
  tool: RegisteredTool,
  args: Record<string, unknown>,
  ctx: ApprovalHookContext,
) => ApprovalValidation | Promise<ApprovalValidation>;

/** The approval hooks the orchestrator runs. */
export interface ApprovalHooks {
  preview?: ApprovalPreviewHook;
  validateBeforeApproval?: ValidateBeforeApproval;
}

/** The longest refusal a validator's error is given to the model as. */
export const MAX_VALIDATION_ERROR_CHARS = 2_000;

/** A validator's answer as the orchestrator acts on it: refused with the model's reason, or not. */
export function readValidation(value: unknown): ApprovalValidation {
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === true) return { ok: true };
  const error = value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false && typeof error === 'string' && error.trim()) {
    return { ok: false, error: error.trim().slice(0, MAX_VALIDATION_ERROR_CHARS) };
  }
  return { ok: false, error: 'It could not be checked, so it was not asked for.' };
}

/**
 * A host's preview, checked against what the approval store accepts: the
 * preview, or why it is not one.
 */
export function readHostPreview(value: unknown): { ok: true; preview: ApprovalPreview } | { ok: false; error: string } {
  const refuse = (error: string) => ({ ok: false as const, error });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('it is not an object');
  const v = value as Record<string, unknown>;
  const text = (field: string, max: number, required: boolean, nonBlank = false): string | null => {
    const s = v[field];
    if (s === undefined && !required) return null;
    if (typeof s !== 'string') return `${field} must be a string`;
    if (s.length > max) return `${field} is longer than ${max} characters`;
    if (nonBlank && !s.trim()) return `${field} is blank`;
    return null;
  };
  const problem =
    text('title', L.title, true, true) ??
    text('consequence', L.consequence, false) ??
    text('readback', L.readback, true, true) ??
    text('spokenReadback', L.readback, false, true);
  if (problem) return refuse(problem);
  const args = v.arguments;
  if (!Array.isArray(args)) return refuse('arguments must be a list');
  if (args.length > L.arguments) return refuse(`arguments holds more than ${L.arguments} entries`);
  for (const [i, a] of args.entries()) {
    const entry = a as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return refuse(`arguments[${i}] is not an object`);
    if (typeof entry.name !== 'string' || !entry.name || entry.name.length > L.argumentName) return refuse(`arguments[${i}].name must be 1–${L.argumentName} characters`);
    if (typeof entry.label !== 'string' || !entry.label || entry.label.length > L.argumentLabel) return refuse(`arguments[${i}].label must be 1–${L.argumentLabel} characters`);
    if (typeof entry.value !== 'string' || entry.value.length > L.argumentValue) return refuse(`arguments[${i}].value must be a string of at most ${L.argumentValue} characters`);
  }
  const known = new Set(['title', 'consequence', 'arguments', 'readback', 'spokenReadback']);
  const unknown = Object.keys(v).filter((k) => !known.has(k));
  if (unknown.length > 0) return refuse(`it has fields a preview does not: ${unknown.join(', ')}`);
  return {
    ok: true,
    preview: {
      title: v.title as string,
      ...(typeof v.consequence === 'string' ? { consequence: v.consequence } : {}),
      arguments: (args as Array<Record<string, string>>).map((a) => ({ name: a.name, label: a.label, value: a.value })),
      readback: v.readback as string,
      ...(typeof v.spokenReadback === 'string' ? { spokenReadback: v.spokenReadback } : {}),
    },
  };
}
