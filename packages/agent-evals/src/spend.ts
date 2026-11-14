/**
 * What a model matrix will cost, and the guard that holds it to a limit.
 *
 * The estimate is taken before anything runs, from each turn's token budget
 * (its expectation's `usage` bounds, else the configuration's `budgets.turn`)
 * at each candidate's prices, for every scenario, channel and run, plus one
 * verdict of the judge for every rubric. Input a turn declares read from the
 * prompt cache (`cachedShare.min`) is priced as a cache read on a model that
 * has one; the rest of its input is priced as written to the cache there,
 * which a cache write costs at least as much as, so the estimate does not
 * fall short. A turn a person holds costs nothing.
 *
 * The guard counts what every call costs as it ends, the candidates' and the
 * judge's, and refuses the next request once the run has spent its limit: the
 * run stops there and reports what it ran.
 */
import type { AgentEvalExpectation, AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import type { EvalBudgets, EvalTurnBudget } from './config.js';
import { mergeExpectations } from './expectations.js';
import { DEFAULT_JUDGE_MAX_OUTPUT_TOKENS } from './judge.js';
import type { EvalCandidate, EvalJudgeModel, EvalModelPrices } from './models.js';
import { matchersOf } from './suite.js';

/** The judge's input for one verdict when the configuration does not say: its instructions, the rubric, the message and the reply. */
export const DEFAULT_JUDGE_CALL_INPUT_TOKENS = 2_000;

/** One scenario on one channel: what a matrix runs once per candidate and run. */
export interface EvalTarget {
  suite: AgentEvalSuite;
  scenario: AgentEvalScenario;
  channel: string;
}

/** One of the agent's turns, as the estimate prices it. */
export interface EvalTurnEstimate {
  inputTokens: number;
  outputTokens: number;
  cachedShare: number;
  /** The judge's verdicts the turn asks for: one per rubric. */
  judgeCalls: number;
}

/** A run whose cost cannot be estimated, with every turn that has no budget. */
export class EvalBudgetError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the run's cost cannot be estimated:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EvalBudgetError';
  }
}

/** What one model is estimated to cost over the whole run. */
export interface EvalModelEstimate {
  model: string;
  label: string;
  /** Its cases: scenarios × channels × runs. */
  cases: number;
  /** The agent's turns among them. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** What a matrix is estimated to cost, before it runs. */
export interface EvalEstimate {
  runs: number;
  models: EvalModelEstimate[];
  judge: { model: string | null; calls: number; inputTokens: number; outputTokens: number; usd: number };
  totalUsd: number;
}

/** A turn's budget from its expectation's `usage` bounds, where they give one. */
function declaredBudget(expect: AgentEvalExpectation): Partial<EvalTurnBudget> {
  const usage = expect.usage;
  if (!usage) return {};
  const perCall = usage.callInputTokens?.max;
  const calls = usage.modelCalls?.max;
  const inputTokens = usage.inputTokens?.max ?? (perCall !== undefined && calls !== undefined ? perCall * calls : undefined);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(usage.outputTokens?.max !== undefined ? { outputTokens: usage.outputTokens.max } : {}),
    ...(usage.cachedShare?.min !== undefined ? { cachedShare: usage.cachedShare.min } : {}),
  };
}

const rubricCount = (expect: AgentEvalExpectation) => matchersOf(expect).filter((m) => typeof m === 'object' && 'rubric' in m).length;

/**
 * Each of the agent's turns in a scenario on a channel, budgeted: its own
 * bounds, else `fallback`. Every turn with neither is a problem, named.
 */
export function turnEstimates(target: EvalTarget, fallback: EvalTurnBudget | undefined): { turns: EvalTurnEstimate[]; problems: string[] } {
  const { suite, scenario, channel } = target;
  const turns: EvalTurnEstimate[] = [];
  const problems: string[] = [];
  scenario.turns.forEach((turn, index) => {
    if ('staff' in turn) return;
    const expect = mergeExpectations(turn.expect, turn.expectOn?.[channel]);
    const judgeCalls = rubricCount(expect);
    // A person holds the conversation: the turn makes no model call.
    if (expect.held === true) {
      turns.push({ inputTokens: 0, outputTokens: 0, cachedShare: 0, judgeCalls });
      return;
    }
    const own = declaredBudget(expect);
    const inputTokens = own.inputTokens ?? fallback?.inputTokens;
    const outputTokens = own.outputTokens ?? fallback?.outputTokens;
    if (inputTokens === undefined || outputTokens === undefined) {
      const missing = [inputTokens === undefined ? 'input' : null, outputTokens === undefined ? 'output' : null].filter(Boolean).join(' and ');
      problems.push(
        `${suite.name} › ${scenario.id} [${channel}], turn ${index + 1}: no ${missing} token budget (bound it with \`usage\`, or give the configuration \`budgets.turn\`)`,
      );
      return;
    }
    turns.push({ inputTokens, outputTokens, cachedShare: Math.min(1, Math.max(0, own.cachedShare ?? fallback?.cachedShare ?? 0)), judgeCalls });
  });
  return { turns, problems };
}

