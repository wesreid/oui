/**
 * One turn of a product that keeps notes, through the runtime a host creates
 * (`createAgentTurnRunner`), the real orchestrator and `ai` loop, and a model
 * scripted through a provider's real package. What is kept is what the turn
 * costs (the request bodies the provider sent), what the person is sent (every
 * event, in the order the turn emitted it), what the host stores, and what it
 * reported.
 *
 * Used by the golden captures (`no-trailer-golden.test.ts`), the note trailer's
 * end-to-end tests (`trailer.e2e.test.ts`) and its provider tests.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { AGENT_SOCKET_EVENTS, type TurnStopRecord } from '@ouispec/agent-core';
import { createAgentTurnRunner } from '../../runtime/turn-runner.js';
import { scriptedChatCompletions, type ScriptedReply } from '../../testing/scripted.js';
import type { LanguageModel } from '../../model.js';
import type { RegisteredTool } from '../../tools/types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../../runtime/types.js';
import type { AnswerlessEnd, TurnHistoryMessage, TurnMessage } from '../../types.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

export const SAID = 'Make the chorus brighter and keep the verse as it is.';
export const REPLY = 'I made the chorus brighter and left the verse as it was.';
export const AFTER_NOTE = 'Done: the chorus is brighter, and I noted your decision.';

export interface Emitted {
  event: string;
  data: Record<string, unknown>;
}

/** The host's note tool, as a product declares its memory's `note`: the chat's own record. */
export function noteTool(options: {
  answerless: boolean;
  trailer?: boolean;
  fails?: boolean;
  whileRunning?: () => Promise<void>;
  described?: boolean;
}): RegisteredTool & { written: Array<Record<string, unknown>> } {
  const written: Array<Record<string, unknown>> = [];
  return {
    name: 'note',
    effect: 'edit',
    ...(options.answerless ? { answerless: true } : {}),
    ...(options.trailer ? { trailer: true } : {}),
    description: 'Write one line in this chat’s work notes.',
    inputSchema: {
      type: 'object',
      sideEffects: false,
      additionalProperties: false,
      properties: options.described
        ? {
            kind: { type: 'string', enum: ['decision', 'task', 'made'], description: 'What the note is.' },
            text: { type: 'string', description: 'One line, in the person’s own terms.' },
          }
        : { kind: { type: 'string', enum: ['decision', 'task', 'made'] }, text: { type: 'string' } },
    },
    written,
    async execute(input) {
      await options.whileRunning?.();
      if (options.fails) return { success: false, error: 'NO_CONVERSATION: This turn has no conversation to keep notes in.' };
      written.push(input);
      return { success: true, data: { id: `note-${written.length}`, kind: input.kind, text: input.text } };
    },
  };
}

/** A tool whose answer the model reads: the work itself. */
export const brightenTool: RegisteredTool = {
  name: 'brighten_section',
  effect: 'edit',
  description: 'Make a section of the track brighter.',
  inputSchema: { type: 'object', sideEffects: false, properties: { section: { type: 'string' } } },
  async execute(input) {
    return { success: true, data: { section: input.section, brightness: '+3 dB at 8 kHz' } };
  },
};

export const NOTE_CALL = { id: 'call_note', name: 'note', args: { kind: 'decision', text: 'Chorus brighter; verse unchanged.' } };
export const BRIGHTEN_CALL = { id: 'call_brighten', name: 'brighten_section', args: { section: 'chorus' } };

