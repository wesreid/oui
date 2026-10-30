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
 * Run it with the `agent-evals` CLI, or inside a test runner with `evalCases`.
 */
export { defineEvals } from './config.js';
export type { AgentEvalConfig, EvalAgentConfig, EvalChannel, EvalMode, EvalModelSeam, EvalStubFunction } from './config.js';
export { evalCases, runEvals, runEvalCase, check, mergeExpectations, EvalCaseFailed, failureLine } from './run.js';
export type { CheckFailure, EvalCase, EvalCaseResult, EvalChoices, EvalFailure, EvalReport, EvalRunOptions, EvalTurnRecord } from './run.js';
export { createFixturePage, EvalPageError } from './page.js';
export type { EvalPage, EvalPageRun, EvalPageSource } from './page.js';
export { recordingCalls, turnUsage } from './usage.js';
export type { EvalModelCall, EvalTurnUsage } from './usage.js';
export { checkSuite, readSuiteFile, rubricsOf, EvalSuiteError } from './suite.js';
export { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from './matchers.js';
export { judge, readVerdict, JUDGE_INSTRUCTIONS, VERDICT_SCHEMA } from './judge.js';
export type { JudgeFailure, JudgeOptions, Verdict } from './judge.js';
export { cassettePath, fingerprint, readCassette, writeCassette, CASSETTE_VERSION } from './cassettes.js';
export type { Cassette, FingerprintInputs } from './cassettes.js';
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
} from '@ouispec/contract';
