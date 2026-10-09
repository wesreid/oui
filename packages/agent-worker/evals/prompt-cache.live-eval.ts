/**
 * Live prompt-cache eval (ADR-0263): a conversation of three turns on a design
 * canvas, each read from the cache up to its own new content.
 *
 * On dev (2026-10-08) a quarter of all PA input went uncached and another
 * quarter was written to the cache again on every turn: a turn's calls were
 * paid in full at every later step, a step note in the system prompt changed
 * the conversation's prefix, a newer answer took the page's state off an older
 * one, and what was true for one turn (the page, the clock, the notes) was put
 * on the user's message, which the next turn sent without it.
 *
 * Graded on the provider's own usage: after the first turn, what each turn
 * writes to the cache or sends uncached is its own new content and the step's
 * tail (the page's state, the clock), never the conversation again.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials (e.g. `AWS_PROFILE=<profile> AWS_REGION=us-east-1`).
 * `EVAL_MODEL_ID` sets the model.
 */
import { describe, expect, it } from 'vitest';

import { runAgentTurn } from '../src/orchestrator.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../src/model.js';
import { buildAgentSystemPrompt } from '../src/prompt/index.js';
import { createToolRegistry } from '../src/tools/types.js';
import { loadBuiltinTools } from '../src/tools/builtin-tools.js';
import type { TurnHistoryMessage, TurnMessage } from '../src/types.js';
import { LIVE_MODEL_ID, liveBedrock } from './support/bedrock.js';
import { createCanvasRoom, wordmarkBoard } from './support/canvas-room.js';

const PERSONA = {
  name: 'Assistant',
  identity: 'You are the Assistant for a design app. You work in the user’s UI, as the user would.',
  capabilities: ['Work in the UI in real time, as the user would'],
  knowledge: [],
  workflows: [],
  instructions: [],
  fewShotExamples: [],
};

/** A stored message as a host hands it back in the next turn's history. */
const asHistory = (m: TurnMessage): TurnHistoryMessage =>
  m.role === 'tool'
    ? { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId!, name: m.name }
    : {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      };

const REQUESTS = [
  'Make the text on Anim 03 green and 120px.',
  'Now do the same on Anim 05, and make it 50% opaque.',
  'Make the text on Anim 07 red.',
];

describe(`the prompt cache across a conversation (${LIVE_MODEL_ID})`, () => {
  it('reads each turn from the cache up to what is new in it', async () => {
    const room = createCanvasRoom(wordmarkBoard(12), 'after');
    const bedrock = liveBedrock();
    const history: TurnHistoryMessage[] = [];
    const turns: Array<{ input: number; read: number; write: number; uncached: number }> = [];
    for (const [i, request] of REQUESTS.entries()) {
      history.push({ role: 'user', content: request });
      const result = await runAgentTurn(
        {
          tools: createToolRegistry(loadBuiltinTools().filter((t) => t.name === 'present_options')),
          emit: { emit: async () => {} },
          model: bedrock(LIVE_MODEL_ID),
          promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
          systemPrompt: buildAgentSystemPrompt(PERSONA as never),
          maxToolRounds: 24,
          // A model that takes no temperature (Claude Sonnet 5.5 on Bedrock) is sent none.
          ...(process.env.EVAL_TEMPERATURE === 'none' ? { temperature: null } : {}),
          turnDeadlineMs: 170_000,
          ui: { channel: room.channel, resultTimeoutMs: 5_000 },
        },
        {
          turnId: `eval-cache-${Date.now()}-${i}`,
          conversationId: 'eval-cache',
          userId: 'eval-user',
          accountId: 'eval-account',
          socketRoom: 'agent:turn:eval-cache',
          content: request,
          history: [...history],
          context: { currentPath: '/canvas/board-1', timeZone: 'Europe/Paris', oui: { surfaces: [room.surface], observations: room.observations() } },
          stepContext: `<work_notes>\n- Turn ${i + 1} of this eval\n</work_notes>`,
        },
      );
      history.push(...result.newMessages.map(asHistory));
      const { promptTokens: input, cacheReadTokens: read = 0, cacheWriteTokens: write = 0 } = result.usage;
      turns.push({ input, read, write, uncached: input - read - write });
      console.log(JSON.stringify({ eval: 'prompt-cache', model: LIVE_MODEL_ID, turn: i + 1, rounds: result.rounds, input, read, write, uncached: input - read - write }));
    }
    // After the first turn, most of every turn is read from the cache.
    for (const t of turns.slice(1)) expect(t.read / t.input).toBeGreaterThan(0.6);
    // And no later turn writes the conversation again: a turn writes what it added, not what came before.
    const conversationSoFar = turns[0].input;
    for (const t of turns.slice(1)) expect(t.write).toBeLessThan(conversationSoFar / 2);
  }, 600_000);
});
