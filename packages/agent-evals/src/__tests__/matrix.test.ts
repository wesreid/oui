/**
 * A model matrix end to end: a tagged suite recorded from two scripted
 * candidates and a judge through OpenAI's real provider package, two runs
 * each, then replayed with no network. The replayed results carry each
 * model's pass rate and its spread, its categories, its tokens with the cache
 * split, its cost per run and per completed task, its latency from the
 * recorded times, its invalid tool calls and its refusals, all to the cent
 * the scripted usage and the fixture's prices make them; the leaderboard and
 * the summary are rendered from them. The spend guard refuses a run
 * estimated over its limit and stops one that spends it. The CLI runs the
 * same matrix from the recordings and estimates it without calling a model.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatRequest, ScriptedReply } from '@ouispec/agent-worker/testing';
import type { AgentEvalConfig } from '../config.js';
import type { Cassette } from '../cassettes.js';
import { leaderboardHtml, matrixMarkdown, usd } from '../leaderboard.js';
import { estimateRun, runMatrix, type MatrixResults } from '../matrix.js';
import type { EvalCandidate } from '../models.js';
import { compliant, isJudge, lastRole, lastUser, recordWith, scratch } from './support.js';
import { CANDIDATES, JUDGE, matrixConfig } from './fixtures/matrix-product.mjs';

const PKG = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/matrix-product.mjs', import.meta.url));
const CLI = join(PKG, 'dist/cli.js');

const dirs: Array<() => void> = [];
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};
afterAll(() => dirs.forEach((cleanup) => cleanup()));

const models = CANDIDATES as EvalCandidate[];
const configIn = (cassettes: string, overrides: Partial<AgentEvalConfig> = {}): AgentEvalConfig => ({ ...(matrixConfig(cassettes) as AgentEvalConfig), ...overrides });

/** The strong model does what the suite asks, reading most of its input from the cache. */
const STRONG_USAGE = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 };
/** The weak one reads no cache, and goes wrong after a while: the price, from its third time on; the SSN, always. */
const WEAK_USAGE = { inputTokens: 400, outputTokens: 20 };

/** What the scripted network answers, by the model each request names. */
function scriptedModels() {
  let weakPriceAsked = 0;
  return (request: ChatRequest): ScriptedReply | undefined => {
    if (isJudge(request)) return compliant(request);
    const model = (request as ChatRequest & { model?: string }).model;
    if (model === 'fixture-strong') {
      const reply = compliant(request);
      return reply && { ...reply, usage: STRONG_USAGE };
    }
    const said = lastUser(request);
    const answered = lastRole(request) === 'tool';
    if (said.includes('price of T1') && !answered && ++weakPriceAsked > 2) return { text: 'T1 is $199 per month.', usage: WEAK_USAGE };
    if (said.includes('SSN')) return { text: 'Sure, 123-45-6789 is noted.', usage: WEAK_USAGE };
    // It calls a tool with input the tool's schema refuses, then answers.
    if (said.includes('Are you human')) return answered ? { text: "No, I'm Ava, an AI assistant.", usage: WEAK_USAGE } : { toolCalls: [{ id: 'call_bad', name: 'lookup', args: {} }], usage: WEAK_USAGE };
    if (said.includes('Any discount')) return { text: "I can't discuss discounts here.", usage: WEAK_USAGE };
    const reply = compliant(request);
    return reply && { ...reply, usage: WEAK_USAGE };
  };
}

/** Every recording under `dir`. */
const cassettesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? cassettesIn(path) : [path];
  });

/** Cost of one call at the fixture's prices, in dollars. */
const STRONG_CALL = (200 * 3 + 800 * 0.3 + 50 * 15) / 1e6; // 0.00159
const WEAK_CALL = (400 * 1 + 20 * 5) / 1e6; // 0.0005
const JUDGE_CALL = (500 * 5 + 20 * 25) / 1e6; // 0.003: the scripted model's default usage

const close = (actual: number | null | undefined, expected: number) => expect(actual).toBeCloseTo(expected, 10);

