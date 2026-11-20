/**
 * What one step of a turn sends besides the conversation, and where.
 *
 * - **The turn's context** (`turnContext`): what is true for the whole turn
 *   (the clock, how the message was entered and how the reply is delivered,
 *   whether the model can look at the caller or ask for photos, the host's
 *   `stepContext`). It goes straight after the turn's own user message, on
 *   every step, in the same words: with the message, never after a tool
 *   result. A user-role block after a tool result reads as the person's
 *   newest message: the model answered "your message came through blank", or
 *   went back to an earlier question, and dropped what the tool said (a live
 *   call’s `look`: 0–6 correct answers in 20, against 20 in 20 here;
 *   `evals/turn-context.live-eval.ts`).
 * - **The step's tail** (`tail`): what is true for this step only (the
 *   page's newest state, the step's notes). It goes after the conversation's
 *   end, after the moving cache breakpoint, where it changes no prefix. Each
 *   part is in its own tags (`<page_state>`, `<step_note>`), and a UI answer
 *   that gave its state up says the page is there.
 * - **A cache breakpoint** on the conversation's last message (the turn's
 *   context on a turn's first step, then its newest tool result), so the
 *   next step reads all of it. The turn's context is the same on every step,
 *   so it is read from the cache like the conversation around it.
 *
 * `ai` carries the messages a step was given into the next step, so whatever
 * a step adds for itself would stay: its tail would become part of the
 * conversation, and its breakpoint would add to every later step's until the
 * provider's limit (Bedrock and Anthropic take four). Each is tagged when
 * added and taken back off before the next step adds its own.
 */
import type { ModelMessage } from 'ai';
import type { ProviderOptions } from './model.js';

/** Opens and closes what the model is told for one step only. */
export const STEP_NOTE_OPEN = '<step_note>';
export const STEP_NOTE_CLOSE = '</step_note>';

/**
 * Where a turn's context goes (`AgentWorkerConfig.turnContextPlacement`):
 * `with-message`, the default, straight after the turn's own message; or
 * `after-conversation`, after the conversation's end on every step, as 0.30
 * and earlier sent it.
 */
export const TURN_CONTEXT_PLACEMENTS = ['with-message', 'after-conversation'] as const;

export type TurnContextPlacement = (typeof TURN_CONTEXT_PLACEMENTS)[number];

/** The placement named, or a refusal naming the ones there are. */
export function readTurnContextPlacement(value: unknown): TurnContextPlacement {
  if (value === undefined) return 'with-message';
  if ((TURN_CONTEXT_PLACEMENTS as readonly unknown[]).includes(value)) return value as TurnContextPlacement;
  throw new Error(`[agent-sdk] turnContextPlacement must be one of ${TURN_CONTEXT_PLACEMENTS.join(', ')}, not ${JSON.stringify(value)}`);
}

/** The key under which the runtime marks what it added. Providers read only their own key, so it never reaches one. */
const RUNTIME_KEY = 'ouispec';

type Marks = { stepTail?: true; turnContext?: true; breakpoint?: { before: ProviderOptions | null } };

const marksOf = (m: ModelMessage): Marks | undefined => (m.providerOptions?.[RUNTIME_KEY] as Marks | undefined) ?? undefined;

/** Whether `m` already carries the breakpoint: the conversation's start of turn mark, say. */
function carries(m: ModelMessage, breakpoint: ProviderOptions): boolean {
  return Object.entries(breakpoint).every(([provider, options]) => JSON.stringify(m.providerOptions?.[provider]) === JSON.stringify(options));
}

/** `messages` without what an earlier step added for itself. */
function withoutStepAdditions(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages
    .filter((m) => !marksOf(m)?.stepTail && !marksOf(m)?.turnContext)
    .map((m) => {
      const added = marksOf(m)?.breakpoint;
      if (!added) return m;
      const { providerOptions: _added, ...rest } = m;
      return (added.before ? { ...rest, providerOptions: added.before } : rest) as ModelMessage;
    });
}

/** A user-role block the runtime adds for one step, marked so the next step takes it off. */
function added(text: string, mark: 'stepTail' | 'turnContext'): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }], providerOptions: { [RUNTIME_KEY]: { [mark]: true } } };
}

/** `m` with the breakpoint, remembering what it carried before so the next step can put that back. */
function withBreakpoint(m: ModelMessage, breakpoint: ProviderOptions): ModelMessage {
  const marks = marksOf(m);
  // The turn's context is taken off whole by the next step: its mark is all it needs.
  const mark: Marks = marks?.turnContext ? marks : { ...(marks ?? {}), breakpoint: { before: m.providerOptions ?? null } };
  return { ...m, providerOptions: { ...(m.providerOptions ?? {}), ...breakpoint, [RUNTIME_KEY]: mark } } as ModelMessage;
}

/** What one step sends besides the conversation. */
export interface StepAdditions {
  /** True for the whole turn: sent with the turn's own message, the same on every step. */
  turnContext: readonly string[];
  /** True for this step only: sent after the conversation. */
  tail: readonly string[];
}

/**
 * The conversation as this step sends it: an earlier step's additions and
 * breakpoint taken off, the turn's context after the turn's own message (the
 * conversation's last user message: a turn's steps add only the model's
 * calls and their results), a breakpoint on the last message (unless it has
 * one), and this step's tail after it.
 */
export function stepMessages(messages: readonly ModelMessage[], additions: StepAdditions, breakpoint: ProviderOptions | undefined): ModelMessage[] {
  const conversation = withoutStepAdditions(messages);
  const withContext =
    additions.turnContext.length === 0
      ? conversation
      : (() => {
          const turnMessageAt = conversation.map((m) => m.role).lastIndexOf('user');
          const at = turnMessageAt === -1 ? conversation.length : turnMessageAt + 1;
          return [...conversation.slice(0, at), added(additions.turnContext.join('\n\n'), 'turnContext'), ...conversation.slice(at)];
        })();
  const last = withContext.at(-1);
  const marked =
    !breakpoint || !last || carries(last, breakpoint) ? withContext : [...withContext.slice(0, -1), withBreakpoint(last, breakpoint)];
  if (additions.tail.length === 0) return marked;
  return [...marked, added(additions.tail.join('\n\n'), 'stepTail')];
}

/**
 * The conversation with each of these calls answered by the result given for
 * it, in place of the one it holds: a call `ai` answered with its own error,
 * because no tool of the step could run it, reads the SDK's result instead
 * (the orchestrator's `callNoToolRan`). `ai` carries a step's messages into
 * the next, so the result stays what every later step reads.
 */
export function withCallResults(messages: readonly ModelMessage[], results: ReadonlyMap<string, string>): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool' || !m.content.some((part) => part.type === 'tool-result' && results.has(part.toolCallId))) return m;
    return {
      ...m,
      content: m.content.map((part) => {
        const value = part.type === 'tool-result' ? results.get(part.toolCallId) : undefined;
        if (part.type !== 'tool-result' || value === undefined) return part;
        if (part.output.type === 'error-text' && part.output.value === value) return part;
        return { ...part, output: { type: 'error-text' as const, value } };
      }),
    };
  });
}
