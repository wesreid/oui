import { readMessageInput, type AgentConversationSummary, type MessageInput } from '@ouispec/agent-core';

/** `value` as an input this SDK recognises, as a field to spread: none when it is not one. */
function inputField<K extends string>(key: K, value: unknown): Partial<Record<K, MessageInput>> {
  const input = readMessageInput(value);
  return input ? ({ [key]: input } as Record<K, MessageInput>) : {};
}

/**
 * A listed conversation as the SDK hands it on (ADR-0259 §2.6): how its
 * preview's message was entered (`previewInput`), and each search match's
 * message (`input`), kept only when the SDK recognises it, as a stored
 * message's `input` is. The platform stored it from what a browser sent, so an
 * unknown mode or a malformed language is dropped and the message reads as
 * typed. Every other field is the platform's, unchanged.
 */
export function readConversationSummary(summary: AgentConversationSummary): AgentConversationSummary {
  const { previewInput, matches, ...rest } = summary;
  return {
    ...rest,
    ...inputField('previewInput', previewInput),
    ...(matches
      ? {
          matches: matches.map(({ input, ...match }) => ({ ...match, ...inputField('input', input) })),
        }
      : {}),
  };
}

/** `readConversationSummary` over a page of conversations. */
export function readConversationSummaries(summaries: readonly AgentConversationSummary[]): AgentConversationSummary[] {
  return summaries.map(readConversationSummary);
}
