/**
 * Live eval: a step a turn policy forces to one tool, on a model that refuses
 * a forced tool choice.
 *
 * Claude Sonnet 5.5 answers 400 to a forced choice ("tool_choice: type "tool"
 * and "any" are not supported for this model"), so a turn that reached its
 * step limit, where the policy forces `present_options`, failed outright. With
 * `forcedToolChoice: false` the step is given only that tool and told to call
 * it. Graded on the turn: it ends, and it hands back through the tool.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials. `EVAL_MODEL_ID` sets the model, `EVAL_RUNS` the runs.
 */
import { describe, expect, it } from 'vitest';

import { runAgentTurn } from '../src/orchestrator.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../src/model.js';
import { buildAgentSystemPrompt } from '../src/prompt/index.js';
import { createToolRegistry } from '../src/tools/types.js';
import { loadBuiltinTools } from '../src/tools/builtin-tools.js';
import type { TurnPolicy } from '../src/turn-policy.js';
import { LIVE_MODEL_ID, liveBedrock } from './support/bedrock.js';
import { createCanvasRoom, wordmarkBoard } from './support/canvas-room.js';

const RUNS = Number(process.env.EVAL_RUNS ?? 3);
const PERSONA = {
  name: 'Assistant',
  identity: 'You are the Assistant for a design app. You work in the user’s UI, as the user would.',
  capabilities: ['Work in the UI in real time, as the user would'],
  knowledge: [],
  workflows: [],
  instructions: [],
  fewShotExamples: [],
};

/** A step limit of two: the third step is forced to hand the turn back. */
const twoSteps: TurnPolicy = {
  classifyTurn: () => 'normal',
  prepareStep: async ({ steps }) =>
    steps.length >= 2 && !steps.some((s) => s.toolCalls?.some((c) => c.toolName === 'present_options'))
      ? {
          toolChoice: { type: 'tool', toolName: 'present_options' },
          note: 'You have used this turn’s steps. Say what is done and what is left, then offer to continue.',
        }
      : {},
};

describe(`a forced step on ${LIVE_MODEL_ID}, which may refuse a forced tool choice`, () => {
  for (let run = 1; run <= RUNS; run++) {
    it(`hands the turn back through present_options at the step limit (run ${run})`, async () => {
      const room = createCanvasRoom(wordmarkBoard(12), 'after');
      const result = await runAgentTurn(
        {
          tools: createToolRegistry(loadBuiltinTools().filter((t) => t.name === 'present_options')),
          emit: { emit: async () => {} },
          model: liveBedrock()(LIVE_MODEL_ID),
          promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
          systemPrompt: buildAgentSystemPrompt(PERSONA as never),
          maxToolRounds: 12,
          ...(process.env.EVAL_TEMPERATURE === 'none' ? { temperature: null } : {}),
          forcedToolChoice: false,
          turnPolicy: twoSteps,
          turnDeadlineMs: 170_000,
          ui: { channel: room.channel, resultTimeoutMs: 5_000 },
        },
        {
          turnId: `eval-forced-${Date.now()}-${run}`,
          conversationId: 'eval-forced',
          userId: 'eval-user',
          accountId: 'eval-account',
          socketRoom: 'agent:turn:eval-forced',
          content: 'Make the text green on every artboard from Anim 01 to Anim 12, one artboard at a time.',
          history: [{ role: 'user', content: 'Make the text green on every artboard from Anim 01 to Anim 12, one artboard at a time.' }],
          context: { currentPath: '/canvas/board-1', oui: { surfaces: [room.surface], observations: room.observations() } },
        },
      );
      const called = result.newMessages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.name) : []));
      console.log(JSON.stringify({ eval: 'forced-step', model: LIVE_MODEL_ID, run, rounds: result.rounds, stopReason: result.stopReason, called }));
      expect(result.stopReason).toBe('present_options');
      expect(called.at(-1)).toBe('present_options');
      // The forced step stopped the work: it did not run on to all twelve.
      expect(result.rounds).toBeLessThanOrEqual(4);
    });
  }
});
