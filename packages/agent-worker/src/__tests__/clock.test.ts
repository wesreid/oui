/**
 * Every turn tells the model the date and time on the user's clock.
 *
 * On dev (2026-10-02) the PA, asked to restore "yesterday's version", took
 * entries dated 2 October for another day than today, which was 2 October:
 * nothing in its turn said what today was.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';
import { clockText, readClientTimeZone } from '../prompt/clock.js';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { createToolRegistry } from '../tools/types.js';

// 23:30 UTC on Friday 2 October 2026: still Friday in Los Angeles, already Saturday in Paris and Auckland.
const NOW = new Date('2026-10-02T23:30:00Z');

describe('clockText', () => {
  it('names the day, the date and the time in the user’s zone, with its offset', () => {
    expect(clockText(NOW, 'Europe/Paris')).toContain(
      "It is Saturday 3 October 2026 (2026-10-03), 01:30 in the user's time zone, Europe/Paris (UTC+02:00).",
    );
    expect(clockText(NOW, 'America/Los_Angeles')).toContain(
      "It is Friday 2 October 2026 (2026-10-02), 16:30 in the user's time zone, America/Los_Angeles (UTC-07:00).",
    );
    expect(clockText(NOW, 'Pacific/Auckland')).toContain('It is Saturday 3 October 2026 (2026-10-03), 12:30');
    // A zone with no whole-hour offset, and midnight written 00, not 24.
    expect(clockText(new Date('2026-10-02T18:30:00Z'), 'Asia/Kolkata')).toContain('(2026-10-03), 00:00 in the user\'s time zone, Asia/Kolkata (UTC+05:30)');
  });

  it('says UTC, and that the zone is not known, when the client sent none', () => {
    const text = clockText(NOW, null);
    expect(text).toContain('It is Friday 2 October 2026 (2026-10-02), 23:30 UTC');
    expect(text).toContain("the user's time zone is not known");
  });

  it('tells the model whose days "today" and "yesterday" are', () => {
    expect(clockText(NOW, 'Europe/Paris')).toMatch(/today, yesterday.* are days on that clock/);
  });
});

describe('readClientTimeZone', () => {
  it('takes an IANA zone from the turn’s context, and nothing else', () => {
    expect(readClientTimeZone({ timeZone: 'Europe/Paris' })).toBe('Europe/Paris');
    expect(readClientTimeZone({ timeZone: 'Mars/Olympus_Mons' })).toBeNull();
    expect(readClientTimeZone({ timeZone: 42 })).toBeNull();
    expect(readClientTimeZone({ timeZone: '' })).toBeNull();
    expect(readClientTimeZone({})).toBeNull();
    expect(readClientTimeZone(null)).toBeNull();
  });
});

// ─── Through a whole turn ────────────────────────────────────────────────────

type StreamOpts = {
  messages: ModelMessage[];
  instructions: { content: string };
  prepareStep: (o: { steps: unknown[]; messages: ModelMessage[] }) => Promise<{ messages?: ModelMessage[] }>;
};

/** What the first step sends after the conversation: what is true only now. */
async function firstStepTail(): Promise<{ text: string; conversation: ModelMessage[] }> {
  const step = await seen!.prepareStep({ steps: [], messages: seen!.messages });
  const sent = step.messages!;
  const tail = sent.at(-1)!;
  return { text: JSON.stringify(tail.content), conversation: sent.slice(0, -1) };
}
let seen: StreamOpts | null = null;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seen = opts;
    const steps = Promise.resolve([{ text: 'It is Saturday.', toolCalls: [] }]);
    return {
      textStream: (async function* () {
        yield 'It is Saturday.';
      })(),
      steps: steps.then((ss) => ss.map((s) => ({ ...s, usage: { inputTokens: 10 } }))),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: 'It is Saturday.' }] }),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const config: AgentWorkerConfig = {
  tools: createToolRegistry([]),
  emit: { emit: vi.fn(async () => {}) },
  model: 'test-model',
  systemPrompt: 'You are the assistant.',
};

const turn = (context: Record<string, unknown>): AgentTurnInput => ({
  turnId: 'turn-clock',
  conversationId: 'conv',
  userId: 'user-1',
  accountId: 'acct',
  socketRoom: 'agent:turn:turn-clock',
  content: 'What is today’s date?',
  history: [{ role: 'user', content: 'What is today’s date?' }],
  context,
});

describe('a turn’s context names today’s date in the user’s zone', () => {
  beforeEach(() => {
    seen = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('after the conversation, never on the user’s message or in the cached system prompt', async () => {
    try {
      const { runAgentTurn } = await import('../orchestrator.js');
      await runAgentTurn(config, turn({ currentPath: '/vector', timeZone: 'Europe/Paris' }));
    } finally {
      vi.useRealTimers();
    }
    const { text, conversation } = await firstStepTail();
    expect(text).toContain('It is Saturday 3 October 2026 (2026-10-03), 01:30');
    expect(text).toContain('Europe/Paris (UTC+02:00)');
    // The user's message is sent as they wrote it, so the next turn sends it the same way and the cache reads it.
    expect(conversation.at(-1)!.content).toBe('What is today’s date?');
    // The system prompt is a cached prefix: no date or time in it.
    expect(seen!.instructions.content).not.toMatch(/2026|October|<now>/);
  });

  it('in UTC, said as UTC, when the client sent no zone', async () => {
    try {
      const { runAgentTurn } = await import('../orchestrator.js');
      await runAgentTurn(config, turn({ currentPath: '/vector' }));
    } finally {
      vi.useRealTimers();
    }
    expect((await firstStepTail()).text).toContain('It is Friday 2 October 2026 (2026-10-02), 23:30 UTC');
  });
});
