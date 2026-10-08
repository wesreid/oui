/**
 * A conversation's people as the chat shows them (ADR-0260 §2.7): one reading
 * of a person's message, and of a take-over or hand-back, for the customer's
 * view and the staff console alike.
 */
import type { ConversationHold, ConversationMessage, TakeoverChange } from '@ouispec/agent-core';
import type { AgentMessage } from './types.js';

/** A message of the conversation as the chat shows it; a person's carries who wrote it. */
export function staffAgentMessage(message: ConversationMessage): AgentMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: Date.parse(message.createdAt) || Date.now(),
    ...(message.speaker ? { speaker: message.speaker } : {}),
  };
}

/** Where the conversation changed hands, as a message with no content. */
export function conversationChangeMessage(change: TakeoverChange, hold: ConversationHold, at: number): AgentMessage {
  return {
    id: `${change}_${hold.conversationId}_${hold.since}`,
    role: 'staff',
    content: null,
    timestamp: at,
    speaker: hold.holder,
    takeover: change,
  };
}
