/**
 * What a turn is held to on a channel: its general expectation and its
 * channel's, as one.
 */
import type { AgentEvalExpectation } from '@ouispec/contract';

/** A turn's general expectation and its channel's, as one: lists joined, the channel's single values winning. */
export function mergeExpectations(general?: AgentEvalExpectation, channel?: AgentEvalExpectation): AgentEvalExpectation {
  if (!general) return channel ?? {};
  if (!channel) return general;
  const lists = ['says', 'mustNotSay', 'toolCalled', 'toolNotCalled', 'doesNotStore', 'calls'] as const;
  const merged: Record<string, unknown> = { ...general, ...channel };
  for (const key of lists) {
    const joined = [...(general[key] ?? []), ...(channel[key] ?? [])];
    if (joined.length > 0) merged[key] = joined;
  }
  return merged as AgentEvalExpectation;
}
