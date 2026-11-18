/**
 * Live eval: does the model answer from a tool's result when the turn's
 * context is sent beside it?
 *
 * A dealer's assistant on a live video call is asked "What am I wearing?" with
 * an earlier question (7:00 or 7:30 tomorrow?) still open, and a host step
 * context that speaks of "their newest message" and of that appointment. Its
 * first round calls `look` (scripted, so every run reaches the same round 2),
 * the call service's look route answers with one of the two answers Closure's
 * look route gave on dev, and round 2 goes to the real model as the worker
 * assembles it, under each `turnContextPlacement`:
 *
 * - `after-conversation` (0.30 and earlier): the turn's context after the
 *   tool result, where it reads as the caller's newest message;
 * - `with-message` (the default): the turn's context with the turn's message,
 *   before the tool call.
 *
 * Correct: the reply says what the look said (the suit, or that the picture
 * is dark), and never that the caller's message was blank. Run with and
 * without a page beside the call (a stage showing a vehicle), whose state is
 * read after the conversation either way.
 *
 * On Claude Haiku 5.5 with thinking off, the dealer agent's model (2026-11-18,
 * 10 runs per answer): `after-conversation` 0–6 of 20, `with-message` 20 of
 * 20, with and without the page. A framed `<turn_context>` block after the
 * result, explained in the system prompt, did no better (1–8 of 20).
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials (e.g. `AWS_PROFILE=<profile> AWS_REGION=us-east-1`).
 * `EVAL_MODEL_ID` sets the model (default the dealer agent's,
 * `us.anthropic.claude-haiku-5-5`, sent with thinking off and no
 * temperature, as the dealer agent sends it), `EVAL_RUNS` the runs per answer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulateReadableStream, wrapLanguageModel } from 'ai';

import { runAgentTurn } from '../src/orchestrator.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../src/model.js';
import { buildAgentSystemPrompt } from '../src/prompt/index.js';
import { createToolRegistry } from '../src/tools/types.js';
import type { TurnContextPlacement } from '../src/step-messages.js';
import type { TurnHistoryMessage } from '../src/types.js';
import { liveBedrock } from './support/bedrock.js';
import { livePage } from './support/live-page.js';

const MODEL_ID = process.env.EVAL_MODEL_ID ?? 'us.anthropic.claude-haiku-5-5';
const RUNS = Number(process.env.EVAL_RUNS ?? 10);

/** What Closure's look route answered on dev, word for word. */
const ANSWERS = {
  suit: 'You’re wearing a dark navy suit with a light blue shirt, a blue textured tie, and a white pocket square. You also have a beaded bracelet on your wrist.',
  dark: 'I can’t make out anything in this image; it’s almost entirely black, so I can’t tell what you’re wearing. Your camera may be covered, too dark, or not yet showing the video feed.',
} as const;
type AnswerKind = keyof typeof ANSWERS;

