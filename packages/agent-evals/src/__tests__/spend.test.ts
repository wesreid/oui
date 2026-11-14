/**
 * What a run is estimated to cost and the guard that holds it to a limit,
 * worked out by hand: a turn's own budget before the configuration's, cache
 * reads only on a model that caches, the rest of its input priced as a cache
 * write there, a held turn free, one verdict per rubric at the judge's
 * prices, every run; and the candidates checked before anything runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvalSuite } from '@ouispec/contract';
import { checkCandidates, EvalModelsError, selectModels, type EvalCandidate } from '../models.js';
import { EvalBudgetError, SpendGuard, SpendLimitError, estimateMatrix, turnEstimates, type EvalTarget } from '../spend.js';

const CACHING: EvalCandidate = {
  id: 'vendor.caching-1',
  label: 'Caching',
  capabilities: { promptCache: true, forcedToolChoice: true, temperature: false, vision: true, contextWindow: 200_000 },
  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const PLAIN: EvalCandidate = {
  id: 'vendor.plain-1',
  label: 'Plain',
  capabilities: { promptCache: false, forcedToolChoice: false, temperature: true, vision: false },
  prices: { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 },
};
const JUDGE = { id: 'vendor.judge-1', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };

const SUITE: AgentEvalSuite = {
  version: 1,
  name: 'budgets',
  scenarios: [
    {
      id: 'plan',
      title: 'A plan, bounded',
      turns: [
        {
          user: 'Make me a storyboard',
          expect: {
            usage: { inputTokens: { max: 100_000 }, outputTokens: { max: 4_000 }, cachedShare: { min: 0.8 } },
            says: [{ rubric: 'It describes the storyboard.' }],
          },
          // The channel's own bound wins on that channel.
          expectOn: { sms: { usage: { inputTokens: { max: 50_000 } } } },
        },
        { user: 'Thanks', expect: { says: [{ rubric: 'It says goodbye.' }, 'bye'] } },
      ],
    },
    {
      id: 'held',
      title: 'Held, then per call',
      turns: [
        { staff: { takeOver: { displayName: 'Jo' } } },
        { user: 'Hello?', expect: { held: true } },
        { staff: { handBack: true } },
        { user: 'Still there?', expect: { usage: { callInputTokens: { max: 20_000 }, modelCalls: { max: 3 }, outputTokens: { max: 1_000 } } } },
      ],
    },
  ],
};

const targets: EvalTarget[] = SUITE.scenarios.flatMap((scenario) => ['web_chat', 'sms'].map((channel) => ({ suite: SUITE, scenario, channel })));
const FALLBACK = { inputTokens: 10_000, outputTokens: 500, cachedShare: 0.5 };

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the estimate', () => {
  it('budgets each turn from its own bounds, the channel’s first, else the fallback; a held turn costs nothing', () => {
    expect(turnEstimates(targets[0], FALLBACK)).toEqual({
      turns: [
        { inputTokens: 100_000, outputTokens: 4_000, cachedShare: 0.8, judgeCalls: 1 },
        { inputTokens: 10_000, outputTokens: 500, cachedShare: 0.5, judgeCalls: 1 },
      ],
      problems: [],
    });
    // On SMS its input bound is the channel's; the rest of its usage bound is replaced with it, so the fallback fills them.
    expect(turnEstimates(targets[1], FALLBACK).turns[0]).toEqual({ inputTokens: 50_000, outputTokens: 500, cachedShare: 0.5, judgeCalls: 1 });
    expect(turnEstimates(targets[2], FALLBACK).turns).toEqual([
      { inputTokens: 0, outputTokens: 0, cachedShare: 0, judgeCalls: 0 },
      // Per call × calls.
      { inputTokens: 60_000, outputTokens: 1_000, cachedShare: 0.5, judgeCalls: 0 },
    ]);
  });

  it('names every turn it cannot budget', () => {
    const { problems } = turnEstimates(targets[0], undefined);
    expect(problems).toEqual(['budgets › plan [web_chat], turn 2: no input and output token budget (bound it with `usage`, or give the configuration `budgets.turn`)']);
    expect(() => estimateMatrix(targets, [CACHING], 1, { judgeModel: JUDGE })).toThrow(EvalBudgetError);
  });

  it('prices every turn on every model and run, and the judge’s verdicts', () => {
    const estimate = estimateMatrix(targets, [CACHING, PLAIN], 5, { budgets: { turn: FALLBACK, judgeCall: { inputTokens: 1_500, outputTokens: 300 } }, judgeModel: JUDGE });
    // On the caching model: cached input at the read price, the rest at the write price (more than the input price), output at its price.
    const caching = (input: number, share: number, output: number) => (input * share * 0.3 + input * (1 - share) * 3.75 + output * 15) / 1e6;
    const plain = (input: number, output: number) => (input * 1 + output * 4) / 1e6;
    const turns: Array<[number, number, number]> = [
      [100_000, 0.8, 4_000],
      [10_000, 0.5, 500],
      [50_000, 0.5, 500],
      [10_000, 0.5, 500],
      [60_000, 0.5, 1_000],
      [60_000, 0.5, 1_000],
    ];
    const perRunCaching = turns.reduce((s, [i, c, o]) => s + caching(i, c, o), 0);
    const perRunPlain = turns.reduce((s, [i, , o]) => s + plain(i, o), 0);
    expect(estimate.models[0]).toMatchObject({ model: CACHING.id, label: 'Caching', cases: 20, turns: 40, inputTokens: 290_000 * 5, outputTokens: 7_500 * 5 });
    expect(estimate.models[0].usd).toBeCloseTo(perRunCaching * 5, 12);
    expect(estimate.models[1].usd).toBeCloseTo(perRunPlain * 5, 12);
    // Two rubrics on each channel of the plan: 4 verdicts a run, on each model.
    expect(estimate.judge).toEqual({ model: JUDGE.id, calls: 4 * 5 * 2, inputTokens: 40 * 1_500, outputTokens: 40 * 300, usd: (40 * (1_500 * 5 + 300 * 25)) / 1e6 });
    expect(estimate.totalUsd).toBeCloseTo(perRunCaching * 5 + perRunPlain * 5 + estimate.judge.usd, 12);
  });

  it('needs the judge’s prices when the suites have rubrics', () => {
    expect(() => estimateMatrix(targets, [PLAIN], 1, { budgets: { turn: FALLBACK } })).toThrow(/names no judge with its prices/);
    expect(() => estimateMatrix(targets, [PLAIN], 1, { budgets: { turn: FALLBACK }, judgeModel: { id: 'j' } })).toThrow(/the judge \(j\) has no prices/);
    // By default a verdict is 2,000 tokens in and the judge's most out.
    const estimate = estimateMatrix(targets, [PLAIN], 1, { budgets: { turn: FALLBACK }, judgeModel: JUDGE, judgeMaxOutputTokens: 600 });
    expect(estimate.judge).toMatchObject({ calls: 4, inputTokens: 8_000, outputTokens: 2_400 });
  });
});

describe('the spend guard', () => {
  it('counts the candidates’ and the judge’s spend, and refuses a request once the limit is spent', () => {
    const guard = new SpendGuard(1);
    guard.add(0.5, 'agent');
    guard.add(0.25, 'judge');
    expect(() => guard.admit()).not.toThrow();
    expect(guard.exceeded).toBe(false);
    guard.add(0.25, 'agent');
    expect([guard.agentUsd, guard.judgeUsd, guard.spentUsd]).toEqual([0.75, 0.25, 1]);
    expect(guard.exceeded).toBe(true);
    expect(() => guard.admit()).toThrow(SpendLimitError);
    expect(() => guard.admit()).toThrow('the run has spent $1.0000 of its $1.00 limit (--max-cost): no further model request is made');
    expect(guard.refused).toBe(2);
  });

  it('only counts, with no limit', () => {
    const guard = new SpendGuard();
    guard.add(1_000, 'agent');
    expect(guard.exceeded).toBe(false);
    expect(() => guard.admit()).not.toThrow();
  });
});

describe('the candidates', () => {
  it('are checked: ids, labels, capabilities, prices, and no judge among them', () => {
    expect(checkCandidates([CACHING, PLAIN], 'models')).toEqual([CACHING, PLAIN]);
    const bad = [
      { id: 'a.b', label: 'A', capabilities: { promptCache: true, forcedToolChoice: true, temperature: true, vision: 'yes' }, prices: { input: 1, output: -1, cacheRead: 0, cacheWrite: 0, extra: 1 } },
      { id: 'a-b', label: '', capabilities: CACHING.capabilities, prices: CACHING.prices },
      { id: JUDGE.id, label: 'J', capabilities: { ...CACHING.capabilities, contextWindow: 1.5 }, prices: CACHING.prices },
      'not a model',
    ];
    let error: EvalModelsError | undefined;
    try {
      checkCandidates(bad, 'models.json', JUDGE);
    } catch (err) {
      error = err as EvalModelsError;
    }
    expect(error?.problems).toEqual([
      '[0].capabilities.vision: true or false',
      '[0].prices.output: a price is a number of dollars per million tokens, 0 or more',
      '[0].prices.extra: not a price (input, output, cacheRead, cacheWrite)',
      '[1].id: "a-b" and "a.b" are filed under one name (a-b)',
      '[1].label: give the model\'s name in reports',
      '[2].id: "vendor.judge-1" is the judge, and the judge is never a candidate',
      '[2].capabilities.contextWindow: a number of tokens',
      '[3]: a model is an object ({ id, label, capabilities, prices })',
    ]);
    expect(() => checkCandidates([], 'models')).toThrow('it must be a list of one model or more');
  });

  it('are chosen from a file, from the configuration by id, or all of them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-evals-models-'));
    dirs.push(dir);
    const json = join(dir, 'models.json');
    writeFileSync(json, JSON.stringify([PLAIN]));
    const yaml = join(dir, 'models.yaml');
    writeFileSync(yaml, `- id: ${CACHING.id}\n  label: Caching\n  capabilities: { promptCache: true, forcedToolChoice: true, temperature: false, vision: true }\n  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }\n`);
    expect(await selectModels(json, undefined)).toEqual([PLAIN]);
    expect((await selectModels(yaml, [PLAIN]))[0].id).toBe(CACHING.id);
    expect(await selectModels('all', [CACHING, PLAIN])).toEqual([CACHING, PLAIN]);
    expect(await selectModels(`${PLAIN.id}, ${CACHING.id}`, [CACHING, PLAIN])).toEqual([PLAIN, CACHING]);
    await expect(selectModels('vendor.none', [CACHING])).rejects.toThrow('no model "vendor.none" in the configuration (vendor.caching-1)');
    await expect(selectModels('all', undefined)).rejects.toThrow('the configuration lists no models (`models`) to choose "all" from');
    await expect(selectModels(`${PLAIN.id},${PLAIN.id}`, [PLAIN])).rejects.toThrow('a model is named twice');
    await expect(selectModels('all', [CACHING], { id: CACHING.id })).rejects.toThrow('is the judge, and the judge is never a candidate');
  });
});
