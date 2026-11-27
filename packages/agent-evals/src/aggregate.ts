/**
 * What a model matrix says about each model: how often it did the work, how
 * evenly across runs and in each category, what it used and cost, how fast it
 * answered, and how often it wrote a call wrong or declined.
 *
 * A case is one scenario on one channel, for one model, in one run. A case
 * the judge could not decide (`unjudged`) is neither passed nor failed: pass
 * rates are over the cases judged. A case the spend guard stopped (`stopped`)
 * did not run to its end and is left out of every figure but the count.
 */
import type { EvalFailure, EvalTurnRecord } from './run.js';
import type { EvalCandidate } from './models.js';
import type { EvalTurnUsage } from './usage.js';

/** One of a case's turns, as a matrix keeps it. */
export interface MatrixTurn {
  turn: number;
  kind: EvalTurnRecord['kind'];
  customer: string;
  reply: string;
  toolCalls: EvalTurnRecord['toolCalls'];
  held: boolean;
  usage: EvalTurnUsage;
  invalidToolCalls: number;
  refusal: EvalTurnRecord['refusal'];
  /** What its calls cost at the model's prices, in US dollars. */
  costUsd: number;
  outcome: EvalTurnRecord['outcome'];
  stopReason?: string;
}

/** One scenario on one channel, for one model, in one run. */
export interface MatrixCase {
  suite: string;
  scenario: string;
  title: string;
  channel: string;
  /** Its scenario's categories, its suite's first. */
  tags: string[];
  model: string;
  /** From 1. */
  run: number;
  /** `stopped`: the spend guard refused one of its requests, so it did not run to its end. */
  status: 'passed' | 'failed' | 'unjudged' | 'stopped';
  failures: EvalFailure[];
  turns: MatrixTurn[];
  /** What the model's calls cost, in US dollars. */
  costUsd: number;
  /** What the judge's verdicts on it cost, in US dollars; null when the judge has no prices. */
  judgeCostUsd: number | null;
  modelRequests: number;
  durationMs: number;
  cassette: string;
}

/** A figure over runs: its mean, its least and its most, and each run's value (null where the run judged nothing). */
export interface Spread {
  mean: number;
  min: number;
  max: number;
  values: Array<number | null>;
}

/** The middle and the ninetieth percentile of a figure, and how many values they are of. */
export interface Percentiles {
  p50: number | null;
  p90: number | null;
  samples: number;
}

/** A category's results for one model. */
export interface CategorySummary {
  cases: number;
  judged: number;
  passed: number;
  passRate: number | null;
  costUsd: number;
  costPerCompletedTaskUsd: number | null;
  /** The model time of every case that ran, failures included, per case passed, in ms; null when none passed. */
  modelMsPerCompletedTask: number | null;
}

/** What a matrix says about one model. */
export interface ModelSummary {
  model: string;
  label: string;
  capabilities: EvalCandidate['capabilities'];
  /** Its cases: those that ran to their end, those the guard stopped, and of those that ran, each status. */
  cases: { total: number; ran: number; stopped: number; judged: number; passed: number; failed: number; unjudged: number };
  /** Passed over judged, 0 to 1; null when nothing was judged. */
  passRate: number | null;
  /** Each run's pass rate, and their spread; null when no run judged anything. */
  passRateByRun: Spread | null;
  /** Each category's results, by tag; scenarios with no tag are under `untagged`. */
  categories: Record<string, CategorySummary>;
  /** The agent's turns that ran a model call (a turn a person held runs none). */
  turns: number;
  modelCalls: { total: number; perTurn: number | null; maxPerTurn: number };
  tokens: {
    input: number;
    noCache: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** The share of the input read from the prompt cache. */
    cachedShare: number | null;
    perTurn: { input: number | null; output: number | null };
    /** The largest one call's input: what its context window held. */
    peakCallInput: number;
  };
  cost: {
    /** Every case that ran, in US dollars. */
    totalUsd: number;
    perTurnUsd: number | null;
    /** What one whole run of the suite cost, over the runs it finished; null when it finished none. */
    perRunUsd: Spread | null;
    /** What it cost over the cases it passed: everything it spent, failures included, per case passed; null when it passed none. */
    perCompletedTaskUsd: number | null;
  };
  /**
   * In milliseconds: per turn, to its first token and its model calls' time; and
   * the model time of every case that ran, failures included, per case passed
   * (null when it passed none). A model that is quick per call but needs more
   * calls, or fails more, is slower per completed task.
   */
  latencyMs: { firstToken: Percentiles; total: Percentiles; perCompletedTask: number | null };
  invalidToolCalls: { total: number; perTurn: number | null };
  /** Turns that declined: in all, those the provider stopped for their content, and replies that declined where no refusal was expected. */
  refusals: { total: number; provider: number; reply: number };
}