/** A reply that uses the look: what it said, in the reply's own words. */
const USES: Record<AnswerKind, RegExp> = {
  suit: /navy|suit|\btie\b|pocket square|light blue|bracelet/i,
  dark: /\bdark|black|can[’']?t (make out|see|tell)|cannot (make out|see|tell)|covered/i,
};
/** A reply that reads the turn's context as the caller's newest message. */
const BLANK = /(message|that)[^.]{0,40}\b(blank|empty)\b|came through (blank|empty)|didn[’']?t (catch|get|hear) (that|what|your)|no message/i;

const PERSONA = {
  name: 'Ava',
  identity: 'You are Ava, the virtual assistant of Riverside Toyota, on a live video call with a customer. You help with sales and service.',
  capabilities: ['Answer questions about the store, its vehicles and its service department', 'Book service appointments'],
  knowledge: [],
  workflows: [],
  instructions: [],
  fewShotExamples: [],
};

const HISTORY: TurnHistoryMessage[] = [
  { role: 'user', content: 'Hi, I need to bring my Highlander in for an oil change.' },
  { role: 'assistant', content: 'Happy to help with that. What day works best for you?' },
  { role: 'user', content: 'Tomorrow evening. Do you have 7:00 or 7:30 open?' },
  { role: 'assistant', content: 'Let me check tomorrow evening for you.' },
];
const QUESTION = 'Actually, hang on. Can you see me? What am I wearing right now?';

/** A dealer host's step context, in the shape the dealer agent sends: tools first, the open question, what to learn next. */
const STEP_CONTEXT = [
  'Use the tools this message needs before you answer: make every tool call first. Before a lookup you may say one short line that reacts to what they asked and says what you are pulling up ("Let me pull up that Highlander."); never "One moment" on its own, never an answer, a time or an outcome before its result, and nothing else (not even your introduction). Then say your answer once, after the last result, and never repeat in it anything you already said in this turn.',
  'The customer asked earlier whether 7:00 or 7:30 tomorrow evening is open for an oil change, and that is not answered yet. If their newest message is about the appointment, check the service times before you answer, and offer the times that are open.',
  'What is known of what they need: service (oil change) for a Toyota Highlander, tomorrow evening. The one thing to learn next: which time they want, then their phone number to book it.',
].join('\n');

const NO_USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

let server: http.Server;
let lookUrl = '';
/** What the look route answers: the eval's runs of one answer go together. */
let lookAnswer = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ looked: true, answer: lookAnswer, frames: 1, newestAgeMs: 700 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  lookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vision/look`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The live model, its first round scripted: a short line, and `look`. */
function lookingModel(run: number) {
  let calls = 0;
  return wrapLanguageModel({
    model: liveBedrock()(MODEL_ID),
    middleware: {
      wrapStream: async ({ doStream }: { doStream: () => Promise<unknown> }) => {
        calls++;
        if (calls > 1) return doStream();
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'Let me take a look.' },
              { type: 'text-end', id: '0' },
              { type: 'tool-call', toolCallId: `toolu_look_${run}`, toolName: 'look', input: JSON.stringify({ question: 'What is the caller wearing?' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: NO_USAGE },
            ] as never[],
          }),
        } as never;
      },
    } as never,
  });
}

/** A stage beside the call, showing a vehicle: its state is read after the conversation. */
const stage = () =>
  livePage([
    {
      id: 'stage',
      name: 'Stage',
      description: 'What the caller sees beside the call: a vehicle, a service menu or the store’s hours.',
      actions: [
        { id: 'show_vehicle', description: 'Show a vehicle on the stage.', input: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] } },
        { id: 'show_service_times', description: 'Show the open service times for a day.', input: { type: 'object', properties: { day: { type: 'string' } }, required: ['day'] } },
      ],
      observations: () => ({ showing: { kind: 'vehicle', model: 'Toyota Highlander XLE 2024', price: '$43,250' } }),
    },
  ]);

/** One look turn; its reply after the look. */
async function lookTurn(placement: TurnContextPlacement, withPage: boolean, run: number): Promise<string> {
  const page = withPage ? stage() : null;
  const result = await runAgentTurn(
    {
      tools: createToolRegistry([]),
      emit: { emit: async () => {} },
      model: lookingModel(run),
      promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
      systemPrompt: buildAgentSystemPrompt(PERSONA as never),
      maxToolRounds: 4,
      maxTokens: 2_000,
      temperature: null,
      modelProviderOptions: { amazonBedrock: { additionalModelRequestFields: { thinking: { type: 'disabled' } } } },
      turnDeadlineMs: 60_000,
      turnContextPlacement: placement,
      ...(page ? { ui: { channel: page.channel, resultTimeoutMs: 5_000 } } : {}),
    },
    {
      turnId: `eval-turn-context-${placement}-${run}-${Date.now()}`,
      conversationId: 'eval-turn-context',
      userId: 'eval-user',
      accountId: 'eval-account',
      socketRoom: 'agent:turn:eval-turn-context',
      content: QUESTION,
      history: [...HISTORY, { role: 'user', content: QUESTION }],
      context: { timeZone: 'America/New_York', output: { mode: 'voice' }, ...(page ? { oui: page.snapshot() } : {}) },
      vision: {
        seeing: true,
        remarks: false,
        canLook: true,
        absent: null,
        look: { url: lookUrl, token: 'eval-look-token', expiresAt: new Date(Date.now() + 600_000).toISOString() },
        observation: null,
      },
      stepContext: STEP_CONTEXT,
    },
  );
  const rounds = result.newMessages.filter((m) => m.role === 'assistant').map((m) => m.content ?? '');
  // The scripted first round said its line; the reply is what came after the look.
  return rounds.slice(1).join(' ').trim();
}

describe(`the turn's context on a look turn's second round (${MODEL_ID})`, () => {
  for (const withPage of [false, true]) {
    it(`answers from the look with the turn's context with its message${withPage ? ', a page beside the call' : ''}`, async () => {
      const rates: Partial<Record<TurnContextPlacement, number>> = {};
      for (const placement of ['after-conversation', 'with-message'] as const) {
        let correct = 0;
        let total = 0;
        for (const kind of Object.keys(ANSWERS) as AnswerKind[]) {
          lookAnswer = ANSWERS[kind];
          const replies = await Promise.all(Array.from({ length: RUNS }, (_, run) => lookTurn(placement, withPage, run)));
          for (const reply of replies) {
            const ok = USES[kind].test(reply) && !BLANK.test(reply);
            correct += ok ? 1 : 0;
            total++;
            console.log(JSON.stringify({ eval: 'turn-context', placement, page: withPage, answer: kind, correct: ok, reply }));
          }
        }
        rates[placement] = correct / total;
        console.log(JSON.stringify({ eval: 'turn-context', model: MODEL_ID, placement, page: withPage, correct, of: total }));
      }
      // The default answers from the look nearly every time.
      expect(rates['with-message']).toBeGreaterThanOrEqual(0.9);
    }, 600_000);
  }
});