/** A stop client that never hears a stop, or the test's own. */
export function stopClient(stop?: { fire: (hear: (record: TurnStopRecord) => void) => void }) {
  return {
    watch: (_t: string, _u: string, signal: AbortSignal, onChecked?: () => void) =>
      new Promise<TurnStopRecord | null>((resolve) => {
        stop?.fire(resolve);
        onChecked?.();
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
}

export interface NoteTurnRun {
  /** The request bodies the provider sent, in order. */
  requests: unknown[];
  outcome: Awaited<ReturnType<ReturnType<typeof createAgentTurnRunner>['run']>>;
  stored: TurnMessage[];
  recorded: { rounds: number; answerlessEnd?: AnswerlessEnd; stopReason?: string } | null;
  /** Every event the turn emitted, in the order it emitted them. */
  events: Emitted[];
}

/** A provider's model and the request bodies it sent. */
export interface ScriptedProvider {
  model: LanguageModel;
  requests: unknown[];
}

/** OpenAI Chat Completions through the real `@ai-sdk/openai` package, answering each request with the next reply. */
export function scriptedOpenAIModel(replies: ScriptedReply[]): ScriptedProvider {
  const scripted = scriptedChatCompletions((_request, index) => replies[index]);
  return { model: createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scripted.fetch }).chat('gpt-fixture'), requests: scripted.requests };
}

/** One turn of a product with these tools. */
export async function noteTurn(options: {
  tools: RegisteredTool[];
  provider: ScriptedProvider;
  history?: TurnHistoryMessage[];
  stop?: { fire: (hear: (record: TurnStopRecord) => void) => void };
  turnId?: string;
  context?: Record<string, unknown>;
  content?: string;
  config?: Partial<AgentRuntimeConfig<object>>;
}): Promise<NoteTurnRun> {
  let stored: TurnMessage[] = [];
  let recorded: NoteTurnRun['recorded'] = null;
  const events: Emitted[] = [];
  const content = options.content ?? SAID;
  const config: AgentRuntimeConfig<object> = {
    model: options.provider.model,
    realtime: {
      url: 'http://127.0.0.1:9',
      apiKey: 'realtime-key',
      // Kept as the turn emits them: the order is the turn's, not the network's.
      emit: {
        async emit(_room, event, data) {
          events.push({ event, data: data as Record<string, unknown> });
        },
      },
    },
    systemPrompt: () => 'You help with music.',
    tools: options.tools,
    getDb: async () => ({}),
    getHistory: async () => [...(options.history ?? []), { role: 'user', content }],
    persistMessages: async ({ messages }) => {
      stored = messages;
    },
    recordTurnComplete: async ({ rounds, answerlessEnd, stopReason }) => {
      recorded = { rounds, ...(answerlessEnd ? { answerlessEnd } : {}), ...(stopReason ? { stopReason } : {}) };
    },
    logger: quiet,
    approvals: { store: { create: async () => {}, redeem: async () => ({ ok: false, reason: 'used', error: 'used' }), status: async () => null } },
    stops: { client: stopClient(options.stop), graceMs: 50 },
    uiActions: { channel: { request: async () => ({ success: false, error: 'not used' }) } as never },
    ...options.config,
  };
  const turnId = options.turnId ?? 'turn-note-1';
  const payload: AgentTurnPayload = {
    turnId,
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'conversation:conv-1',
    content,
    context: options.context ?? { currentPath: '/music/generate', timeZone: 'Europe/Paris' },
  };
  const outcome = await createAgentTurnRunner(config).run(payload, { channel: 'chat' });
  return { requests: options.provider.requests, outcome, stored, recorded, events: events.filter((e) => e.data?.turnId === turnId) };
}

/** The turn's stored messages, as a host hands them back as the next turn's history. */
export function asHistory(messages: TurnMessage[]): TurnHistoryMessage[] {
  return messages.map((m): TurnHistoryMessage =>
    m.role === 'tool'
      ? { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId!, ...(m.name ? { name: m.name } : {}) }
      : {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls
            ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }
            : {}),
        },
  );
}

export const roundEnds = (run: NoteTurnRun) => run.events.filter((e) => e.event === AGENT_SOCKET_EVENTS.ROUND_END).map((e) => e.data);
export const tokens = (run: NoteTurnRun) =>
  run.events
    .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
    .map((e) => e.data.text)
    .join('');

/**
 * A value with what changes from run to run taken out: every event's
 * timestamp and duration, and the clock line the turn's context carries
 * (`<now>`), whose date, time and offset are the run's. Everything else is
 * kept byte for byte.
 */
export function withoutClock(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/It is \w+ \d{1,2} \w+ \d{4} \(\d{4}-\d{2}-\d{2}\), \d{2}:\d{2} /g, 'It is <clock> ')
      .replace(/\(UTC[+-]\d{2}:\d{2}\)/g, '(UTC<offset>)');
  }
  if (Array.isArray(value)) return value.map(withoutClock);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'timestamp' && key !== 'durationMs')
        .map(([key, v]) => [key, withoutClock(v)]),
    );
  }
  return value;
}
