/**
 * Live eval: working a long form, whatever of its state fits what the model is
 * given.
 *
 * A form with a control per field per row (lines, shots, graphics) reports far
 * more page state than the model reads, beside a room with state of its own.
 * Measured on a real form of this shape on 2026-11-03: page state of 75 KB,
 * most of it the same value schema on row after row, of which the model read
 * the first 12,000 characters.
 *
 * Graded on what the page ran, never on what the model says it did, except
 * where the scenario is about what it says:
 *
 * 1. **A row near the top**: the language of the last line, one of twenty.
 * 2. **A row near the bottom**: move a graphic to another shot.
 * 3. **Two rows, two lists**: a transition on one shot, a framing on another,
 *    by what the person calls them, not by their ids.
 * 4. **A question about the bottom of the form**: what a graphic's template and
 *    layer are, in the words the form uses for them, with nothing changed.
 * 5. **An option by its words**: "dip to white" is the value `dip-white`, and a
 *    template's shape is part of an opaque value. What the model sends has to be
 *    an option the action takes, first time.
 *
 * In every case that changes something, no input may be refused: what a line of
 * the index leaves out, the model must find out before it acts, not by being
 * told its guess was wrong. Each case prints its calls, describes, reads, refused
 * inputs, rounds and tokens as `LONG-FORM {...}`, so two runs can be compared on
 * what the work cost.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live long-form` with Bedrock
 * credentials (e.g. `AWS_PROFILE=<profile> AWS_REGION=us-east-1`).
 * `EVAL_MODEL_ID` sets the model, `EVAL_RUNS` the runs per scenario, and
 * `EVAL_TEMPERATURE=none` sends no temperature, for a model that takes none.
 */
import { describe, expect, it } from 'vitest';

import { boardPage } from './support/board-page.js';
import { LIVE_MODEL_ID, liveTurn, type LiveTurn } from './support/live-page.js';

const RUNS = Number(process.env.EVAL_RUNS ?? 3);

function report(name: string, run: number, turn: LiveTurn, ran: unknown[]) {
  const count = (tool: string) => turn.calls.filter((c) => c === tool).length;
  console.log(
    `LONG-FORM ${JSON.stringify({
      name,
      run,
      ran: ran.length,
      describes: count('ui_describe'),
      reads: count('ui_read'),
      rejected: turn.rejected.length,
      calls: turn.calls.length,
      rounds: turn.rounds,
      promptTokens: turn.usage.promptTokens,
      peakPromptTokens: turn.usage.peakPromptTokens,
    })}`,
  );
}

describe(`working a long form (${LIVE_MODEL_ID})`, () => {
  for (let run = 1; run <= RUNS; run++) {
    it(`changes a row near the top (run ${run})`, async () => {
      const page = await boardPage();
      const turn = await liveTurn(page, 'Set the language of the last line, the one that says "That’s October", to French.', { path: '/board' });
      report('near-top', run, turn, page.ran);
      expect(page.ran).toEqual([{ action: 'board_line_language', params: { item: 'outro', value: 'fr' } }]);
      expect(turn.rejected).toEqual([]);
    });

    it(`changes a row near the bottom (run ${run})`, async () => {
      const page = await boardPage();
      const turn = await liveTurn(page, 'Move the KPI card onto shot 4.', { path: '/board' });
      report('near-bottom', run, turn, page.ran);
      expect(page.ran).toEqual([{ action: 'board_graphic_shot', params: { item: 'kpi', value: 'wall' } }]);
      expect(turn.rejected).toEqual([]);
    });

    it(`changes two rows in two lists (run ${run})`, async () => {
      const page = await boardPage();
      const turn = await liveTurn(page, 'Give shot 7 a crossfade transition, and make shot 8 a wide shot.', { path: '/board' });
      report('two-rows', run, turn, page.ran);
      expect(page.ran).toEqual(
        expect.arrayContaining([
          { action: 'board_shot_transition', params: { item: 'chart-area', value: 'crossfade' } },
          { action: 'board_shot_framing', params: { item: 'close', value: 'wide' } },
        ]),
      );
      expect(page.ran).toHaveLength(2);
      expect(turn.rejected).toEqual([]);
    });

    it(`picks an option by its words, first time (run ${run})`, async () => {
      const page = await boardPage();
      const turn = await liveTurn(page, 'Use a dip to white for shot 5, and put the end card on the KPI wall template in its 9:16 shape.', { path: '/board' });
      report('by-words', run, turn, page.ran);
      expect(page.ran).toEqual(
        expect.arrayContaining([
          { action: 'board_shot_transition', params: { item: 'chart', value: 'dip-white' } },
          { action: 'board_graphic_template', params: { item: 'end-card', value: 'board-4::9:16' } },
        ]),
      );
      expect(page.ran).toHaveLength(2);
      expect(turn.rejected).toEqual([]);
    });

    it(`answers about the bottom of the form (run ${run})`, async () => {
      const page = await boardPage();
      const turn = await liveTurn(page, 'Which template does the end card use, in which shape, and which layer is the lower third on?', { path: '/board' });
      report('question', run, turn, page.ran);
      expect(page.ran).toEqual([]);
      expect(turn.reply).toMatch(/end card/i);
      expect(turn.reply).toMatch(/1:1/);
      expect(turn.reply).toMatch(/overlay/i);
    });
  }
});