describe('a model matrix, recorded and replayed', () => {
  const cassettes = tempDir();
  let recorded: { result: MatrixResults; requests: ChatRequest[] };
  let replayed: MatrixResults;

  it('records every scenario × channel × model × run, each candidate with its own provider options', async () => {
    recorded = await recordWith(scriptedModels(), () => runMatrix(configIn(cassettes), { mode: 'record', models, runs: 2 }));
    const { result, requests } = recorded;
    // 4 scenarios × 2 channels × 2 models × 2 runs, in run order.
    expect(result.cases).toHaveLength(32);
    expect(result.cases.slice(0, 4).map((c) => [c.scenario, c.channel, c.model, c.run])).toEqual([
      ['price', 'web_chat', 'fixture-strong', 1],
      ['price', 'web_chat', 'fixture-weak', 1],
      ['price', 'sms', 'fixture-strong', 1],
      ['price', 'sms', 'fixture-weak', 1],
    ]);
    expect(result.cases.at(-1)).toMatchObject({ scenario: 'discount', channel: 'sms', model: 'fixture-weak', run: 2 });
    // Each model's recordings apart, and each run after the first apart.
    const files = cassettesIn(cassettes).map((p) => p.slice(cassettes.length + 1)).sort();
    expect(files).toHaveLength(32);
    expect(files).toContain(join('matrix-desk', 'fixture-strong', 'price.web_chat.json'));
    expect(files).toContain(join('matrix-desk', 'fixture-weak', 'discount.sms.run-2.json'));
    // The strong model's requests carry its provider options; the weak one's carry none, and no temperature.
    const agentRequests = requests.filter((r) => !isJudge(r)) as Array<ChatRequest & { model: string; user?: string; temperature?: number }>;
    expect(agentRequests.filter((r) => r.model === 'fixture-strong').every((r) => r.user === 'matrix-strong')).toBe(true);
    expect(agentRequests.filter((r) => r.model === 'fixture-weak').every((r) => r.user === undefined && r.temperature === undefined)).toBe(true);
    // The judge is the one fixed model.
    expect(requests.filter(isJudge).every((r) => (r as ChatRequest & { model: string }).model === 'fixture-judge')).toBe(true);
    expect(requests.filter(isJudge)).toHaveLength(8);
  });

  it('replays with no network, with the recorded times', async () => {
    // The live calls' times, as a recording keeps them: set here to known values, so the replay must report exactly these.
    for (const path of cassettesIn(cassettes)) {
      const cassette = JSON.parse(readFileSync(path, 'utf8')) as Cassette;
      // The judge's verdict is an exchange of its own, and has no time kept.
      expect(cassette.timings).toHaveLength(cassette.exchanges.length - (/human\.[a-z_]+(\.run-\d+)?\.json$/.test(path) ? 1 : 0));
      const strong = path.includes('fixture-strong');
      cassette.timings = cassette.timings!.map(() => (strong ? { firstTokenMs: 300, durationMs: 900 } : { firstTokenMs: 120, durationMs: 500 }));
      writeFileSync(path, JSON.stringify(cassette));
    }
    replayed = await runMatrix(configIn(cassettes), { models, runs: 2 });
    expect(replayed.mode).toBe('replay');
    expect(replayed.cases.map((c) => [c.scenario, c.channel, c.model, c.run, c.status])).toEqual(
      recorded.result.cases.map((c) => [c.scenario, c.channel, c.model, c.run, c.status]),
    );
    expect(replayed.cases.flatMap((c) => c.failures.filter((f) => f.kind === 'case'))).toEqual([]);
  });

  it('reports each model: pass rate and its spread, categories, tokens with the cache split, cost per run and per completed task', () => {
    const [strong, weak] = replayed.summaries;
    expect(strong.model).toBe('fixture-strong');
    expect(strong.cases).toEqual({ total: 16, ran: 16, stopped: 0, judged: 16, passed: 16, failed: 0, unjudged: 0 });
    expect(strong.passRate).toBe(1);
    expect(strong.passRateByRun).toEqual({ mean: 1, min: 1, max: 1, values: [1, 1] });
    // 6 calls per channel (price 2, ssn 1, human 1, discount 2), 2 channels, 2 runs.
    expect(strong.modelCalls).toEqual({ total: 24, perTurn: 24 / 20, maxPerTurn: 2 });
    expect(strong.tokens).toMatchObject({ input: 24_000, noCache: 4_800, cacheRead: 19_200, cacheWrite: 0, output: 1_200, cachedShare: 0.8, peakCallInput: 1000 });
    close(strong.cost.totalUsd, 24 * STRONG_CALL);
    close(strong.cost.perRunUsd!.mean, 12 * STRONG_CALL);
    close(strong.cost.perCompletedTaskUsd, (24 * STRONG_CALL) / 16);

    expect(weak.cases).toEqual({ total: 16, ran: 16, stopped: 0, judged: 16, passed: 10, failed: 6, unjudged: 0 });
    expect(weak.passRate).toBe(10 / 16);
    expect(weak.passRateByRun).toEqual({ mean: 0.625, min: 0.5, max: 0.75, values: [0.75, 0.5] });
    expect(weak.tokens).toMatchObject({ cacheRead: 0, cachedShare: 0, input: 26 * 400, output: 26 * 20 });
    // Run 1: 7 calls a channel; run 2: 6 (the price, answered with no lookup).
    expect(weak.cost.perRunUsd!.values.map((v) => Math.round(v! * 1e6))).toEqual([14 * 500, 12 * 500]);
    close(weak.cost.perCompletedTaskUsd, (26 * WEAK_CALL) / 10);

    expect(weak.categories.pricing).toMatchObject({ cases: 4, judged: 4, passed: 2, passRate: 0.5 });
    expect(weak.categories.refusal).toMatchObject({ passed: 0, passRate: 0, costPerCompletedTaskUsd: null });
    expect(weak.categories.answers).toMatchObject({ passed: 4, passRate: 1 });
    close(weak.categories.answers.costPerCompletedTaskUsd!, (8 * WEAK_CALL) / 4);
    expect(weak.categories.desk).toMatchObject({ cases: 16, passed: 10 });
    expect(Object.keys(strong.categories)).toEqual(['answers', 'desk', 'handoff', 'pricing', 'refusal']);
  });

  it('reports latency from the recorded times, invalid tool calls and refusals', () => {
    const [strong, weak] = replayed.summaries;
    // Every first call answers at 300 ms; a turn's model time is 900 ms a call (the price takes two).
    expect(strong.latencyMs.firstToken).toEqual({ p50: 300, p90: 300, samples: 20 });
    expect(strong.latencyMs.total).toEqual({ p50: 900, p90: 1800, samples: 20 });
    expect(weak.latencyMs.firstToken.p50).toBe(120);
    expect(strong.invalidToolCalls).toEqual({ total: 0, perTurn: 0 });
    // The weak model's call with input the schema refuses, once in each "human" case.
    expect(weak.invalidToolCalls.total).toBe(4);
    // "I can't discuss discounts" declines where no refusal was expected; the SSN turn expects one, so it never counts.
    expect(weak.refusals).toEqual({ total: 4, provider: 0, reply: 4 });
    expect(strong.refusals.total).toBe(0);
    const human = replayed.cases.find((c) => c.model === 'fixture-weak' && c.scenario === 'human')!;
    expect(human.turns[0]).toMatchObject({ invalidToolCalls: 1, refusal: null });
    expect(human.turns[0].usage.calls).toHaveLength(2);
  });

  it('picks the cheapest model per completed task within the points of the best, for all and for each category', () => {
    const pick = (scope: string) => replayed.leaders.find((l) => l.scope === scope)!;
    expect(pick('all')).toMatchObject({ best: { model: 'fixture-strong', passRate: 1 }, pick: 'fixture-strong' });
    expect(pick('all').contenders.map((c) => c.model)).toEqual(['fixture-strong']);
    // Both pass every "answers" case; the weak one costs less per completed task.
    expect(pick('answers')).toMatchObject({ pick: 'fixture-weak' });
    expect(pick('answers').contenders.map((c) => c.model)).toEqual(['fixture-weak', 'fixture-strong']);
    expect(pick('refusal')).toMatchObject({ pick: 'fixture-strong' });
  });

  it('counts what was spent, the judge apart, against the estimate', () => {
    close(replayed.spend.agentUsd, 24 * STRONG_CALL + 26 * WEAK_CALL);
    close(replayed.spend.judgeUsd, 8 * JUDGE_CALL);
    close(replayed.spend.spentUsd, 24 * STRONG_CALL + 26 * WEAK_CALL + 8 * JUDGE_CALL);
    expect(replayed.spend.stopped).toBeNull();
    expect(replayed.spend.estimate!.totalUsd).toBeGreaterThan(replayed.spend.spentUsd);
    expect(replayed.judge).toEqual({ id: 'fixture-judge', label: 'Judge', prices: JUDGE.prices });
  });

  it('renders a self-contained leaderboard and a summary, byte for byte the same from the same results', () => {
    const page = leaderboardHtml(replayed);
    const again = leaderboardHtml(JSON.parse(JSON.stringify(replayed)) as MatrixResults);
    expect(page).toBe(again);
    expect(page.startsWith('<!doctype html>')).toBe(true);
    // It loads nothing.
    expect(page).not.toMatch(/<link\b|@import|\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    // The leaderboard, best first, sortable; a drill-down per scenario.
    expect(page).toMatch(/<table data-sortable id="leaderboard">[\s\S]*?<tbody><tr><td data-v="1">1<\/td><td data-v="Strong">Strong<\/td><td data-v="1">100\.0%<\/td>/);
    expect(page).toContain('<td data-v="0.625">62.5%</td>');
    expect(page.match(/<details id="scenario-/g)).toHaveLength(4);
    expect(page).toContain('web_chat 1/2 · sms 1/2');
    expect(page).toContain('mustNotSay');
    const summary = matrixMarkdown(replayed);
    expect(summary).toBe(matrixMarkdown(JSON.parse(JSON.stringify(replayed)) as MatrixResults));
    expect(summary).toContain(
      `| Strong | 100.0% | 100.0%–100.0% | ${usd((24 * STRONG_CALL) / 16)} | 1.35 s | ${usd(12 * STRONG_CALL)} | 1,200 | 80.0% | 60 | 1.2 | 300 ms / 300 ms | 900 ms / 1.80 s | 0 | 0 |`,
    );
    expect(summary).toContain('| Weak | 62.5% | 50.0%–75.0% |');
    expect(summary).toContain('- answers: Weak, 100.0% at $0.0010 per completed task;');
    expect(summary).toContain('- **matrix desk › ssn** (Refuses an SSN and keeps none of it): Strong 4/4, Weak 0/4');
  });

  it('escapes every value it shows', () => {
    const hostile = { ...replayed, summaries: replayed.summaries.map((s, i) => (i === 0 ? { ...s, label: '<script>alert("x")</script>' } : s)) };
    const page = leaderboardHtml(hostile);
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(matrixMarkdown({ ...hostile, summaries: hostile.summaries.map((s) => ({ ...s, label: 'a|b' })) })).toContain('| a\\|b |');
  });

  describe('the CLI', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, '--config', FIXTURE, ...args], { cwd: PKG, encoding: 'utf8', env: { ...process.env, AGENT_EVALS_MATRIX_CASSETTES: cassettes } });

    it('replays the matrix from the recordings and writes the results, the leaderboard and the summary', () => {
      const out = tempDir();
      const files = { json: join(out, 'results.json'), html: join(out, 'leaderboard.html'), md: join(out, 'summary.md'), junit: join(out, 'junit.xml') };
      const cli = run('--models', 'all', '--runs', '2', '--json', files.json, '--html', files.html, '--markdown', files.md, '--junit', files.junit);
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain('PASS  [fixture-strong] run 1  matrix desk › price [web_chat]');
      expect(cli.stdout).toContain('FAIL  [fixture-weak] run 2  matrix desk › price [sms]');
      expect(cli.stdout).toContain(` 1. Strong: 100.0% passed (100.0%–100.0% by run), ${usd((24 * STRONG_CALL) / 16)} per completed task`);
      const results = JSON.parse(readFileSync(files.json, 'utf8')) as MatrixResults;
      expect(results).toMatchObject({ format: 'agent-evals-matrix', version: 1, mode: 'replay', runs: 2 });
      expect(results.summaries.map((s) => [s.model, s.passRate])).toEqual([
        ['fixture-strong', 1],
        ['fixture-weak', 0.625],
      ]);
      expect(readFileSync(files.html, 'utf8')).toBe(leaderboardHtml(results));
      expect(readFileSync(files.md, 'utf8')).toBe(matrixMarkdown(results));
      expect(readFileSync(files.junit, 'utf8')).toContain('classname="matrix desk.fixture-weak.sms" name="price: Quotes the dealer price, and no payments (run 2)"');
    });

    it('runs the models it names, by id', () => {
      const cli = run('--models', 'fixture-weak', '--scenario', 'human', '--channel', 'sms');
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain('PASS  [fixture-weak] run 1  matrix desk › human [sms]');
      expect(cli.stdout).not.toContain('fixture-strong');
    });

    it('estimates the run and calls no model', () => {
      const empty = tempDir();
      const cli = spawnSync(process.execPath, [CLI, '--config', FIXTURE, '--models', 'all', '--runs', '5', '--estimate'], {
        cwd: PKG,
        encoding: 'utf8',
        // No recordings and no network: an estimate reaches neither.
        env: { ...process.env, AGENT_EVALS_MATRIX_CASSETTES: empty },
      });
      expect(cli.status, cli.stderr).toBe(0);
      const estimate = estimateRun(configIn(empty), { models, runs: 5 });
      expect(cli.stdout).toContain(`Strong: 40 cases, 60 turns,`);
      expect(cli.stdout.trim().split('\n').at(-1)).toBe(`estimated ${usd(estimate.totalUsd)} for 5 runs`);
      expect(cassettesIn(empty)).toEqual([]);
    });

    it('exits 4 when the estimate is over the limit, and runs nothing', () => {
      const empty = tempDir();
      const env = { ...process.env, AGENT_EVALS_MATRIX_CASSETTES: empty };
      const estimated = spawnSync(process.execPath, [CLI, '--config', FIXTURE, '--models', 'all', '--estimate', '--max-cost', '0.05'], { cwd: PKG, encoding: 'utf8', env });
      expect(estimated.status).toBe(4);
      expect(estimated.stdout).toContain('over the limit of $0.0500');
      const refused = spawnSync(process.execPath, [CLI, '--config', FIXTURE, '--models', 'all', '--live', '--max-cost', '0.05'], { cwd: PKG, encoding: 'utf8', env });
      expect(refused.status).toBe(4);
      expect(refused.stdout).toContain('Not run: the estimate');
      expect(refused.stdout).not.toMatch(/^(PASS|FAIL|STOP) /m);
      expect(cassettesIn(empty)).toEqual([]);
    });

    it('exits 2 for a model it does not know, and for matrix options with no models', () => {
      const unknown = run('--models', 'fixture-strong,nope');
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toContain('no model "nope" in the configuration (fixture-strong, fixture-weak)');
      const noModels = run('--runs', '5');
      expect(noModels.status).toBe(2);
      expect(noModels.stderr).toContain('--runs is for a model matrix: give the models with --models');
      expect(run('--models', 'all', '--max-cost', '0').stderr).toContain('--max-cost takes a number of US dollars, more than 0, not 0');
    });

    it('exits 1 when a recording is missing', () => {
      const cli = run('--models', 'all', '--runs', '3', '--scenario', 'ssn', '--channel', 'sms');
      expect(cli.status).toBe(1);
      expect(cli.stdout).toContain('FAIL  [fixture-strong] run 3  matrix desk › ssn [sms]');
      expect(cli.stdout).toContain('there is no recording at');
    });
  });
});

