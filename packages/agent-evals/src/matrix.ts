/**
 * A model matrix: every scenario, on every channel, on every candidate model,
 * `runs` times, each case through the same harness as a single run (the
 * product's real agent configuration, its stubs, its page), with each
 * candidate's provider options and only what it can be asked for. One judge,
 * fixed for the run and never a candidate, decides every rubric.
 *
 * The cases run in run order (the whole suite on every model, then again), so
 * a run the spend guard stops leaves every model with about as many cases as
 * the others. Before anything runs, the run's cost is estimated from the
 * suites' token budgets at each model's prices; with a limit (`maxCostUsd`),
 * an estimate over it runs nothing, and the guard stops the run when what it
 * has spent reaches the limit.
 */
import type { AgentEvalConfig, EvalMode } from './config.js';
import { leadersOf, summarizeModel, type MatrixCase, type MatrixLeader, type ModelSummary } from './aggregate.js';
import { checkCandidates, checkJudge, type EvalCandidate, type EvalJudgeModel, type EvalModelPrices } from './models.js';
import { evalTargets, runEvalCase, type EvalCaseResult, type EvalRunOptions } from './run.js';
import { EvalBudgetError, SpendGuard, estimateMatrix, type EvalEstimate, type EvalTarget } from './spend.js';
import { rubricsOf } from './suite.js';

/** The results file's format, and its version: a reader checks both. */
export const MATRIX_FORMAT = 'agent-evals-matrix';
export const MATRIX_VERSION = 1;

/** By default a model within this many percentage points of the best pass rate may be picked for being cheaper. */
export const DEFAULT_WITHIN_POINTS = 2;

export interface MatrixRunOptions extends Omit<EvalRunOptions, 'mode'> {
  /** Default `replay`. */
  mode?: EvalMode;
  /** The candidates. */
  models: readonly EvalCandidate[];
  /** How many times each case runs on each model. Default 1. */
  runs?: number;
  /** The most the run may spend, in US dollars: an estimate over it runs nothing, and the run stops when it has spent it. */
  maxCostUsd?: number;
  /** How many cases run at once. Default 1. */
  concurrency?: number;
  /** How close to the best pass rate, in percentage points, a cheaper model may be and still be picked. Default 2. */
  withinPoints?: number;
  /** Told of each case as it ends. */
  onCase?: (result: EvalCaseResult) => void;
}

/** A scenario of the matrix, as its report names it. */
export interface MatrixScenario {
  suite: string;
  id: string;
  title: string;
  tags: string[];
  channels: string[];
}

/** Why a matrix stopped before it ran every case. */
export interface MatrixStop {
  /** `estimate`: the estimate was over the limit, and nothing ran. `max-cost`: the run spent its limit. */
  reason: 'estimate' | 'max-cost';
  /** The cases it did not run, or did not run to their end. */
  casesNotRun: number;
}

/** What a matrix ran and found: the results file. */
export interface MatrixResults {
  format: typeof MATRIX_FORMAT;
  version: typeof MATRIX_VERSION;
  mode: EvalMode;
  runs: number;
  startedAt: string;
  durationMs: number;
  withinPoints: number;
  judge: { id: string; label: string; prices: EvalModelPrices | null } | null;
  models: EvalCandidate[];
  scenarios: MatrixScenario[];
  /** Run order: run 1's every case on every model, then run 2's. */
  cases: MatrixCase[];
  /** One per model, in the order the models were given. */
  summaries: ModelSummary[];
  leaders: MatrixLeader[];
  spend: {
    /** The estimate taken before the run; null when the suites give no budget to take one from. */
    estimate: EvalEstimate | null;
    /** Why there is no estimate. */
    estimateProblems: string[];
    maxCostUsd: number | null;
    /** What the run spent, at the models' and the judge's prices. */
    spentUsd: number;
    agentUsd: number;
    judgeUsd: number;
    stopped: MatrixStop | null;
  };
}

/** A scenario's categories: its suite's, then its own. */
export const tagsOf = (target: Pick<EvalTarget, 'suite' | 'scenario'>): string[] => [...new Set([...(target.suite.tags ?? []), ...(target.scenario.tags ?? [])])];

/** The candidates and the judge, checked together: the judge is never a candidate. */
function checkedModels(config: AgentEvalConfig, models: readonly EvalCandidate[]): { models: EvalCandidate[]; judge: EvalJudgeModel | undefined } {
  const judge = config.judgeModel ? checkJudge(config.judgeModel, 'the configuration') : undefined;
  return { models: checkCandidates(models, 'the models', judge), judge };
}

function checkedRuns(runs: number | undefined): number {
  const n = runs ?? 1;
  if (!Number.isInteger(n) || n < 1) throw new Error(`[agent-evals] runs is a whole number, 1 or more, not ${String(runs)}`);
  return n;
}

/**
 * What a matrix will cost, without calling a model: its cases, from the
 * configuration's suites narrowed as the options say, at each model's prices.
 * Throws an `EvalBudgetError` naming every turn the suites give no budget for.
 */
export function estimateRun(config: AgentEvalConfig, options: Pick<MatrixRunOptions, 'models' | 'runs' | 'channels' | 'scenarios' | 'root'>): EvalEstimate {
  const { models, judge } = checkedModels(config, options.models);
  const { targets } = evalTargets(config, options);
  return estimateMatrix(targets, models, checkedRuns(options.runs), {
    ...(config.budgets ? { budgets: config.budgets } : {}),
    ...(judge ? { judgeModel: judge } : {}),
    ...(config.judgeOptions?.maxOutputTokens !== undefined ? { judgeMaxOutputTokens: config.judgeOptions.maxOutputTokens } : {}),
  });
}