/** What a budgeted turn costs on a model at its prices: see the module's note on how its input is priced. */
export function turnEstimateCost(turn: Pick<EvalTurnEstimate, 'inputTokens' | 'outputTokens' | 'cachedShare'>, model: Pick<EvalCandidate, 'capabilities' | 'prices'>): number {
  const { prices, capabilities } = model;
  const cached = capabilities.promptCache ? turn.inputTokens * turn.cachedShare : 0;
  const rest = turn.inputTokens - cached;
  const restPrice = capabilities.promptCache ? Math.max(prices.input, prices.cacheWrite) : prices.input;
  return (cached * prices.cacheRead + rest * restPrice + turn.outputTokens * prices.output) / 1_000_000;
}

/**
 * What a matrix will cost: every target on every candidate, `runs` times, and
 * the judge's verdicts. Throws an `EvalBudgetError` naming every turn with no
 * budget, and the judge when the suites have rubrics and it has no prices.
 */
export function estimateMatrix(
  targets: readonly EvalTarget[],
  models: readonly EvalCandidate[],
  runs: number,
  options: { budgets?: EvalBudgets; judgeModel?: EvalJudgeModel; judgeMaxOutputTokens?: number } = {},
): EvalEstimate {
  const problems: string[] = [];
  const perTarget = targets.map((target) => {
    const { turns, problems: missing } = turnEstimates(target, options.budgets?.turn);
    problems.push(...missing);
    return turns;
  });
  const judgeCalls = perTarget.reduce((sum, turns) => sum + turns.reduce((n, t) => n + t.judgeCalls, 0), 0) * runs * models.length;
  const judgePrices: EvalModelPrices | undefined = options.judgeModel?.prices;
  if (judgeCalls > 0 && !judgePrices) {
    problems.push(
      options.judgeModel
        ? `the suites have rubrics, and the judge (${options.judgeModel.id}) has no prices (\`judgeModel.prices\`)`
        : 'the suites have rubrics, and the configuration names no judge with its prices (`judgeModel`)',
    );
  }
  if (problems.length > 0) throw new EvalBudgetError(problems);

  const estimates = models.map((model): EvalModelEstimate => {
    let usd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    for (const target of perTarget) {
      for (const turn of target) {
        usd += turnEstimateCost(turn, model);
        inputTokens += turn.inputTokens;
        outputTokens += turn.outputTokens;
        turns += 1;
      }
    }
    return { model: model.id, label: model.label, cases: targets.length * runs, turns: turns * runs, inputTokens: inputTokens * runs, outputTokens: outputTokens * runs, usd: usd * runs };
  });
  const judgeCall = options.budgets?.judgeCall ?? {
    inputTokens: DEFAULT_JUDGE_CALL_INPUT_TOKENS,
    outputTokens: options.judgeMaxOutputTokens ?? DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
  };
  const judgeUsd = judgePrices ? (judgeCalls * (judgeCall.inputTokens * judgePrices.input + judgeCall.outputTokens * judgePrices.output)) / 1_000_000 : 0;
  return {
    runs,
    models: estimates,
    judge: {
      model: options.judgeModel?.id ?? null,
      calls: judgeCalls,
      inputTokens: judgeCalls * judgeCall.inputTokens,
      outputTokens: judgeCalls * judgeCall.outputTokens,
      usd: judgeUsd,
    },
    totalUsd: estimates.reduce((sum, e) => sum + e.usd, 0) + judgeUsd,
  };
}

/** A request the spend guard refused: the run had spent its limit. */
export class SpendLimitError extends Error {
  constructor(
    readonly maxUsd: number,
    readonly spentUsd: number,
  ) {
    super(`[agent-evals] the run has spent $${spentUsd.toFixed(4)} of its $${maxUsd.toFixed(2)} limit (--max-cost): no further model request is made`);
    this.name = 'SpendLimitError';
  }
}

/**
 * What a run has spent, and its limit. Every call's cost is added as it ends;
 * `admit` is asked before every request, and refuses one once the run has
 * spent its limit. With no limit it only counts.
 */
export class SpendGuard {
  /** The candidates' calls. */
  agentUsd = 0;
  /** The judge's verdicts. */
  judgeUsd = 0;
  /** Requests refused because the limit was spent. */
  refused = 0;

  constructor(readonly maxUsd?: number) {}

  get spentUsd(): number {
    return this.agentUsd + this.judgeUsd;
  }

  /** Whether the run has spent its limit. */
  get exceeded(): boolean {
    return this.maxUsd !== undefined && this.spentUsd >= this.maxUsd;
  }

  add(usd: number, by: 'agent' | 'judge'): void {
    if (by === 'agent') this.agentUsd += usd;
    else this.judgeUsd += usd;
  }

  /** Before a request: throws a `SpendLimitError` once the limit is spent. */
  admit(): void {
    if (!this.exceeded) return;
    this.refused += 1;
    throw new SpendLimitError(this.maxUsd!, this.spentUsd);
  }
}