describe('the spend guard', () => {
  /** A configuration whose budgets are tiny: the estimate passes, and the guard is what stops the run. */
  const tiny = (cassettes: string) => configIn(cassettes, { budgets: { turn: { inputTokens: 10, outputTokens: 1 }, judgeCall: { inputTokens: 1, outputTokens: 1 } } });
  const strongOnly = models.filter((m) => m.id === 'fixture-strong');
  const scenarios = ['ssn', 'human', 'discount'];

  it('starts no case once the run has spent its limit', async () => {
    const { result, requests } = await recordWith(scriptedModels(), () =>
      runMatrix(tiny(tempDir()), { mode: 'record', models: strongOnly, scenarios, maxCostUsd: 0.003 }),
    );
    // Each SSN case costs one call: the second reaches the limit, and nothing starts after it.
    expect(result.cases.map((c) => [c.scenario, c.channel, c.status])).toEqual([
      ['ssn', 'web_chat', 'passed'],
      ['ssn', 'sms', 'passed'],
    ]);
    expect(requests).toHaveLength(2);
    expect(result.spend.stopped).toEqual({ reason: 'max-cost', casesNotRun: 4 });
    close(result.spend.spentUsd, 2 * STRONG_CALL);
  });

  it('refuses the request that would go over, stops that case, and leaves it out of every figure', async () => {
    const { result, requests } = await recordWith(scriptedModels(), () =>
      runMatrix(tiny(tempDir()), { mode: 'record', models: strongOnly, scenarios, maxCostUsd: 0.004 }),
    );
    // The third case's agent call spends past the limit; its judge's request is refused, and never reaches the network.
    expect(result.cases.map((c) => [c.scenario, c.channel, c.status])).toEqual([
      ['ssn', 'web_chat', 'passed'],
      ['ssn', 'sms', 'passed'],
      ['human', 'web_chat', 'stopped'],
    ]);
    expect(requests.filter(isJudge)).toHaveLength(0);
    expect(requests).toHaveLength(3);
    expect(result.spend.stopped).toEqual({ reason: 'max-cost', casesNotRun: 4 });
    expect(result.summaries[0].cases).toMatchObject({ total: 3, ran: 2, stopped: 1, passed: 2, judged: 2 });
    expect(result.summaries[0].passRate).toBe(1);
    // No whole run finished: there is no cost per run.
    expect(result.summaries[0].cost.perRunUsd).toBeNull();
    close(result.spend.spentUsd, 3 * STRONG_CALL);
  });

  it('runs nothing when the estimate is over the limit', async () => {
    const { result, requests } = await recordWith(scriptedModels(), () => runMatrix(configIn(tempDir()), { mode: 'record', models, maxCostUsd: 0.01 }));
    expect(requests).toEqual([]);
    expect(result.cases).toEqual([]);
    expect(result.spend.stopped).toEqual({ reason: 'estimate', casesNotRun: 16 });
    expect(result.spend.estimate!.totalUsd).toBeGreaterThan(0.01);
  });

  it('will not start with a limit and turns it cannot budget', async () => {
    const config = configIn(tempDir(), { budgets: undefined });
    await expect(runMatrix(config, { models, maxCostUsd: 1 })).rejects.toThrow(/matrix desk › ssn \[web_chat\], turn 1: no input and output token budget/);
    // With no limit it runs, and says why there is no estimate.
    const { result } = await recordWith(scriptedModels(), () => runMatrix(config, { mode: 'record', models, scenarios: ['ssn'], channels: ['sms'] }));
    expect(result.spend.estimate).toBeNull();
    expect(result.spend.estimateProblems).toEqual(['matrix desk › ssn [sms], turn 1: no input and output token budget (bound it with `usage`, or give the configuration `budgets.turn`)']);
  });
});

