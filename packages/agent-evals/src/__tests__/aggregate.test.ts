/**
 * The matrix's figures, from cases written out by hand: percentiles, the
 * spread across runs, pass rates over the cases judged (a case the judge
 * could not decide and a case the guard stopped are neither passed nor
 * failed), cost per completed task over everything spent, a run's cost only
 * when the run finished, each category, and the picks within the points of
 * the best.
 */
import { describe, expect, it } from 'vitest';
import { leadersOf, percentile, percentiles, spreadOf, summarizeModel, type MatrixCase, type MatrixTurn, type ModelSummary } from '../aggregate.js';
import { callCost, callsCost, type EvalCandidate } from '../models.js';
import { turnUsage, type EvalModelCall } from '../usage.js';

const MODEL: EvalCandidate = {
  id: 'model-a',
  label: 'A',
  capabilities: { promptCache: true, forcedToolChoice: true, temperature: true, vision: false },
  prices: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

const call = (over: Partial<EvalModelCall> = {}): EvalModelCall => ({
  inputTokens: 10_000,
  noCacheTokens: 1_000,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 1_000,
  outputTokens: 500,
  finishReason: 'stop',
  firstTokenMs: 400,
  durationMs: 2_000,
  ...over,
});

const turn = (calls: EvalModelCall[], over: Partial<MatrixTurn> = {}): MatrixTurn => ({
  turn: 0,
  kind: 'user',
  customer: 'hi',
  reply: 'hello',
  working: '',
  toolCalls: [],
  held: false,
  usage: turnUsage(calls),
  invalidToolCalls: 0,
  refusal: null,
  costUsd: callsCost(calls, MODEL.prices),
  outcome: 'completed',
  ...over,
});

const matrixCase = (over: Partial<MatrixCase> & Pick<MatrixCase, 'scenario' | 'run' | 'status'>, turns: MatrixTurn[] = [turn([call()])]): MatrixCase => ({
  suite: 's',
  title: over.scenario,
  channel: 'web_chat',
  tags: [],
  model: MODEL.id,
  failures: [],
  turns,
  costUsd: turns.reduce((sum, t) => sum + t.costUsd, 0),
  judgeCostUsd: null,
  modelRequests: turns.reduce((n, t) => n + t.usage.calls.length, 0),
  durationMs: 1,
  cassette: '',
  ...over,
});

/** One call's cost at MODEL's prices: 1,000 × $2 + 8,000 × $0.20 + 1,000 × $2.50 + 500 × $10, per million. */
const ONE_CALL = (1_000 * 2 + 8_000 * 0.2 + 1_000 * 2.5 + 500 * 10) / 1e6;

describe('figures', () => {
  it('prices a call by its uncached input, cache reads, cache writes and output', () => {
    expect(callCost(call(), MODEL.prices)).toBeCloseTo(ONE_CALL, 12);
    expect(ONE_CALL).toBeCloseTo(0.0111, 12);
    expect(callsCost([call(), call({ outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 })], MODEL.prices)).toBeCloseTo(ONE_CALL, 12);
    expect(callsCost([call()], undefined)).toBe(0);
  });

  it('interpolates percentiles between the nearest ranks', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentiles([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])).toEqual({ p50: 550, p90: 910, samples: 10 });
  });

  it('spreads a figure over the runs that have one', () => {
    expect(spreadOf([0.75, null, 0.5, 1])).toEqual({ mean: 0.75, min: 0.5, max: 1, values: [0.75, null, 0.5, 1] });
    expect(spreadOf([null, null])).toBeNull();
  });

  it('times a turn to its first token across calls that produced none', () => {
    const usage = turnUsage([call({ firstTokenMs: null, durationMs: 1_500 }), call({ firstTokenMs: 250, durationMs: 900 })]);
    expect(usage.firstTokenMs).toBe(1_750);
    expect(usage.modelMs).toBe(2_400);
    expect(turnUsage([]).firstTokenMs).toBeNull();
  });
});

