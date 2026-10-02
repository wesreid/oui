/**
 * AgentPersonaConfig — the platform-specific configuration that integrators
 * provide to define their agent's identity, knowledge, and behavior.
 *
 * The SDK's buildAgentSystemPrompt() combines this with generic behavioral
 * rules (anti-hallucination, communication style, tool strategy, UI control)
 * so platforms never re-invent the wheel.
 */

export interface AgentPersonaConfig {
  /** Display name of the agent (e.g. "PA", "Atlas", "Helper") */
  name: string;

  /**
   * The agent's identity block — who it is, its role, and platform-specific
   * personality. This becomes the opening of the system prompt.
   * Can include markdown formatting.
   */
  identity: string;

  /** High-level capabilities the agent can perform on this platform. */
  capabilities?: string[];

  /** Domain knowledge entries — each gets its own titled section. */
  knowledge?: AgentKnowledgeEntry[];

  /** Guided workflows with trigger conditions and step sequences. */
  workflows?: AgentWorkflow[];

  /** Few-shot conversation examples for calibrating tone and behavior. */
  fewShotExamples?: AgentFewShotExample[];

  /**
   * Platform-specific behavioral instructions appended AFTER SDK base rules.
   * Use these for tool-specific guidance, domain rules, and platform conventions.
   */
  instructions?: string[];

  /**
   * Platform routes/pages the agent can navigate to.
   * Key is the path, value is a human-readable description.
   */
  routes?: Record<string, string>;

  /**
   * Override SDK default behavioral rules.
   * All rules are enabled by default — set these to disable specific categories.
   */
  overrides?: AgentPersonaOverrides;
}

export interface AgentKnowledgeEntry {
  title: string;
  content: string;
}

export interface AgentWorkflow {
  name: string;
  trigger: string;
  steps: string[];
}

export interface AgentFewShotExample {
  user: string;
  assistant: string;
  toolCalls?: string[];
  followUp?: string | null;
}

export interface AgentPersonaOverrides {
  /** Disable anti-hallucination rules (not recommended). */
  disableAntiHallucination?: boolean;
  /** Disable anti-repetition / never-re-introduce rules. */
  disableAntiRepetition?: boolean;
  /** Disable generic UI control protocol rules. */
  disableUIControlRules?: boolean;
  /** Disable tool strategy rules (discovery-first, error handling). */
  disableToolStrategy?: boolean;
  /** Disable options presentation rules. */
  disableOptionsPresentation?: boolean;
  /**
   * Communication style preset. Affects tone and formatting rules.
   * - 'conversational' (default): Friendly, collaborative, uses markdown liberally
   * - 'concise': Minimal, direct answers, less personality
   * - 'formal': Professional, structured, no emojis
   */
  communicationStyle?: 'concise' | 'conversational' | 'formal';
}

/**
 * Context passed to the prompt builder at runtime.
 * Includes user identity and current UI state.
 */
export interface PromptBuildContext {
  userId: string;
  accountId: string;
  context?: Record<string, unknown> | null;
}