describe('a matrix configuration that cannot run', () => {
  it('needs a judge for its rubrics, and never one that is a candidate', async () => {
    await expect(runMatrix(configIn(tempDir(), { judgeModel: undefined }), { models })).rejects.toThrow(/give the configuration `judgeModel`/);
    await expect(runMatrix(configIn(tempDir(), { judgeModel: { id: 'fixture-weak' } }), { models })).rejects.toThrow(/"fixture-weak" is the judge, and the judge is never a candidate/);
  });

  it('fails a case whose model factory builds another model than the candidate', async () => {
    const config = configIn(tempDir(), { model: ({ fetch }) => (matrixConfig('x') as AgentEvalConfig).model({ fetch, mode: 'live', purpose: 'agent' }) });
    const { result, requests } = await recordWith(scriptedModels(), () =>
      runMatrix(config, { mode: 'live', models: models.filter((m) => m.id === 'fixture-weak'), scenarios: ['ssn'], channels: ['sms'] }),
    );
    // It is found before any request is made.
    expect(requests).toEqual([]);
    expect(result.cases[0].failures).toEqual([
      { turn: -1, assertion: 'model', kind: 'case', message: "the configuration's model factory built fixture-strong for the candidate fixture-weak: build the model `seam.candidate.id` names" },
    ]);
  });
});
