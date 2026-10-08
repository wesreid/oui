/**
 * For a host that fits its stored history before a turn, or hands back the
 * messages a turn stored (`@ouispec/agent-worker/history`).
 *
 * A module of its own, with nothing the turn runtime needs: a host's history
 * code, and its tests, load this without loading the model SDK. It also answers
 * a CommonJS resolver (`default`), which the package's other entries do not.
 */
import type { TurnHistoryMessage, TurnMessage } from './types.js';

export { answerWithoutState, STATE_AT_END } from './ui/page-state-at-end.js';

/**
 * What a host hands back as history for the messages a turn stored: the
 * worker's own `TurnMessage`s, in the `TurnHistoryMessage` form `getHistory`
 * returns. A host that keeps the turn's messages as they were given needs
 * nothing else; one that stores them in its own shape maps them the same way.
 */
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
