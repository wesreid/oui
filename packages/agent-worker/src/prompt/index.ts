/**
 * Prompt Framework — composable system prompt builder for the agent SDK.
 *
 * Platforms provide an AgentPersonaConfig (identity, knowledge, workflows, instructions).
 * The SDK handles generic behavioral intelligence (anti-hallucination, communication style,
 * tool strategy, UI control protocol).
 */

export { buildAgentSystemPrompt, systemPromptForTools } from './builder.js';
export type {
  AgentPersonaConfig,
  AgentKnowledgeEntry,
  AgentWorkflow,
  AgentFewShotExample,
  AgentPersonaOverrides,
  PromptBuildContext,
} from './types.js';
export { getBaseRules } from './rules/base.js';
export { getCommunicationRules, resolveCommunicationStyle, COMMUNICATION_STYLES, COMMUNICATION_FORMATS } from './rules/communication.js';
export type {
  CommunicationStyle,
  CommunicationFormat,
  CommunicationStyleOptions,
  CommunicationStyleSetting,
  ResolvedCommunicationStyle,
} from './rules/communication.js';
export { getToolStrategyRules } from './rules/tool-strategy.js';
export { resolveNarration, resolveNarrationDefault, NARRATION_SETTINGS } from './rules/narration.js';
export type { NarrationSetting } from './rules/narration.js';
export { getUIControlRules } from './rules/ui-control.js';
