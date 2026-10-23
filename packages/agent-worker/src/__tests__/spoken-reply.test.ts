/**
 * A reply that will be spoken is written for the ear: short sentences, no
 * markdown, lists, links or emoji, numbers said as words, and what to look at
 * shown through the page. Said after the conversation, with what else is true
 * only for this turn, so the system prompt, the tools and every message are
 * the same for a call turn as for a chat turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readClientReplyOutput, spokenReplyText } from '../prompt/spoken-reply.js';
import { withoutClientUI } from '../ui/snapshot.js';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { createToolRegistry } from '../tools/types.js';

describe('spokenReplyText', () => {
  const text = spokenReplyText({ mode: 'voice' });

  it('says the reply will be heard, not read', () => {
    expect(text).toMatch(/^<output>Your reply will be spoken aloud to the user on a live call; they will hear it, not read it\./);
    expect(text.endsWith('</output>')).toBe(true);
  });

  it('asks for short spoken sentences and none of what a voice cannot say', () => {
    expect(text).toContain('short, plain sentences');
    expect(text).toContain('Use no markdown, lists, headings, links, code or emoji.');
  });

  it('asks for numbers, prices, dates and times as a person says them', () => {
    expect(text).toContain('Write numbers, prices, dates and times the way a person says them aloud, in words');
  });

  it('shows what is to be looked at through the page instead of reading it out', () => {
    expect(text).toContain('Never read out a link, an id or a long list: show what the user should look at through the page’s actions');
  });

  it('says what it is doing before a slow lookup, so the call is not silent', () => {
    expect(text).toContain('first say in a few words what you are doing');
  });

  it('is one line', () => {
    expect(text).not.toContain('\n');
  });
});

describe('readClientReplyOutput', () => {
  it('reads a spoken reply from the turn’s context, and nothing else', () => {
    expect(readClientReplyOutput({ output: { mode: 'voice' } })).toEqual({ mode: 'voice' });
    expect(readClientReplyOutput({ output: { mode: 'voice', voice: 'nova' } })).toEqual({ mode: 'voice' });
    expect(readClientReplyOutput({ output: { mode: 'text' } })).toBeNull();
    expect(readClientReplyOutput({ output: 'voice' })).toBeNull();
    expect(readClientReplyOutput({ currentPath: '/' })).toBeNull();
    expect(readClientReplyOutput(null)).toBeNull();
  });

  it('is left out of the context the host’s prompt renders', () => {
    expect(withoutClientUI({ currentPath: '/inventory', input: { mode: 'voice' }, output: { mode: 'voice' } })).toEqual({ currentPath: '/inventory' });
  });
});

// ─── Through a whole turn ────────────────────────────────────────────────────

type Part = { type: string; text?: string };
type Msg = { role: string; content: string | Part[] };
type StreamOpts = {
  messages: Msg[];
  instructions: { content: string };
  prepareStep: (o: { steps: unknown[]; messages: Msg[] }) => Promise<{ messages?: Msg[] }>;
};
let seen: StreamOpts | null = null;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seen = opts;
    const reply = 'We have two blue RAV4s under thirty thousand dollars. I am putting them on your screen.';
    return {
      textStream: (async function* () {
        yield reply;
      })(),
      steps: Promise.resolve([{ text: reply, toolCalls: [], usage: { inputTokens: 10 } }]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: reply }] }),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const config = (): AgentWorkerConfig => ({
  tools: createToolRegistry([]),
  emit: { emit: vi.fn(async () => {}) },
  model: 'test-model',
  systemPrompt: (ctx) => `You are the dealership's assistant. Context: ${JSON.stringify(ctx.context)}`,
});

const SAID = 'Do you have any blue RAV4s under thirty thousand?';
const turn = (context: Record<string, unknown>, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  turnId: 'turn-call',
  conversationId: 'conv',
  userId: 'visitor-1',
  accountId: 'rooftop-1',
  socketRoom: 'conversation:conv',
  content: SAID,
  history: [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello, how can I help?' },
    { role: 'user', content: SAID },
  ],
  context,
  ...overrides,
});

async function firstStep(opts: StreamOpts): Promise<{ conversation: Msg[]; tail: string }> {
  const sent = (await opts.prepareStep({ steps: [], messages: opts.messages })).messages!;
  return { conversation: sent.slice(0, -1), tail: textOf(sent.at(-1)!) };
}
const textOf = (m: Msg) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n'));

describe('a spoken reply, through a turn', () => {
  beforeEach(() => {
    seen = null;
  });

  it('is asked for after the conversation; everything before that is the chat turn’s, byte for byte', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const page = { currentPath: '/inventory', timeZone: 'America/Chicago' };

    await runAgentTurn(config(), turn({ ...page, input: { mode: 'voice', language: 'en' } }));
    const chat = await firstStep(seen!);
    const chatInstructions = seen!.instructions.content;
    await runAgentTurn(config(), turn({ ...page, input: { mode: 'voice', language: 'en' }, output: { mode: 'voice' } }));
    const call = await firstStep(seen!);

    expect(call.tail).toContain(spokenReplyText({ mode: 'voice' }));
    expect(chat.tail).not.toContain('<output>');
    // After the line about the spoken message: both say what is true of this turn only.
    expect(call.tail.indexOf('<input>')).toBeGreaterThanOrEqual(0);
    expect(call.tail.indexOf('<output>')).toBeGreaterThan(call.tail.indexOf('<input>'));
    expect(seen!.instructions.content).toBe(chatInstructions);
    expect(seen!.instructions.content).not.toMatch(/<output>|spoken aloud/);
    expect(JSON.stringify(call.conversation)).toBe(JSON.stringify(chat.conversation));
  });

  it('is asked for on the turn that continues an approval, whose reply is spoken too', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(
      config(),
      turn({ output: { mode: 'voice' } }, { content: 'Yes, book it.', approval: { approvalId: 'apr_1', decision: 'decline' } }),
    );
    expect((await firstStep(seen!)).tail).toContain('<output>Your reply will be spoken aloud');
  });

  it('is not asked for when the output is malformed', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(), turn({ output: { mode: 'hologram' } }));
    expect((await firstStep(seen!)).tail).not.toContain('<output>');
  });
});
