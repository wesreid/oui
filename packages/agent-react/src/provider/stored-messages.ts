import {
  displayedToolCall,
  isTakeoverChange,
  readMessageInput,
  readStaffSpeaker,
  turnStoppedNote,
  type AgentStoredMessage,
} from '@ouispec/agent-core';
import type { AgentMessage } from './types.js';

/** A stored tool result as the live stream carried it: parsed JSON when it is JSON. */
function parseResult(content: string | null): unknown {
  if (content == null) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * A stored conversation's messages as the panel shows a live one:
 *
 * - a user or assistant message with text becomes that message; a user
 *   message the person spoke keeps how it was entered (`input`, ADR-0259 §2.6);
 * - each tool an assistant message called becomes a completed tool message,
 *   in call order, as `intent_call` added it live: a UI action run through
 *   `ui_act` is shown as that action, as the live stream named it;
 * - a stored `tool` message fills in its call's result (by `toolCallId`, else
 *   the next call without one), so a `present_options` choice renders again;
 * - a person on the staff's message (ADR-0260 §2.5) is a `staff` message with
 *   its `speaker`; a take-over or hand-back is a `staff` message with
 *   `takeover` and no content. One that names no speaker is left out.
 *
 * Messages with no text and no tool calls are left out, as the live stream
 * drops empty assistant bubbles.
 */
export function storedToAgentMessages(stored: readonly AgentStoredMessage[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const awaitingResult: AgentMessage[] = [];

  for (const m of stored) {
    const timestamp = Date.parse(m.createdAt) || 0;
    if (m.role === 'user' || m.role === 'assistant') {
      // A stopped turn's last message keeps its mark; one that has only the mark
      // (the turn was stopped before it said anything) shows as stopped, with no text.
      const stopped = m.role === 'assistant' && m.stopped ? m.stopped.reason : undefined;
      const onlyTheMark = stopped !== undefined && m.content === turnStoppedNote({ reason: stopped });
      // A message may be files with no text.
      const attachments = m.role === 'user' && m.attachments?.length ? m.attachments : undefined;
      // Stored by the platform from what a browser sent: only what is recognised is shown.
      const input = m.role === 'user' ? readMessageInput(m.input) : null;
      if (m.content || stopped || attachments) {
        messages.push({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          content: onlyTheMark ? '' : (m.content ?? ''),
          timestamp,
          ...(stopped ? { stopped } : {}),
          ...(attachments ? { attachments } : {}),
          ...(input ? { input } : {}),
        });
      }
      for (const call of m.toolCalls ?? []) {
        const shown = displayedToolCall(call);
        const toolMessage: AgentMessage = {
          id: `tool_${call.id}`,
          role: 'tool',
          content: null,
          timestamp,
          toolCall: { id: call.id, name: shown.name, ...(shown.arguments ? { arguments: shown.arguments } : {}), status: 'complete' },
        };
        messages.push(toolMessage);
        awaitingResult.push(toolMessage);
      }
    } else if (m.role === 'staff') {
      const speaker = readStaffSpeaker(m.speaker);
      const takeover = isTakeoverChange(m.takeover) ? m.takeover : undefined;
      if (speaker && (takeover || m.content)) {
        messages.push({
          id: m.id,
          role: 'staff',
          content: takeover ? null : (m.content ?? ''),
          timestamp,
          speaker,
          ...(takeover ? { takeover } : {}),
        });
      }
    } else if (m.role === 'tool') {
      const index = m.toolCallId
        ? awaitingResult.findIndex(t => t.toolCall?.id === m.toolCallId)
        : 0;
      const target = index >= 0 ? awaitingResult.splice(index, 1)[0] : undefined;
      if (target?.toolCall) {
        target.toolCall = { ...target.toolCall, result: parseResult(m.content) };
      }
    }
  }
  return messages;
}
