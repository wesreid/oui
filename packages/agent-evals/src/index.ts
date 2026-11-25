/**
 * @ouispec/agent-evals — agent evals as data.
 *
 * A product writes scenarios as data: what a customer says, turn by turn, and
 * what must hold after each turn. The harness runs every scenario on every
 * channel the product serves, against the product's real agent configuration
 * (persona, tools, tool policy, turn policy) through the SDK's own turn
 * runner, from recorded model responses in CI or against the live model. A
 * recording knows what it was recorded against, so a changed configuration
 * fails until it is recorded again. Every tool is stubbed: an eval never
 * reaches a real backend. The person's page is scripted too: a fixture
 * surface runtime, the product's own controls or the suite's surfaces, that
 * answers the agent's page actions and goes where they navigate.
 *
 * A model matrix runs the same suites on every candidate model a product's
 * registry declares, several times each, and reports each model's pass rate
 * and its spread, its pass rate in each category, its tokens with the cache
 * split, its cost per completed task, its latency, its invalid tool calls and
 * its refusals, as a results file, a self-contained HTML leaderboard and a
 * Markdown summary; its cost is estimated before it runs and held to a limit
 * while it does.
 *
 * Run it with the `agent-evals` CLI, or inside a test runner with `evalCases`.
 */
export { defineEvals } from './config.js';
export type { AgentEvalConfig, EvalAgentConfig, EvalBudgets, EvalChannel, EvalMode, EvalModelSeam, EvalStubFunction, EvalTurnBudget } from './config.js';
export { evalCases, evalTargets, runEvals, runEvalCase, agentForCandidate, check, pagesKeptOf, workingOf, EvalCaseFailed, failureLine } from './run.js';
export type { CheckFailure, EvalCase, EvalCaseResult, EvalCaseTarget, EvalChoices, EvalFailure, EvalPageKept, EvalReport, EvalRunOptions, EvalTurnRecord } from './run.js';
export { mergeExpectations } from './expectations.js';
export { runMatrix, estimateRun, tagsOf, DEFAULT_WITHIN_POINTS, MATRIX_FORMAT, MATRIX_VERSION } from './matrix.js';
export type { MatrixResults, MatrixRunOptions, MatrixScenario, MatrixStop } from './matrix.js';
export { leadersOf, percentile, percentiles, spreadOf, summarizeModel, UNTAGGED } from './aggregate.js';
export type { CategorySummary, MatrixCase, MatrixLeader, MatrixTurn, ModelSummary, Percentiles, Spread } from './aggregate.js';
export { estimateLines, leaderboardHtml, matrixMarkdown, matrixSummaryLines, ranked, stopLine } from './leaderboard.js';
export { callCost, callsCost, checkCandidates, checkJudge, readModelsFile, selectModels, EvalModelsError } from './models.js';
export type { EvalCandidate, EvalJudgeModel, EvalModelCapabilities, EvalModelPrices } from './models.js';
export {
  estimateMatrix,
  turnEstimates,
  turnEstimateCost,
  EvalBudgetError,
  SpendGuard,
  SpendLimitError,
  DEFAULT_JUDGE_CALL_INPUT_TOKENS,
} from './spend.js';
export type { EvalEstimate, EvalModelEstimate, EvalTarget, EvalTurnEstimate } from './spend.js';
export { createFixturePage, EvalPageError } from './page.js';
export { resolveRow } from './rows.js';
export type { EvalPageRow, RowResolution } from './rows.js';
export type { EvalPage, EvalPageModel, EvalPageModelControl, EvalPageModelFactory, EvalPageModelOutcome, EvalPageModelRun, EvalPageModelView, EvalPageRun, EvalPageSource } from './page.js';
export { recordingCalls, turnUsage } from './usage.js';
export type { EvalCallTiming, EvalFinishReason, EvalModelCall, EvalTurnUsage } from './usage.js';
export { checkSuite, matchersOf, readSuiteFile, rubricsOf, EvalSuiteError } from './suite.js';
export { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from './matchers.js';
export { judge, readVerdict, DEFAULT_JUDGE_MAX_OUTPUT_TOKENS, JUDGE_INSTRUCTIONS, VERDICT_SCHEMA } from './judge.js';
export type { JudgeAsk, JudgeFailure, JudgeOptions, Verdict } from './judge.js';
export { cassettePath, fingerprint, readCassette, writeCassette, CASSETTE_VERSION } from './cassettes.js';
export type { Cassette, CassetteSlot, FingerprintInputs } from './cassettes.js';
export { createMemoryApprovalStore, createMemoryEmit, createMemoryHistory, createMemoryStops, NO_PAGE } from './memory.js';
export type { EmittedEvent, EvalHistory, EvalHistoryRequest, EvalHistoryTurn, MemoryApprovalStore, MemoryHistoryOptions, MemoryStops } from './memory.js';
export { caseLines, formatReport, junitReport, statusWord, summaryLine } from './report.js';
// The suite's shapes are the contract's (`agent-evals.json`).
export type {
  AgentEvalSuite,
  AgentEvalScenario,
  AgentEvalTurn,
  AgentEvalUserTurn,
  AgentEvalApprovalTurn,
  AgentEvalStaffTurn,
  AgentEvalExpectation,
  AgentEvalTextMatcher,
  AgentEvalToolCall,
  AgentEvalApprovalExpectation,
  AgentEvalStubCase,
  AgentEvalStubs,
  AgentEvalPage,
  AgentEvalPageSurface,
  AgentEvalPageAction,
  AgentEvalPageWrite,
  AgentEvalPageControl,
  AgentEvalShown,
  AgentEvalProblems,
  AgentEvalShownQuery,
  AgentEvalShownRoutes,
  AgentEvalPageExpectation,
  AgentEvalCallCount,
  AgentEvalUsage,
  AgentEvalBound,
  AgentEvalShareBound,
  AgentEvalChoicesExpectation,
  AgentEvalTagList,
} from '@ouispec/contract';
