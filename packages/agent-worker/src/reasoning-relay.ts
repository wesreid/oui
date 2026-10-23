/**
 * The model's thinking, relayed to the turn's room.
 *
 * While the model thinks, nothing else of the turn streams: a step can think
 * for most of a minute before it says or calls anything (dev, 2026-10-23: a
 * 93-call turn said nothing until its end). The start and end of each thinking
 * block go out so a view can say the turn is planning. When the host asked the
 * model for a summary of its thinking (`modelProviderOptions`), the summary
 * streams between them, coalesced like the reply's text. None of it is stored
 * with the conversation, and nothing here changes what the model is sent.
 *
 * Emits are queued in order and never awaited by the stream, so relaying never
 * slows the turn; `settle` waits for the queue before the turn's end is sent.
 */
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';

/** The stream parts the relay reads; every other part is ignored. */
export type ReasoningStreamPart =
  | { type: 'start-step' }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; text: string }
  | { type: 'reasoning-end'; id: string }
  | { type: string };

export interface ReasoningRelayOptions {
  turnId: string;
  emit: (event: string, data: Record<string, unknown>) => Promise<void>;
  /** A summary piece is sent after this long, or once it reaches `coalesceChars`. */
  coalesceMs?: number;
  coalesceChars?: number;
  now?: () => number;
}

export interface ReasoningRelay {
  /** Read one part of the model's stream. Never throws, never waits on the network. */
  onPart(part: ReasoningStreamPart): void;
  /** Ends any block still open (an aborted or failed stream), sends what is buffered, and waits for every emit. */
  settle(): Promise<void>;
}

export function createReasoningRelay(options: ReasoningRelayOptions): ReasoningRelay {
  const { turnId, emit } = options;
  const coalesceMs = options.coalesceMs ?? 50;
  const coalesceChars = options.coalesceChars ?? 32;
  const now = options.now ?? Date.now;

  let queue: Promise<void> = Promise.resolve();
  const send = (event: string, data: Record<string, unknown>) => {
    queue = queue.then(() => emit(event, { turnId, ...data, timestamp: now() })).catch(() => {});
  };

  // A provider numbers its blocks within one response, so the same id comes
  // back in the next step: each step's blocks are told apart by the step.
  let step = 0;
  const open = new Map<string, string>();
  let buffer = '';
  let bufferedFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (bufferedFor && buffer) send(AGENT_SOCKET_EVENTS.REASONING_DELTA, { reasoningId: bufferedFor, text: buffer });
    buffer = '';
    bufferedFor = null;
  };

  const end = (key: string) => {
    const reasoningId = open.get(key);
    if (!reasoningId) return;
    if (bufferedFor === reasoningId) flush();
    open.delete(key);
    send(AGENT_SOCKET_EVENTS.REASONING_ENDED, { reasoningId });
  };

  return {
    onPart(part) {
      switch (part.type) {
        case 'start-step':
          step += 1;
          return;
        case 'reasoning-start': {
          const { id } = part as { id: string };
          if (open.has(id)) return;
          const reasoningId = `${turnId}:${step}:${id}`;
          open.set(id, reasoningId);
          send(AGENT_SOCKET_EVENTS.REASONING_STARTED, { reasoningId });
          return;
        }
        case 'reasoning-delta': {
          const { id, text } = part as { id: string; text: string };
          const reasoningId = open.get(id);
          if (!reasoningId || !text) return;
          if (bufferedFor !== reasoningId) flush();
          bufferedFor = reasoningId;
          buffer += text;
          if (buffer.length >= coalesceChars) flush();
          else if (!timer) timer = setTimeout(flush, coalesceMs);
          return;
        }
        case 'reasoning-end':
          end((part as { id: string }).id);
          return;
        default:
          return;
      }
    },
    async settle() {
      for (const key of [...open.keys()]) end(key);
      flush();
      await queue;
    },
  };
}
