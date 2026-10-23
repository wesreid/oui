/**
 * A turn's progress as a view shows it: the model's thinking as it streams,
 * and one status for the assistant (working, waiting on the person, done, or
 * in trouble) with a line saying what it is doing. Pure: the provider holds the
 * state and feeds these the events.
 */
import { currentWorkStep, formatWorkStep, type ReasoningEvent, type TurnEndReason, type TurnStoppedReason } from '@ouispec/agent-core';
import type { AgentMessage, AgentReasoning, AgentStatus, AgentTurnEnd } from './types.js';

export const DEFAULT_PLANNING_TEXT = 'Planning…';

/** The thinking blocks, after one event of a block. A piece or an end of a block never started changes nothing. */
export function applyReasoningEvent(list: readonly AgentReasoning[], event: ReasoningEvent, now: number): AgentReasoning[] {
  const at = list.findIndex((r) => r.id === event.id);
  if (event.phase === 'start') {
    if (at !== -1) return list as AgentReasoning[];
    return [...list, { id: event.id, turnId: event.turnId, text: '', startedAt: now }];
  }
  if (at === -1) return list as AgentReasoning[];
  const block = list[at];
  const next =
    event.phase === 'delta'
      ? { ...block, text: block.text + (event.text ?? '') }
      : block.endedAt === undefined
        ? { ...block, endedAt: now }
        : block;
  if (next === block) return list as AgentReasoning[];
  const updated = [...list];
  updated[at] = next;
  return updated;
}

/**
 * Ends a turn's open blocks: its text or a call has arrived, so it is no
 * longer only thinking. Their own ends may come later (they are sent in order,
 * not with the reply's text); they then change nothing.
 */
export function endOpenReasoning(list: readonly AgentReasoning[], turnId: string | null, now: number): AgentReasoning[] {
  if (!list.some((r) => r.endedAt === undefined && (turnId === null || r.turnId === turnId))) return list as AgentReasoning[];
  return list.map((r) => (r.endedAt === undefined && (turnId === null || r.turnId === turnId) ? { ...r, endedAt: now } : r));
}

/** How a turn's end reads for the status: a problem, or done. A stop the person asked for is neither. */
export function turnEndOf(turnId: string | null, ended: { endReason?: TurnEndReason; stopReason?: TurnStoppedReason }, now: number): AgentTurnEnd | null {
  if (ended.stopReason === 'user_stop' || ended.stopReason === 'superseded') return null;
  if (ended.stopReason === 'deadline') return { turnId, kind: 'problem', reason: 'deadline', at: now };
  if (ended.endReason === 'output_limit' || ended.endReason === 'step_count') return { turnId, kind: 'problem', reason: ended.endReason, at: now };
  return { turnId, kind: 'done', ...(ended.endReason ? { reason: ended.endReason } : {}), at: now };
}

/** The messages of the turn in progress: from the person's latest message on. */
export function liveTurnMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].toolCall) return messages.slice(i);
  }
  return [...messages];
}

export interface AgentStatusInput {
  isStreaming: boolean;
  currentTurnId: string | null;
  messages: readonly AgentMessage[];
  reasoning: readonly AgentReasoning[];
  waitingOnPerson: boolean;
  lastEnd: AgentTurnEnd | null;
  toolLabels?: Readonly<Record<string, string>>;
  planningText?: string;
}

export function agentStatusOf(input: AgentStatusInput): Omit<AgentStatus, 'clearDone'> {
  if (input.waitingOnPerson) return { state: 'needs-you', turnId: input.currentTurnId ?? input.lastEnd?.turnId ?? null, activity: null, planning: false };
  if (input.isStreaming) {
    const turnId = input.currentTurnId;
    const planning = input.reasoning.some((r) => r.endedAt === undefined && (turnId === null || r.turnId === turnId));
    const step = planning ? null : currentWorkStep(liveTurnMessages(input.messages), { toolLabels: input.toolLabels });
    return {
      state: 'working',
      turnId,
      planning,
      activity: planning ? (input.planningText ?? DEFAULT_PLANNING_TEXT) : step ? formatWorkStep(step) : null,
    };
  }
  const end = input.lastEnd;
  if (end?.kind === 'problem') return { state: 'problem', turnId: end.turnId, activity: null, planning: false, ...(end.error ? { error: end.error } : {}) };
  if (end?.kind === 'done' && !end.acknowledged) return { state: 'done', turnId: end.turnId, activity: null, planning: false };
  return { state: 'idle', turnId: null, activity: null, planning: false };
}