/** One case's result, as the matrix keeps it. */
function matrixCaseOf(result: EvalCaseResult, target: EvalTarget, model: string, run: number): MatrixCase {
  return {
    suite: result.suite,
    scenario: result.scenario,
    title: result.title,
    channel: result.channel,
    tags: tagsOf(target),
    model,
    run,
    status: result.stoppedBy ? 'stopped' : result.status,
    failures: result.failures,
    turns: result.turns.map((t) => ({
      turn: t.turn,
      kind: t.kind,
      customer: t.customer,
      reply: t.reply,
      toolCalls: t.toolCalls,
      held: t.held,
      usage: t.usage,
      invalidToolCalls: t.invalidToolCalls,
      refusal: t.refusal,
      costUsd: t.costUsd ?? 0,
      outcome: t.outcome,
      ...(t.stopReason ? { stopReason: t.stopReason } : {}),
    })),
    costUsd: result.costUsd ?? 0,
    judgeCostUsd: result.judgeCostUsd,
    modelRequests: result.modelRequests,
    durationMs: result.durationMs,
    cassette: result.cassette,
  };
}

/** Run `tasks`, `concurrency` at a time, starting each only while `go()` says so; a task never started has no result. */
async function inPool<T>(tasks: ReadonlyArray<() => Promise<T>>, concurrency: number, go: () => boolean): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = new Array(tasks.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && go()) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return results;
}

/** Runs the matrix, and reports every case, each model's summary and the picks. */
export async function runMatrix(config: AgentEvalConfig, options: MatrixRunOptions): Promise<MatrixResults> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const mode = options.mode ?? 'replay';
  const { models, judge } = checkedModels(config, options.models);
  const runs = checkedRuns(options.runs);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`[agent-evals] concurrency is a whole number, 1 or more, not ${String(options.concurrency)}`);
  const withinPoints = options.withinPoints ?? DEFAULT_WITHIN_POINTS;
  if (!Number.isFinite(withinPoints) || withinPoints < 0) throw new Error(`[agent-evals] withinPoints is 0 or more, not ${String(options.withinPoints)}`);
  const maxCostUsd = options.maxCostUsd;
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error(`[agent-evals] the cost limit is more than $0, not ${String(maxCostUsd)}`);

  const { targets, cassettes } = evalTargets(config, options);
  if (!judge && targets.some((t) => rubricsOf(t.scenario).length > 0)) {
    throw new Error('[agent-evals] the suites have rubrics, and a matrix judges them with one fixed model: give the configuration `judgeModel`');
  }

  let estimate: EvalEstimate | null = null;
  let estimateProblems: string[] = [];
  try {
    estimate = estimateRun(config, options);
  } catch (err) {
    // With a limit, a run whose cost cannot be estimated does not start.
    if (!(err instanceof EvalBudgetError) || maxCostUsd !== undefined) throw err;
    estimateProblems = [...err.problems];
  }

  const total = targets.length * models.length * runs;
  const guard = new SpendGuard(maxCostUsd);
  const finish = (cases: MatrixCase[], stopped: MatrixStop | null): MatrixResults => {
    const summaries = models.map((model) =>
      summarizeModel(
        model,
        cases.filter((c) => c.model === model.id),
        runs,
        targets.length,
      ),
    );
    return {
      format: MATRIX_FORMAT,
      version: MATRIX_VERSION,
      mode,
      runs,
      startedAt,
      durationMs: Date.now() - startedMs,
      withinPoints,
      judge: judge ? { id: judge.id, label: judge.label ?? judge.id, prices: judge.prices ?? null } : null,
      models,
      scenarios: [...new Map(targets.map((t) => [`${t.suite.name}\u0000${t.scenario.id}`, t])).values()].map((t) => ({
        suite: t.suite.name,
        id: t.scenario.id,
        title: t.scenario.title,
        tags: tagsOf(t),
        channels: targets.filter((o) => o.suite === t.suite && o.scenario === t.scenario).map((o) => o.channel),
      })),
      cases,
      summaries,
      leaders: leadersOf(summaries, withinPoints),
      spend: {
        estimate,
        estimateProblems,
        maxCostUsd: maxCostUsd ?? null,
        spentUsd: guard.spentUsd,
        agentUsd: guard.agentUsd,
        judgeUsd: guard.judgeUsd,
        stopped,
      },
    };
  };

  if (maxCostUsd !== undefined && estimate && estimate.totalUsd > maxCostUsd) return finish([], { reason: 'estimate', casesNotRun: total });

  const tasks: Array<() => Promise<MatrixCase>> = [];
  for (let run = 1; run <= runs; run++) {
    for (const target of targets) {
      for (const candidate of models) {
        tasks.push(async () => {
          const result = await runEvalCase(config, { ...target, mode, cassettes, candidate, run, guard });
          options.onCase?.(result);
          return matrixCaseOf(result, target, candidate.id, run);
        });
      }
    }
  }
  const ran = (await inPool(tasks, concurrency, () => !guard.exceeded)).filter((c): c is MatrixCase => c !== undefined);
  const unfinished = total - ran.filter((c) => c.status !== 'stopped').length;
  // Every case ran to its end, though the last may have reached the limit: the run was not stopped.
  return finish(ran, unfinished > 0 ? { reason: 'max-cost', casesNotRun: unfinished } : null);
}