/** The model a matrix picks for a scope: the cheapest per completed task of those within `withinPoints` of the best pass rate. */
export interface MatrixLeader {
  /** `all`, or a category's tag. */
  scope: string;
  withinPoints: number;
  best: { model: string; passRate: number } | null;
  /** The models within the points of the best, cheapest per completed task first. */
  contenders: Array<{ model: string; passRate: number; costPerCompletedTaskUsd: number }>;
  pick: string | null;
}

export const UNTAGGED = 'untagged';

const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);
const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

/** The `p` quantile (0 to 1) of values, interpolated linearly between the two nearest ranks; null with none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function percentiles(values: readonly number[]): Percentiles {
  return { p50: percentile(values, 0.5), p90: percentile(values, 0.9), samples: values.length };
}

/** The spread of values by run; null when no run has one. */
export function spreadOf(values: ReadonlyArray<number | null>): Spread | null {
  const given = values.filter((v): v is number => v !== null);
  if (given.length === 0) return null;
  return { mean: sum(given) / given.length, min: Math.min(...given), max: Math.max(...given), values: [...values] };
}

/** The time the cases' model calls took, one after another, in ms. */
const caseModelMs = (cases: readonly MatrixCase[]): number => sum(cases.flatMap((c) => c.turns.map((t) => t.usage.modelMs)));

const categoryOf = (cases: readonly MatrixCase[]): CategorySummary => {
  const ran = cases.filter((c) => c.status !== 'stopped');
  const passed = ran.filter((c) => c.status === 'passed').length;
  const judged = passed + ran.filter((c) => c.status === 'failed').length;
  const costUsd = sum(ran.map((c) => c.costUsd));
  return {
    cases: ran.length,
    judged,
    passed,
    passRate: ratio(passed, judged),
    costUsd,
    costPerCompletedTaskUsd: ratio(costUsd, passed),
    modelMsPerCompletedTask: ratio(caseModelMs(ran), passed),
  };
};

/**
 * One model's summary, from its cases. `runs` is how many runs the matrix
 * asked for, and `targets` how many cases make one whole run.
 */
