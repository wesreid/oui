/**
 * Live eval: a turn whose reply and note belong together ("decide and reply"),
 * with the note written as a trailer (`RegisteredTool.trailer`), on live models.
 *
 * Claude Sonnet 5.5 and Opus 5.5 make an answerless `note` call alone in a
 * step: a response ends at the tool call, so the reply costs one more model
 * call, and no wording of the prompt changed that. A trailer is text, so the
 * reply and the note arrive in one call. Graded per run: one model call, the
 * note written, nothing of the trailer in the reply, and no call that could not
 * be read. A few runs of today's form (the note declared as a tool, with a rule
 * to give it beside the step's other calls) measure what the trailer saves:
 * model calls, and the first call's input tokens.
 *
 * Run: `AWS_PROFILE=<profile> pnpm --filter @ouispec/agent-worker eval:live evals/trailer-note.live-eval.ts`.
 * `EVAL_MODEL_IDS` (comma-separated) sets the models, `EVAL_RUNS` the trailer
 * runs per model (20), `EVAL_BASELINE_RUNS` today's form's (5).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { runAgentTurn } from '../src/orchestrator.js';
import { createToolRegistry, type RegisteredTool } from '../src/tools/types.js';
import { isTrailerCallId } from '../src/tools/trailer.js';
import type { AgentTurnResult } from '../src/types.js';
import { liveBedrock } from './support/bedrock.js';

const MODELS = (process.env.EVAL_MODEL_IDS ?? 'us.anthropic.claude-haiku-5-5,us.anthropic.claude-sonnet-5-5,us.anthropic.claude-opus-5-5')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const RUNS = Number(process.env.EVAL_RUNS ?? 20);
const BASELINE_RUNS = Number(process.env.EVAL_BASELINE_RUNS ?? 5);

const SYSTEM_PROMPT = [
  'You are the assistant in a poster design app. You help the person plan and make posters, and you keep this chat’s work notes,',
  'which are shown to you on every turn, so that what was decided is never lost however long the chat gets.',
  '',
  '## How you work',
  '- Answer in a few plain sentences. Say what you did or decided, not how.',
  '- When the person decides something, confirm it in your reply and record it as a `decision` note.',
  '- When something is left to do, record it as a `task` note.',
  '- Never ask the person to repeat a decision that is in the notes.',
].join('\n');

/** Today's form: the rule a host adds so the note is given beside the step's other calls (about its size). */
const NOTE_IN_STEP_RULE =
  '\n\nWhen you write a note, give it beside the other calls of the step it belongs to, never in a step of its ' +
  'own: when only the reply is left, it goes with your last actions.';

/** A product's note tool, as a host declares its memory's `note`. */
function noteTool(trailer: boolean, written: Array<Record<string, unknown>>): RegisteredTool {
  return {
    name: 'note',
    effect: 'edit',
    answerless: true,
    ...(trailer ? { trailer: true } : {}),
    description:
      'Write one line in this chat’s work notes, or close one. The notes are shown to you on every turn and survive however ' +
      'long the chat gets, so they are how you still know, a hundred messages on, what was agreed. Record: a decision the person ' +
      'made (`decision`); something still to do (`task`); something made that no page goes on holding, with where it is and its ' +
      'id (`made`). To close a task that is done, give its id as `close`.',
    inputSchema: {
      type: 'object',
      sideEffects: false,
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['made', 'decision', 'task'], description: 'What the note is. Required to write one.' },
        text: { type: 'string', maxLength: 600, description: 'One line, in the person’s own terms: what was decided, what is left to do, or what was made.' },
        title: { type: 'string', maxLength: 200, description: 'The thing’s name as the page shows it, for `made`.' },
        where: { type: 'string', maxLength: 500, description: 'The route that opens it, starting with "/".' },
        ref: { type: 'string', maxLength: 200, description: 'Its id, when it has one.' },
        close: { type: 'string', minLength: 8, description: 'The id of a note to close, as the notes show it. Given alone.' },
      },
    },
    async execute(input) {
      written.push(input);
      return { success: true, data: { id: `note-${written.length}`, kind: input.kind, text: input.text } };
    },
  };
}

const SAID = 'Let’s go with the warm palette for the festival poster, not the cool one, and keep the title exactly as it is.';
const HISTORY = [
  { role: 'user' as const, content: 'I have two palettes for the festival poster: a warm one (orange, red, cream) and a cool one (teal, navy, white).' },
  { role: 'assistant' as const, content: 'Both work. The warm one feels like a summer evening; the cool one is calmer and reads better small. Which way do you want to go?' },
];

interface Run {
  model: string;
  mode: 'trailer' | 'tool';
  run: number;
  modelCalls: number;
  firstCallInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  noteWritten: boolean;
  trailerInReply: boolean;
  viaTrailer: boolean;
  invalidCalls: number;
  stopReason: string;
  answerlessEnd: AgentTurnResult['answerlessEnd'] | null;
}
const runs: Run[] = [];

