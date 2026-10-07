/**
 * A turn streams as one reply, written in rounds: text, a tool call, then more
 * text. On dev (2026-10-07) "Adding the file now." and "I added it." reached the
 * panel as "now.I added". Where a round that said something ended in tool calls
 * and more text follows, the stream carries a paragraph break; nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';

let mockStreamTextImpl: (opts: Record<string, unknown>) => Record<string, unknown>;

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => mockStreamTextImpl(opts),
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

interface Round {
  text: string;
  /** The tools the round called after its text; none ends the turn. */
  calls?: string[];
}

/**
 * The SDK as it streams rounds: each round's end is reported (`onStepEnd`)
 * before the next round starts. With `lagging`, the text stream delivers a
 * round's own text only after its end was reported, as a slow reader does.
 */
function streamRounds(rounds: Round[], { lagging = false } = {}) {
  mockStreamTextImpl = (opts) => {
    const onStepEnd = opts.onStepEnd as (step: Record<string, unknown>) => Promise<void>;
    const steps = rounds.map((r, i) => ({
      text: r.text,
      toolCalls: (r.calls ?? []).map((name, j) => ({ toolName: name, toolCallId: `tc_${i}_${j}`, input: {} })),
      toolResults: [],
    }));
    let ended: () => void;
    const allEnded = new Promise<void>((resolve) => (ended = resolve));
    return {
      textStream: (async function* () {
        for (const [i, step] of steps.entries()) {
          if (lagging) await onStepEnd(step);
          // A round's text, in pieces, as a model streams it.
          for (const piece of step.text.match(/.{1,7}/gs) ?? []) yield piece;
          if (!lagging) await onStepEnd(step);
          if (i === steps.length - 1) ended();
        }
      })(),
      steps: allEnded.then(() => steps),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
      response: Promise.resolve({ messages: [] }),
    };
  };
}

const tool: RegisteredTool = {
  name: 'fonts_library_add',
  description: 'Add a font file',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, data: {} })),
};

async function streamedReply(): Promise<{ reply: string; tokens: string[] }> {
  const { runAgentTurn } = await import('../orchestrator.js');
  const tokens: string[] = [];
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([tool]),
    emit: {
      emit: vi.fn(async (_room: string, event: string, data: unknown) => {
        if (event === 'agent:token') tokens.push((data as { text: string }).text);
      }),
    },
    model: 'test-model',
    systemPrompt: 'You are a test agent.',
  };
  const input: AgentTurnInput = {
    turnId: 'turn-rounds',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'account-1',
    socketRoom: 'agent:turn:turn-rounds',
    content: 'Add the font I attached',
  };
  await runAgentTurn(config, input);
  return { reply: tokens.join(''), tokens };
}

describe('a reply written in rounds', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('streams a paragraph break where a round that said something ended in a tool call', async () => {
    streamRounds([
      { text: 'The destination is set. Adding the file now.', calls: ['fonts_library_add'] },
      { text: 'I added Archivo Black to your library.' },
    ]);
    const { reply } = await streamedReply();
    expect(reply).toBe('The destination is set. Adding the file now.\n\nI added Archivo Black to your library.');
  });

  it('puts the break where the round’s text ends, however late its text arrives', async () => {
    streamRounds(
      [
        { text: 'Adding the file now.', calls: ['fonts_library_add'] },
        { text: 'Checking the list.', calls: ['fonts_library_add'] },
        { text: 'It is listed.' },
      ],
      { lagging: true },
    );
    const { reply } = await streamedReply();
    expect(reply).toBe('Adding the file now.\n\nChecking the list.\n\nIt is listed.');
  });

  it('adds nothing for a round that called tools without saying anything, nor after the last round', async () => {
    streamRounds([
      { text: '', calls: ['fonts_library_add'] },
      { text: 'Done.', calls: ['fonts_library_add'] },
    ]);
    const { reply } = await streamedReply();
    expect(reply).toBe('Done.');
  });

  it('leaves a reply of one round as it was said', async () => {
    streamRounds([{ text: 'Hello there, how can I help?' }]);
    const { reply } = await streamedReply();
    expect(reply).toBe('Hello there, how can I help?');
  });
});
