/**
 * Live capability eval (ADR-0244 §2.9): can the assistant find, read, change
 * and verify things in a room that holds a real document?
 *
 * Each scenario is a turn the 2026-10-02 vector studio session's assistant
 * could not carry out. It runs through the worker itself (`runAgentTurn`: its
 * UI tools, its page-state fitting, its turn record, its operating rules)
 * against a design canvas that really edits its document, and it is graded on
 * the document afterwards — never on what the model said it did, except where
 * the scenario is about what it says.
 *
 * 1. **Find by name** — in a board of 50 artboards, change the layer on the
 *    one the person names. The layer list does not fit the page state.
 * 2. **Centre an anchor** — make a layer pivot about its middle without moving it.
 * 3. **Variations from a source** — copies that carry the source's styling and
 *    do not lie on one another.
 * 4. **Say what did not happen** — an edit that part of the board refuses; the
 *    reply names what was left unchanged.
 *
 * `EVAL_PLATFORM=before` runs the same scenarios against the room as rooms
 * were before ADR-0244 (lists cut to a count, no readers, ids only, results
 * without `changed`, a 6,000-character page state): the baseline. The default,
 * `after`, is the platform as it is.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials (e.g. `AWS_PROFILE=<profile> AWS_REGION=us-east-1`).
 * `EVAL_MODEL_ID` sets the model, `EVAL_RUNS` the runs per scenario, and
 * `EVAL_TEMPERATURE=none` sends no temperature, for a model that takes none.
 */
import { describe, expect, it } from 'vitest';

import { runAgentTurn } from '../src/orchestrator.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../src/model.js';
import { buildAgentSystemPrompt } from '../src/prompt/index.js';
import { createToolRegistry } from '../src/tools/types.js';
import { loadBuiltinTools } from '../src/tools/builtin-tools.js';
import { LIVE_MODEL_ID, liveBedrock } from './support/bedrock.js';
import {
  createCanvasRoom,
  layerBox,
  textWidth,
  wordmarkBoard,
  type CanvasDocument,
  type CanvasLayer,
  type Platform,
} from './support/canvas-room.js';

const RUNS = Number(process.env.EVAL_RUNS ?? 3);
const PLATFORM: Platform = process.env.EVAL_PLATFORM === 'before' ? 'before' : 'after';
const bedrock = liveBedrock();

const PERSONA = {
  name: 'Assistant',
  identity: 'You are the Assistant for a design app. You work in the user’s UI, as the user would.',
  capabilities: ['Work in the UI in real time, as the user would'],
  knowledge: [],
  workflows: [],
  instructions: [],
  fewShotExamples: [],
};

/** A turn as the product runs one: the SDK's prompt, the room's tools, the step limit Closure's turn policy sets. */
async function turn(document: CanvasDocument, request: string) {
  const room = createCanvasRoom(document, PLATFORM);
  const result = await runAgentTurn(
    {
      tools: createToolRegistry(loadBuiltinTools().filter(t => t.name === 'present_options')),
      emit: { emit: async () => {} },
      model: bedrock(LIVE_MODEL_ID),
      promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
      systemPrompt: buildAgentSystemPrompt(PERSONA),
      maxToolRounds: 24,
      // A model that takes no temperature (Claude Sonnet 5.5 on Bedrock) is sent none.
      ...(process.env.EVAL_TEMPERATURE === 'none' ? { temperature: null } : {}),
      turnDeadlineMs: 170_000,
      ui: { channel: room.channel, resultTimeoutMs: 5_000, ...(PLATFORM === 'before' ? { maxObservationChars: 6_000 } : {}) },
    },
    {
      turnId: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: 'eval',
      userId: 'eval-user',
      accountId: 'eval-account',
      socketRoom: 'agent:turn:eval',
      content: request,
      history: [{ role: 'user', content: request }],
      context: { currentPath: '/canvas/board-1', oui: { surfaces: [room.surface], observations: room.observations() } },
    },
  );
  const reply = result.newMessages
    .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
    .map(m => m.content as string)
    .join('\n');
  return { room, reply, calls: room.requests.map(r => r.actionId), rounds: result.rounds };
}

const byArtboard = (document: CanvasDocument, name: string) => {
  const artboard = document.artboards.find(a => a.name === name)!;
  return document.layers.filter(l => l.artboardId === artboard.id);
};

/** Whether a CSS colour is pure green, however it is written. */
const green = (colour: string) => ['#00ff00', '#0f0', 'lime', 'rgb(0,255,0)'].includes(colour.toLowerCase().replace(/\s+/g, ''));

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function report(scenario: string, run: number, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ eval: 'pa-capability', platform: PLATFORM, model: LIVE_MODEL_ID, scenario, run, ...detail }));
}

