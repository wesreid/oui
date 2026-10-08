/**
 * What a host hands back as history for the messages a turn stored: the
 * worker's own `TurnMessage`s, in the `TurnHistoryMessage` form `getHistory`
 * returns. A host that keeps the turn's messages as they were given needs
 * nothing else; one that stores them in its own shape maps them the same way.
 */
import type { TurnHistoryMessage, TurnMessage } from './types.js';

export function historyOf(messages: readonly TurnMessage[]): TurnHistoryMessage[] {
  return messages.map((m): TurnHistoryMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
        ...(m.stopped ? { stopped: m.stopped } : {}),
      };
    }
    return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId ?? '', ...(m.name ? { name: m.name } : {}) };
  });
}
