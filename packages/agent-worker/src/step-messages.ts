/**
 * What one step of a turn sends after the conversation: a cache breakpoint at
 * the conversation's end, and the notes that step alone is told.
 *
 * `ai` carries the messages a step was given into the next step, so whatever
 * a step adds for itself would stay: its note would become part of the
 * conversation, and its breakpoint would add to every later step's until the
 * provider's limit (Bedrock and Anthropic take four). Both are tagged when
 * added and taken back off before the next step adds its own.
 */
import type { ModelMessage } from 'ai';
import type { ProviderOptions } from './model.js';

/** Opens and closes what the model is told for one step only. */
export const STEP_NOTE_OPEN = '<step_note>';
export const STEP_NOTE_CLOSE = '</step_note>';

/** The key under which the runtime marks what it added. Providers read only their own key, so it never reaches one. */
const RUNTIME_KEY = 'ouispec';

type Marks = { stepNote?: true; breakpoint?: { before: ProviderOptions | null } };

const marksOf = (m: ModelMessage): Marks | undefined => (m.providerOptions?.[RUNTIME_KEY] as Marks | undefined) ?? undefined;

/** Whether `m` already carries the breakpoint: the conversation's start of turn mark, say. */
function carries(m: ModelMessage, breakpoint: ProviderOptions): boolean {
  return Object.entries(breakpoint).every(([provider, options]) => JSON.stringify(m.providerOptions?.[provider]) === JSON.stringify(options));
}

/** `messages` without what an earlier step added for itself. */
function withoutStepAdditions(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages
    .filter((m) => !marksOf(m)?.stepNote)
    .map((m) => {
      const added = marksOf(m)?.breakpoint;
      if (!added) return m;
      const { providerOptions: _added, ...rest } = m;
      return (added.before ? { ...rest, providerOptions: added.before } : rest) as ModelMessage;
    });
}

/**
 * The conversation as this step sends it: an earlier step's note and
 * breakpoint taken off, a breakpoint on its last message (unless that message
 * has one), and this step's notes after it, where they change no prefix.
 */
export function stepMessages(messages: readonly ModelMessage[], notes: readonly string[], breakpoint: ProviderOptions | undefined): ModelMessage[] {
  const conversation = withoutStepAdditions(messages);
  const last = conversation.at(-1);
  const marked =
    !breakpoint || !last || carries(last, breakpoint)
      ? conversation
      : [
          ...conversation.slice(0, -1),
          {
            ...last,
            providerOptions: { ...(last.providerOptions ?? {}), ...breakpoint, [RUNTIME_KEY]: { breakpoint: { before: last.providerOptions ?? null } } },
          } as ModelMessage,
        ];
  if (notes.length === 0) return marked;
  return [
    ...marked,
    {
      role: 'user',
      content: [{ type: 'text', text: [STEP_NOTE_OPEN, ...notes, STEP_NOTE_CLOSE].join('\n') }],
      providerOptions: { [RUNTIME_KEY]: { stepNote: true } },
    },
  ];
}
