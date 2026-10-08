/**
 * @ouispec/agent-evals — agent evals as data (ADR-0260 §3).
 *
 * A product writes scenarios as data: what a customer says, turn by turn, and
 * what must hold after each turn. The harness runs every scenario on every
 * channel the product serves, against the product's real agent configuration
 * (persona, tools, tool policy, turn policy) through the SDK's own turn
 * runner, from recorded model responses in CI or against the live model. A
 * recording knows what it was recorded against, so a changed configuration
 * fails until it is recorded again. Every tool is stubbed: an eval never
 * reaches a real backend.
 *
 * Run it with the `agent-evals` CLI, or inside a test runner with `evalCases`.
 */
export { defineEvals } from './config.js';
export type { AgentEvalConfig, EvalAgentConfig, EvalChannel, EvalMode, EvalModelSeam, EvalStubFunction } from './config.js';
export { evalCases, runEvals, runEvalCase, check, mergeExpectations, EvalCaseFailed, failureLine } from './run.js';
export type { EvalCase, EvalCaseResult, EvalFailure, EvalReport, EvalRunOptions, EvalTurnRecord } from './run.js';
export { checkSuite, readSuiteFile, rubricsOf, EvalSuiteError } from './suite.js';
export { DEFAULT_REFUSAL, describeMatcher, holdsSubset, matchesText } from './matchers.js';
export { judge, readVerdict, JUDGE_INSTRUCTIONS } from './judge.js';
export type { Verdict } from './judge.js';
export { cassettePath, fingerprint, readCassette, writeCassette, CASSETTE_VERSION } from './cassettes.js';
export type { Cassette, FingerprintInputs } from './cassettes.js';
export { createMemoryApprovalStore, createMemoryEmit, createMemoryStops, NO_PAGE } from './memory.js';
export type { EmittedEvent, MemoryApprovalStore, MemoryStops } from './memory.js';
export { formatReport, junitReport } from './report.js';
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
} from '@ouispec/contract';