export function summarizeModel(model: EvalCandidate, cases: readonly MatrixCase[], runs: number, targets: number): ModelSummary {
  const ran = cases.filter((c) => c.status !== 'stopped');
  const count = (status: MatrixCase['status']) => cases.filter((c) => c.status === status).length;
  const passed = count('passed');
  const failed = count('failed');
  const judged = passed + failed;

  const runNumbers = Array.from({ length: runs }, (_, i) => i + 1);
  const passRateByRun = spreadOf(
    runNumbers.map((run) => {
      const inRun = ran.filter((c) => c.run === run);
      const p = inRun.filter((c) => c.status === 'passed').length;
      return ratio(p, p + inRun.filter((c) => c.status === 'failed').length);
    }),
  );
  // A run is whole when every one of its cases ran to its end.
  const perRunUsd = spreadOf(
    runNumbers.map((run) => {
      const inRun = ran.filter((c) => c.run === run);
      return inRun.length === targets && targets > 0 ? sum(inRun.map((c) => c.costUsd)) : null;
    }),
  );

  const tags = [...new Set(cases.flatMap((c) => (c.tags.length ? c.tags : [UNTAGGED])))].sort();
  const categories = Object.fromEntries(tags.map((tag) => [tag, categoryOf(cases.filter((c) => (c.tags.length ? c.tags.includes(tag) : tag === UNTAGGED)))]));

  const turns = ran.flatMap((c) => c.turns).filter((t) => !t.held && t.usage.calls.length > 0);
  const tokens = (pick: (u: EvalTurnUsage) => number) => sum(turns.map((t) => pick(t.usage)));
  const input = tokens((u) => u.inputTokens);
  const output = tokens((u) => u.outputTokens);
  const cacheRead = tokens((u) => u.cacheReadTokens);
  const calls = turns.map((t) => t.usage.calls.length);
  const totalUsd = sum(ran.map((c) => c.costUsd));
  const invalid = sum(turns.map((t) => t.invalidToolCalls));

  return {
    model: model.id,
    label: model.label,
    capabilities: model.capabilities,
    cases: { total: cases.length, ran: ran.length, stopped: count('stopped'), judged, passed, failed, unjudged: count('unjudged') },
    passRate: ratio(passed, judged),
    passRateByRun,
    categories,
    turns: turns.length,
    modelCalls: { total: sum(calls), perTurn: ratio(sum(calls), turns.length), maxPerTurn: calls.length ? Math.max(...calls) : 0 },
    tokens: {
      input,
      noCache: tokens((u) => u.noCacheTokens),
      cacheRead,
      cacheWrite: tokens((u) => u.cacheWriteTokens),
      output,
      cachedShare: ratio(cacheRead, input),
      perTurn: { input: ratio(input, turns.length), output: ratio(output, turns.length) },
      peakCallInput: turns.reduce((m, t) => Math.max(m, t.usage.peakCallInputTokens), 0),
    },
    cost: { totalUsd, perTurnUsd: ratio(totalUsd, turns.length), perRunUsd, perCompletedTaskUsd: ratio(totalUsd, passed) },
    latencyMs: {
      firstToken: percentiles(turns.map((t) => t.usage.firstTokenMs).filter((ms): ms is number => ms !== null)),
      total: percentiles(turns.map((t) => t.usage.modelMs)),
      perCompletedTask: ratio(caseModelMs(ran), passed),
    },
    invalidToolCalls: { total: invalid, perTurn: ratio(invalid, turns.length) },
    refusals: {
      total: turns.filter((t) => t.refusal !== null).length,
      provider: turns.filter((t) => t.refusal === 'provider').length,
      reply: turns.filter((t) => t.refusal === 'reply').length,
    },
  };
}

/** Floating error in a pass rate is not a point: two rates this close are one. */
const EPSILON = 1e-9;

/**
 * For the whole suite and each category: the best pass rate, the models within
 * `withinPoints` percentage points of it, and of those the cheapest per
 * completed task (ties: the higher pass rate, then the matrix's order). A
 * model that passed nothing in a scope cannot be picked for it.
 */
export function leadersOf(summaries: readonly ModelSummary[], withinPoints: number): MatrixLeader[] {
  const scopes = ['all', ...[...new Set(summaries.flatMap((s) => Object.keys(s.categories)))].sort()];
  return scopes.map((scope) => {
    const rows = summaries.flatMap((s, order) => {
      const passRate = scope === 'all' ? s.passRate : (s.categories[scope]?.passRate ?? null);
      const cost = scope === 'all' ? s.cost.perCompletedTaskUsd : (s.categories[scope]?.costPerCompletedTaskUsd ?? null);
      return passRate === null ? [] : [{ model: s.model, passRate, cost, order }];
    });
    const top = rows.reduce<(typeof rows)[number] | null>((best, r) => (!best || r.passRate > best.passRate + EPSILON ? r : best), null);
    if (!top || top.passRate <= 0) return { scope, withinPoints, best: top ? { model: top.model, passRate: top.passRate } : null, contenders: [], pick: null };
    const floor = top.passRate - withinPoints / 100 - EPSILON;
    const contenders = rows
      .filter((r): r is typeof r & { cost: number } => r.passRate >= floor && r.cost !== null)
      .sort((a, b) => a.cost - b.cost || b.passRate - a.passRate || a.order - b.order)
      .map((r) => ({ model: r.model, passRate: r.passRate, costPerCompletedTaskUsd: r.cost }));
    return { scope, withinPoints, best: { model: top.model, passRate: top.passRate }, contenders, pick: contenders[0]?.model ?? null };
  });
}