async function decideAndReply(model: string, mode: Run['mode'], run: number): Promise<Run> {
  const written: Array<Record<string, unknown>> = [];
  // Each model call's input tokens, as the provider reported them at its finish.
  const callInputs: number[] = [];
  const measured = wrapLanguageModel({
    model: liveBedrock()(model),
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const at = callInputs.push(0) - 1;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === 'finish') callInputs[at] = part.usage.inputTokens.total ?? 0;
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
  const tokens: string[] = [];
  const result = await runAgentTurn(
    {
      tools: createToolRegistry([noteTool(mode === 'trailer', written)]),
      emit: {
        emit: async (_room, event, data) => {
          if (event === 'agent:token') tokens.push(String((data as { text?: unknown }).text ?? ''));
        },
      },
      model: measured,
      systemPrompt: mode === 'tool' ? SYSTEM_PROMPT + NOTE_IN_STEP_RULE : SYSTEM_PROMPT,
      // The current models take no temperature.
      temperature: null,
      maxToolRounds: 6,
      turnDeadlineMs: 170_000,
    },
    {
      turnId: `eval-trailer-${mode}-${Date.now()}-${run}`,
      conversationId: 'eval-trailer',
      userId: 'eval-user',
      accountId: 'eval-account',
      socketRoom: 'agent:turn:eval-trailer',
      content: SAID,
      history: [...HISTORY, { role: 'user', content: SAID }],
      context: { timeZone: 'Europe/Paris' },
    },
  );
  const reply = result.newMessages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content ?? '')
    .join('\n');
  const calls = result.newMessages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
  const invalid = result.newMessages.filter((m) => m.role === 'tool' && /"invalidInput":true|"unavailable":true/.test(m.content ?? '')).length;
  const record: Run = {
    model,
    mode,
    run,
    modelCalls: callInputs.length,
    firstCallInputTokens: callInputs[0] ?? 0,
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
    noteWritten: written.some((w) => w.kind === 'decision'),
    trailerInReply: /<oui:/.test(reply) || tokens.some((t) => t.includes('<oui:')),
    viaTrailer: calls.some((c) => c.name === 'note' && isTrailerCallId(c.id)),
    invalidCalls: invalid,
    stopReason: result.stopReason,
    answerlessEnd: result.answerlessEnd ?? null,
  };
  console.log(JSON.stringify({ eval: 'trailer-note', ...record, reply }));
  runs.push(record);
  return record;
}

afterAll(() => {
  const summary = MODELS.map((model) => {
    const of = (mode: Run['mode']) => runs.filter((r) => r.model === model && r.mode === mode);
    const stats = (rs: Run[]) =>
      rs.length === 0
        ? null
        : {
            runs: rs.length,
            oneCall: rs.filter((r) => r.modelCalls <= 1).length,
            meanModelCalls: rs.reduce((n, r) => n + r.modelCalls, 0) / rs.length,
            noteWritten: rs.filter((r) => r.noteWritten).length,
            viaTrailer: rs.filter((r) => r.viaTrailer).length,
            trailerInReply: rs.filter((r) => r.trailerInReply).length,
            invalidCallRate: rs.reduce((n, r) => n + r.invalidCalls, 0) / rs.length,
            meanFirstCallInputTokens: Math.round(rs.reduce((n, r) => n + r.firstCallInputTokens, 0) / rs.length),
            meanTurnInputTokens: Math.round(rs.reduce((n, r) => n + r.inputTokens, 0) / rs.length),
            meanTurnOutputTokens: Math.round(rs.reduce((n, r) => n + r.outputTokens, 0) / rs.length),
          };
    return { model, trailer: stats(of('trailer')), tool: stats(of('tool')) };
  });
  console.log(JSON.stringify({ eval: 'trailer-note-summary', summary }, null, 2));
});

for (const model of MODELS) {
  describe(`decide and reply on ${model}, the note written as a trailer`, () => {
    for (let run = 1; run <= RUNS; run++) {
      it(`replies and notes the decision in one model call (run ${run})`, async () => {
        const r = await decideAndReply(model, 'trailer', run);
        expect.soft(r.modelCalls).toBeLessThanOrEqual(1);
        expect.soft(r.noteWritten).toBe(true);
        expect.soft(r.viaTrailer).toBe(true);
        expect.soft(r.trailerInReply).toBe(false);
        expect.soft(r.invalidCalls).toBe(0);
      });
    }
  });

  describe(`decide and reply on ${model}, today's form: the note declared as a tool (measured, not graded)`, () => {
    for (let run = 1; run <= BASELINE_RUNS; run++) {
      it(`run ${run}`, async () => {
        const r = await decideAndReply(model, 'tool', run);
        expect(r.stopReason).toBeTruthy();
      });
    }
  });
}
