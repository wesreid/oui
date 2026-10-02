/**
 * Prompt Framework — composable system prompt builder for the agent SDK.
 *
 * Platforms provide an AgentPersonaConfig (identity, knowledge, workflows, instructions).
 * The SDK handles generic behavioral intelligence (anti-hallucination, communication style,
 * tool strategy, UI control protocol).
 */

export { buildAgentSystemPrompt } from './builder.js';
export type {
  AgentPersonaConfig,
  AgentKnowledgeEntry,
  AgentWorkflow,
  AgentFewShotExample,
  AgentPersonaOverrides,
  PromptBuildContext,
} from './types.js';
export { getBaseRules } from './rules/base.js';
export { getCommunicationRules } from './rules/communication.js';
export type { CommunicationStyle } from './rules/communication.js';
export { getToolStrategyRules } from './rules/tool-strategy.js';
export { getUIControlRules } from './rules/ui-control.js';
