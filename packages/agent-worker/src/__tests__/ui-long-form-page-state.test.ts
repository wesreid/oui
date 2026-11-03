/**
 * A long form's page state, as a tab reports it through the bindings and as the
 * model reads it: the shape `evals/long-form.live-eval.ts` drives with a live
 * model. Measured on a real form of this shape on 2026-11-03: 75 KB of page
 * state, of which the model read the first 12,000 characters, cut off mid-value,
 * and beside an editor's room none of it.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { jsonBytes, type OUIIndexSnapshot } from 'oui-spec/spec';

import { boardPage } from '../../evals/support/board-page.js';
import { DEFAULT_PAGE_STATE_CHARS, observationSchemas, observationsText, pageStateFit } from '../ui/observations.js';
import { indexText, pageFromIndex } from '../ui/page-index.js';
import { createToolRegistry } from '../tools/types.js';
import { runAgentTurn } from '../orchestrator.js';

const snapshotOf = async (times: number) => (await boardPage(times)).snapshot() as OUIIndexSnapshot;
const PAGE = 'page:BoardPage';

describe('a long form, sent and read', () => {
  for (const times of [1, 3]) {
    describe(`at ${times}× its size`, () => {
      it('sends no row its list’s schema, and its action still offers every option', async () => {
        const page = await boardPage(times);
        const snapshot = page.snapshot() as OUIIndexSnapshot;
        const state = snapshot.observations[PAGE].state as { lists: Record<string, Array<Record<string, unknown>>> };
        expect(Object.keys(state.lists).length).toBeGreaterThan(20);
        for (const rows of Object.values(state.lists)) for (const row of rows) expect(row).not.toHaveProperty('schema');
        // The row's value, and what the rows are, all stay.
        expect(state.lists['board.graphic.template'].find((r) => r.key === 'end-card')).toMatchObject({ value: 'board-6::1:1' });

        const answer = await page.channel.dispatch('room', {
          requestId: 'describe-1',
          surfaceId: 'oui',
          actionId: 'describe',
          params: { actions: [{ surface: PAGE, action: 'board_shot_transition' }] },
          timestamp: 0,
        }).then(() => page.channel.awaitResult('describe-1', { userId: 'u', timeoutMs: 1000 }));
        const definition = (answer!.data as { definitions: Array<{ action: { input: { properties: { value: { enum: string[]; description: string } } } } }> }).definitions[0].action;
        expect(definition.input.properties.value.enum).toContain('crossfade');
        expect(definition.input.properties.value.description).toContain('the two shots blend');
      });

      it('fits the snapshot’s budget, its index carrying no observation’s prose', async () => {
        const snapshot = await snapshotOf(times);
        expect(jsonBytes(snapshot)).toBeLessThan(256 * 1024);
        expect(snapshot.fit).toBeUndefined();
        const page = snapshot.index.find((s) => s.id === PAGE)!;
        expect(page.observations).toEqual([{ id: 'state' }]);
        expect(JSON.stringify(snapshot.index)).not.toContain('What the page shows now');
      });

      it('gives the model the page beside its room, fitted by rule, never cut off', async () => {
        const snapshot = await snapshotOf(times);
        const options = { schemas: observationSchemas(pageFromIndex(snapshot.index)) };
        const fit = pageStateFit(snapshot.observations, DEFAULT_PAGE_STATE_CHARS, options);
        expect(fit.outcome).toBe('fitted');
        expect(fit.omitted).toEqual([]);
        const text = observationsText(snapshot.observations, DEFAULT_PAGE_STATE_CHARS, options);
        expect(text).not.toContain('truncated from');
        expect(text).toContain('board.graphic.template');
        expect(text).toContain('board.brief');
        expect(text).toContain('room:timeline');
      });

      it('leaves its index whole for the model', async () => {
        const snapshot = await snapshotOf(times);
        expect(indexText(pageFromIndex(snapshot.index))).not.toContain('listed by id only');
      });
    });
  }

  it('says how a list that is only a count is read', async () => {
    const snapshot = await snapshotOf(3);
    const text = observationsText(snapshot.observations, 4_000, { schemas: observationSchemas(pageFromIndex(snapshot.index)) });
    expect(text).toContain('ui_read');
    expect(text).toContain('/lists/');
  });

  it('reports a page that could not fit as cut, not as fitted', () => {
    const observations = { [PAGE]: { state: { values: { 'board.brief': 'x'.repeat(20_000) }, lists: {} } } };
    expect(pageStateFit(observations, 12_000)).toMatchObject({ outcome: 'cut', chars: expect.any(Number) });
    expect(observationsText(observations, 12_000)).toContain('read what is cut with ui_read');
  });

  it('reports a page that fits as whole', () => {
    expect(pageStateFit({ [PAGE]: { state: { values: {}, lists: {} } } }, 12_000)).toEqual({ chars: expect.any(Number), outcome: 'whole', omitted: [] });
  });
});

describe('a turn’s usage log, on a long form', () => {
  const answering = () =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Done.' },
            { type: 'text-end', id: '0' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ] as never[],
        }),
      }),
    } as never);

  it('says what the page sent and how it fitted', async () => {
    const page = await boardPage();
    const snapshot = page.snapshot() as OUIIndexSnapshot;
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAgentTurn(
      {
        tools: createToolRegistry([]),
        emit: { emit: vi.fn(async () => {}) },
        model: answering() as never,
        systemPrompt: 'You are the assistant.',
        ui: { channel: page.channel, resultTimeoutMs: 1_000, maxObservationChars: DEFAULT_PAGE_STATE_CHARS },
      },
      {
        turnId: 'turn-long-form',
        conversationId: 'conv',
        userId: 'user',
        accountId: 'account',
        socketRoom: 'agent:turn:long-form',
        content: 'What is on this page?',
        history: [{ role: 'user', content: 'What is on this page?' }],
        context: { oui: snapshot },
      },
    );
    const line = logged.mock.calls.map(([text]) => String(text)).find((text) => text.includes('Turn usage'));
    logged.mockRestore();
    const { data, ...entry } = JSON.parse(line!) as { data?: { ui: Record<string, unknown> }; ui?: Record<string, unknown> };
    const ui = (data?.ui ?? entry.ui)!;
    expect(ui.snapshotBytes).toBe(jsonBytes(snapshot));
    expect(ui.snapshotCuts).toBe(0);
    expect(ui.pageState).toMatchObject({ outcome: 'fitted', omitted: [] });
    expect((ui.pageState as { chars: number }).chars).toBeGreaterThan(DEFAULT_PAGE_STATE_CHARS);
  });
});