describe(`pa-capability on ${LIVE_MODEL_ID} (${PLATFORM})`, () => {
  for (let run = 1; run <= RUNS; run++) {
    it(`finds the layer on the artboard the person names, among 50 (run ${run})`, async () => {
      const document = wordmarkBoard(50);
      const before = structuredClone(document);
      const { room, calls, reply } = await turn(document, 'Make the text on Anim 37 pure green, #00ff00. Leave everything else as it is.');
      const [target] = byArtboard(room.document, 'Anim 37');
      const others = room.document.layers.filter(l => l.id !== target.id);
      const untouched = others.every(l => JSON.stringify(l) === JSON.stringify(before.layers.find(b => b.id === l.id)));
      report('find-by-name', run, { fill: target.fill, untouched, calls, asked: /\b(id|ids)\b.*\?/i.test(reply) });
      expect(green(target.fill), `Anim 37's text is ${target.fill}; the reply was: ${reply}`).toBe(true);
      expect(untouched, 'another layer was changed').toBe(true);
      expect(room.document.layers).toHaveLength(50);
    });

    it(`centres a layer's anchor without moving it (run ${run})`, async () => {
      const document = wordmarkBoard(3);
      const [layer] = byArtboard(document, 'Anim 02');
      const was = layerBox(document, layer);
      const { room, calls, reply } = await turn(
        document,
        'On Anim 02, set the text’s anchor point to the middle of the text, so it scales from its centre. It must stay exactly where it is.',
      );
      const [now] = byArtboard(room.document, 'Anim 02') as CanvasLayer[];
      const box = layerBox(room.document, now);
      const moved = Math.max(...box.map((v, i) => Math.abs(v - was[i])));
      // The content's middle: half its width along the baseline, half its height above it.
      const wanted = [textWidth(now) / 2 / 900, -now.size / 2 / 500];
      const off = Math.max(Math.abs(now.anchor[0] - wanted[0]) * 900, Math.abs(now.anchor[1] - wanted[1]) * 500);
      report('centre-anchor', run, { anchor: now.anchor, wanted, movedPx: moved, anchorOffPx: off, calls });
      expect(off, `the anchor is ${JSON.stringify(now.anchor)}, ${off.toFixed(1)} px from the text's middle; the reply was: ${reply}`).toBeLessThan(2);
      expect(moved, `the layer moved ${moved.toFixed(1)} px`).toBeLessThan(1);
    });

    it(`makes variations from a source artboard that carry its styling and do not overlap (run ${run})`, async () => {
      const document = wordmarkBoard(2);
      document.artboards[0].name = 'Hero';
      Object.assign(document.layers[0], { fill: '#41c8ff', size: 160, position: [0.173, 0.6164] });
      const { room, calls, reply } = await turn(
        document,
        'Use the Hero artboard as the source and make 5 variations of it, named Var 01 to Var 05. Each must look exactly like Hero for now.',
      );
      const variations = room.document.artboards.filter(a => /^Var 0[1-5]$/.test(a.name));
      const styled = variations.map(a => room.document.layers.filter(l => l.artboardId === a.id));
      const faithful = styled.every(
        layers =>
          layers.length === 1 &&
          layers[0].fill.toLowerCase() === '#41c8ff' &&
          layers[0].size === 160 &&
          layers[0].text === 'TRAIDR' &&
          Math.abs(layers[0].position[0] - 0.173) < 0.002 &&
          Math.abs(layers[0].position[1] - 0.6164) < 0.002,
      );
      const overlapping = room.document.artboards.flatMap((a, i) =>
        room.document.artboards.slice(i + 1).filter(b => overlap(a, b)).map(b => `${a.name}/${b.name}`),
      );
      report('variations', run, { made: variations.map(a => a.name), faithful, overlapping, calls });
      expect(variations.map(a => a.name).sort(), `the reply was: ${reply}`).toEqual(['Var 01', 'Var 02', 'Var 03', 'Var 04', 'Var 05']);
      expect(faithful, 'a variation does not carry Hero’s text as it is').toBe(true);
      expect(overlapping).toEqual([]);
    });

    it(`says what it could not change (run ${run})`, async () => {
      const document = wordmarkBoard(6);
      const locked = [byArtboard(document, 'Anim 02')[0], byArtboard(document, 'Anim 05')[0]];
      for (const layer of locked) layer.locked = true;
      const { room, calls, reply } = await turn(document, 'Set every text layer’s size to 120.');
      const sizes = Object.fromEntries(room.document.artboards.map(a => [a.name, byArtboard(room.document, a.name)[0].size]));
      const named = ['Anim 02', 'Anim 05'].every(name => reply.includes(name)) || /\b(two|2)\b[^.]*\block/i.test(reply);
      report('say-what-failed', run, { sizes, named, calls });
      // What could be changed was; what was locked was not.
      expect(sizes).toEqual({ 'Anim 01': 120, 'Anim 02': 96, 'Anim 03': 120, 'Anim 04': 120, 'Anim 05': 96, 'Anim 06': 120 });
      // And the reply says so, naming what was left: not "all six are now 120".
      expect(reply, 'the reply does not say the locked layers were left').toMatch(/lock/i);
      expect(named, `the reply does not say which were left: ${reply}`).toBe(true);
    });
  }
});
