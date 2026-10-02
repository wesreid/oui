/**
 * Eval Scenario Types (W7.T2)
 *
 * Defines the fixture format for fixture-driven behavioral evaluation.
 * Each scenario encodes a user intent, the expected tool call sequence,
 * and the expected stop condition.
 */

export type EvalCategory =
  | 'navigation'
  | 'tour'
  | 'entity_query'
  | 'generation'
  | 'oui_dispatch'
  | 'failure'
  | 'bounds'
  | 'multi_turn';

export interface EvalScenario {
  name: string;
  category: EvalCategory;
  context: {
    currentPath?: string;
    history?: Array<{ role: string; content: string }>;
  };
  userMessage: string;
  /** Expected tool calls in order */
  expectedTools: Array<{
    name: string;
    /** Partial match on args */
    argsContain?: Record<string, unknown>;
  }>;
  /** Expected stop reason */
  expectedStopReason?: string;
  /** Max rounds allowed */
  maxRoundsExpected?: number;
}
