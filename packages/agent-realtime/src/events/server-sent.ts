/**
 * The events only the server's own routes send, each with the state that
 * makes it true: a conversation's take-over, hand-back and messages (with the
 * hold), and the grant or decline of an approval given in a conversation
 * channel (with the decision). `/api/emit` refuses them, and so does
 * a client's relay, whatever its rules allow: an event never says a
 * conversation changed hands, or that the person approved, when they did not.
 */
import { APPROVAL_PUSH_EVENTS, CONVERSATION_EVENTS } from '@ouispec/agent-core';

export const SERVER_SENT_EVENTS: ReadonlySet<string> = new Set<string>([...Object.values(CONVERSATION_EVENTS), ...Object.values(APPROVAL_PUSH_EVENTS)]);

/** Which of the server's routes sends a server-sent event, for the refusal. */
export function serverSentBy(event: string): string | null {
  if ((Object.values(CONVERSATION_EVENTS) as string[]).includes(event)) return "the server's conversation routes (/internal/conversations/…)";
  if ((Object.values(APPROVAL_PUSH_EVENTS) as string[]).includes(event)) return "the approval store, with the person's decision";
  return null;
}
