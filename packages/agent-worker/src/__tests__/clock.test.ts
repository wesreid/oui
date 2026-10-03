/**
 * Every turn tells the model the date and time on the user's clock.
 *
 * On dev (2026-10-02) the PA, asked to restore "yesterday's version", took
 * entries dated 2 October for another day than today, which was 2 October:
 * nothing in its turn said what today was.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';
import { clockText, readClientTimeZone, withClock } from '../prompt/clock.js';
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

describe('withClock', () => {
  it('puts the clock on the user’s message, after what they said and the page state', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'restore yesterday’s version\n\n<page_state>…</page_state>' },
    ];
    const out = withClock(messages, { timeZone: 'Europe/Paris' }, NOW);
    expect(out.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(out[2].content).toMatch(/^restore yesterday’s version\n\n<page_state>…<\/page_state>\n\n<now>\nIt is Saturday 3 October 2026/);
  });

  it('leaves messages that do not end with the user’s as they are', () => {
    const messages: ModelMessage[] = [{ role: 'assistant', content: 'ok' }];
    expect(withClock(messages, {}, NOW)).toBe(messages);
  });
});

// ─── Through a whole turn ────────────────────────────────────────────────────

type StreamOpts = { messages: ModelMessage[]; instructions: { content: string } };
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

  it('on the user’s message, and never in the cached system prompt', async () => {
    try {
      const { runAgentTurn } = await import('../orchestrator.js');
      await runAgentTurn(config, turn({ currentPath: '/vector', timeZone: 'Europe/Paris' }));
    } finally {
      vi.useRealTimers();
    }
    const last = seen!.messages[seen!.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('What is today’s date?');
    expect(last.content).toContain('It is Saturday 3 October 2026 (2026-10-03), 01:30');
    expect(last.content).toContain('Europe/Paris (UTC+02:00)');
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
    const last = seen!.messages[seen!.messages.length - 1];
    expect(last.content).toContain('It is Friday 2 October 2026 (2026-10-02), 23:30 UTC');
  });
});
