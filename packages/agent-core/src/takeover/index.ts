/**
 * A person takes a conversation from the agent, and hands it back (ADR-0260
 * §2): the shapes every party exchanges, and what the model is told.
 *
 * While a person on the product's staff holds a conversation the agent does
 * not answer it. The person's messages and the take-over and hand-back are
 * stored by the product in the conversation, under the person's name, and the
 * agent's next turn reads them as the business's side of the conversation:
 * the person's words, not the agent's, and never the customer's.
 */
import { AGENT_CONVERSATION_EVENTS } from '@ouispec/agent-events';
import type { ConversationHold, ConversationMessage, StaffSpeaker, TakeoverChange } from '@ouispec/contract';

// The messages are the contract's (`conversation-takeover.json`), generated
// from its schema, so the realtime server, the worker, the product's API, both
// tabs and an engine in another language read one definition.
export type {
  AnnounceMessageRequest,
  AnnounceMessageResult,
  ConversationHandedBackEvent,
  ConversationHold,
  ConversationMessage,
  ConversationMessageEvent,
  ConversationMessageRole,
  ConversationRooms,
  ConversationTakenOverEvent,
  HandBackCause,
  HandBackRequest,
  HandBackResult,
  StaffSpeaker,
  TakeoverChange,
  TakeOverRequest,
  TakeOverResult,
} from '@ouispec/contract';

/** The conversation's events, as the platform declares them (`@ouispec/agent-events`). */
export const CONVERSATION_EVENTS = AGENT_CONVERSATION_EVENTS;

/** The longest a staff member's name or role reaches the model or a tab: the contract's bound. */
export const MAX_STAFF_LABEL_CHARS = 80;

/** The stored role of a person's message, and of a take-over or hand-back entry. */
export const STAFF_ROLE = 'staff';

/**
 * A name or role as it may stand inside a bracketed line the model reads: no
 * brackets, no line breaks, no runs of space, at most 80 characters. A product
 * names its staff, but the line around the name is the platform's.
 */
function labelPart(text: string): string {
  return text
    .replace(/[[\]\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STAFF_LABEL_CHARS);
}

/** "Jordan (Toyota of Quillhaven sales)", or "Jordan" when the speaker has no role. */
export function staffLabel(speaker: Pick<StaffSpeaker, 'displayName' | 'role'>): string {
  const name = labelPart(speaker.displayName) || 'A person';
  const role = speaker.role ? labelPart(speaker.role) : '';
  return role ? `${name} (${role})` : name;
}

/**
 * The line the model reads before a person's message: who wrote it, that the
 * words are theirs, and that they stand.
 */
export function staffMessageNote(speaker: Pick<StaffSpeaker, 'displayName' | 'role'>): string {
  return (
    `[${staffLabel(speaker)}, a person on the staff, wrote this to the customer while they held the conversation. ` +
    'These are their words, not yours; what they told the customer stands.]'
  );
}

/** The line the model reads where a person took the conversation over, or handed it back. */
export function takeoverNote(change: TakeoverChange, speaker: Pick<StaffSpeaker, 'displayName' | 'role'>): string {
  return change === 'taken_over'
    ? `[${staffLabel(speaker)}, a person on the staff, took this conversation over here. You did not answer while they held it.]`
    : `[${staffLabel(speaker)} handed the conversation back to you here. Answer the customer's next message yourself.]`;
}

// ─── Reading what arrives from the wire ─────────────────────────────────────

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null;

/** A staff speaker, when `value` is one; else null. Only the fields the contract names are kept. */
export function readStaffSpeaker(value: unknown): StaffSpeaker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const userId = text(v.userId, 200);
  const displayName = text(v.displayName, MAX_STAFF_LABEL_CHARS);
  if (!userId || !displayName) return null;
  const role = text(v.role, MAX_STAFF_LABEL_CHARS);
  return { userId, displayName, ...(role ? { role } : {}) };
}

/** A hold, when `value` is one; else null. */
export function readConversationHold(value: unknown): ConversationHold | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const conversationId = text(v.conversationId, 200);
  const holder = readStaffSpeaker(v.holder);
  if (!conversationId || !holder || typeof v.since !== 'number' || !Number.isFinite(v.since)) return null;
  return { conversationId, holder, since: v.since };
}

/** A conversation's message, when `value` is one; else null. A `staff` message must name its speaker. */
export function readConversationMessage(value: unknown): ConversationMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const id = text(v.id, 200);
  const createdAt = text(v.createdAt, 64);
  if (!id || !createdAt || typeof v.content !== 'string') return null;
  if (v.role !== 'user' && v.role !== 'assistant' && v.role !== 'staff') return null;
  const speaker = v.speaker === undefined ? null : readStaffSpeaker(v.speaker);
  if (v.role === 'staff' && !speaker) return null;
  return { id, role: v.role, content: v.content, createdAt, ...(speaker ? { speaker } : {}) };
}

/** Whether `value` names a change of hands the platform knows. */
export function isTakeoverChange(value: unknown): value is TakeoverChange {
  return value === 'taken_over' || value === 'handed_back';
}