describe('a model’s summary', () => {
  // Three scenarios × two runs: run 1 whole, run 2 stopped by the guard on its last case.
  const cases: MatrixCase[] = [
    matrixCase({ scenario: 'a', run: 1, status: 'passed', tags: ['edit'] }),
    matrixCase({ scenario: 'b', run: 1, status: 'failed', tags: ['edit', 'plan'] }, [turn([call(), call({ firstTokenMs: 900 })], { invalidToolCalls: 2 })]),
    matrixCase({ scenario: 'c', run: 1, status: 'unjudged' }, [turn([call()], { refusal: 'reply' }), turn([], { held: true, costUsd: 0 })]),
    matrixCase({ scenario: 'a', run: 2, status: 'passed', tags: ['edit'] }),
    matrixCase({ scenario: 'b', run: 2, status: 'passed', tags: ['edit', 'plan'] }, [turn([call({ finishReason: 'content-filter' })], { refusal: 'provider' })]),
    matrixCase({ scenario: 'c', run: 2, status: 'stopped' }, [turn([call({ outputTokens: 99_999 })])]),
  ];
  const summary = summarizeModel(MODEL, cases, 2, 3);

  it('counts every case, and rates passes over the cases judged', () => {
    expect(summary.cases).toEqual({ total: 6, ran: 5, stopped: 1, judged: 4, passed: 3, failed: 1, unjudged: 1 });
    expect(summary.passRate).toBe(0.75);
    // Run 1: 1 of 2 judged; run 2: 2 of 2 (the stopped case is left out).
    expect(summary.passRateByRun).toEqual({ mean: 0.75, min: 0.5, max: 1, values: [0.5, 1] });
  });

  it('costs everything it ran, failures included, per case passed; and a run only when it finished', () => {
    // Ran: a(1) b(2 calls) c(1) a(1) b(1) = 6 calls; the stopped case's call is left out.
    expect(summary.cost.totalUsd).toBeCloseTo(6 * ONE_CALL, 12);
    expect(summary.cost.perCompletedTaskUsd).toBeCloseTo((6 * ONE_CALL) / 3, 12);
    expect(summary.cost.perRunUsd!.values[1]).toBeNull();
    expect(summary.cost.perRunUsd!.values[0]).toBeCloseTo(4 * ONE_CALL, 12);
    expect(summary.cost.perTurnUsd).toBeCloseTo((6 * ONE_CALL) / 5, 12);
  });

  it('sums tokens with the cache split, over the turns that called the model', () => {
    expect(summary.turns).toBe(5);
    expect(summary.modelCalls).toEqual({ total: 6, perTurn: 1.2, maxPerTurn: 2 });
    expect(summary.tokens).toEqual({
      input: 60_000,
      noCache: 6_000,
      cacheRead: 48_000,
      cacheWrite: 6_000,
      output: 3_000,
      cachedShare: 0.8,
      perTurn: { input: 12_000, output: 600 },
      peakCallInput: 10_000,
    });
  });

  it('reports latency, invalid tool calls and refusals per turn', () => {
    expect(summary.latencyMs.firstToken).toEqual({ p50: 400, p90: 400, samples: 5 });
    expect(summary.latencyMs.total).toEqual({ p50: 2_000, p90: 3_200, samples: 5 });
    // Model time of every case that ran (a 2 s, b 4 s, c 2 s, a 2 s, b 2 s), failures included, per case passed.
    expect(summary.latencyMs.perCompletedTask).toBe(12_000 / 3);
    expect(summary.invalidToolCalls).toEqual({ total: 2, perTurn: 0.4 });
    expect(summary.refusals).toEqual({ total: 2, provider: 1, reply: 1 });
  });

  it('rates each category, scenarios with no tag under `untagged`', () => {
    expect(Object.keys(summary.categories)).toEqual(['edit', 'plan', 'untagged']);
    expect(summary.categories.edit).toMatchObject({ cases: 4, judged: 4, passed: 3, passRate: 0.75 });
    expect(summary.categories.edit.costPerCompletedTaskUsd).toBeCloseTo((5 * ONE_CALL) / 3, 12);
    expect(summary.categories.edit.modelMsPerCompletedTask).toBe(10_000 / 3);
    expect(summary.categories.plan).toMatchObject({ cases: 2, judged: 2, passed: 1, passRate: 0.5 });
    // c: one unjudged, one stopped: nothing judged.
    expect(summary.categories.untagged).toMatchObject({ cases: 1, judged: 0, passed: 0, passRate: null, costPerCompletedTaskUsd: null, modelMsPerCompletedTask: null });
  });
});

describe('the picks', () => {
  const summary = (model: string, passRate: number | null, cost: number | null, categories: ModelSummary['categories'] = {}): ModelSummary =>
    ({ model, label: model, passRate, cost: { perCompletedTaskUsd: cost }, categories }) as ModelSummary;

  it('picks the cheapest per completed task within the points of the best', () => {
    const [all] = leadersOf([summary('a', 0.95, 0.1), summary('b', 0.94, 0.05), summary('c', 0.9, 0.01), summary('d', 0.931, 0.04)], 2);
    expect(all).toEqual({
      scope: 'all',
      withinPoints: 2,
      best: { model: 'a', passRate: 0.95 },
      contenders: [
        { model: 'd', passRate: 0.931, costPerCompletedTaskUsd: 0.04 },
        { model: 'b', passRate: 0.94, costPerCompletedTaskUsd: 0.05 },
        { model: 'a', passRate: 0.95, costPerCompletedTaskUsd: 0.1 },
      ],
      pick: 'd',
    });
    // Exactly 2 points below the best is within them.
    expect(leadersOf([summary('a', 0.95, 0.1), summary('c', 0.93, 0.01)], 2)[0].pick).toBe('c');
    expect(leadersOf([summary('a', 0.95, 0.1), summary('c', 0.93, 0.01)], 0)[0].pick).toBe('a');
  });

  it('breaks a tie in cost by pass rate, then by the order given', () => {
    expect(leadersOf([summary('a', 0.9, 0.1), summary('b', 0.91, 0.1)], 2)[0].pick).toBe('b');
    expect(leadersOf([summary('a', 0.9, 0.1), summary('b', 0.9, 0.1)], 2)[0].pick).toBe('a');
  });

  it('picks per category, and nothing where no model passed or nothing was judged', () => {
    const leaders = leadersOf(
      [
        summary('a', 0.5, 0.2, { edit: { cases: 2, judged: 2, passed: 2, passRate: 1, costUsd: 0.4, costPerCompletedTaskUsd: 0.2 }, plan: { cases: 2, judged: 2, passed: 0, passRate: 0, costUsd: 0.2, costPerCompletedTaskUsd: null } }),
        summary('b', null, null, { edit: { cases: 0, judged: 0, passed: 0, passRate: null, costUsd: 0, costPerCompletedTaskUsd: null } }),
      ],
      2,
    );
    expect(leaders.map((l) => [l.scope, l.pick])).toEqual([
      ['all', 'a'],
      ['edit', 'a'],
      ['plan', null],
    ]);
    expect(leaders[2].best).toEqual({ model: 'a', passRate: 0 });
    expect(leadersOf([summary('a', null, null)], 2)[0]).toMatchObject({ best: null, pick: null });
  });
});
