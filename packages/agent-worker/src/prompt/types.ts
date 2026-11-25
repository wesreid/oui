/**
 * AgentPersonaConfig — the platform-specific configuration that integrators
 * provide to define their agent's identity, knowledge, and behavior.
 *
 * The SDK's buildAgentSystemPrompt() combines this with generic behavioral
 * rules (anti-hallucination, communication style, tool strategy, UI control)
 * so platforms never re-invent the wheel.
 */

import type { CommunicationStyleSetting } from './rules/communication.js';
import type { NarrationSetting } from './rules/narration.js';

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
   * Renders the turn's page context as the prompt's last section, in place
   * of the SDK's "CURRENT UI CONTEXT" (the context as JSON, introduced as the
   * page the user is on). Given what the host sent as the turn's context,
   * without what the client's UI sent for the worker (`oui`, `uiKnowledge`,
   * `input`, `output`). Return null, or a blank string, to render no section:
   * for an agent whose context is not a page, or that carries it elsewhere.
   *
   * The system prompt is the start of the cached prefix: render nothing that
   * changes from turn to turn unless the conversation's context did.
   */
  renderContext?: (ctx: PromptBuildContext) => string | null;

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
   * How replies are written: a preset (the tone), or a preset and a format.
   *
   * Presets:
   * - 'conversational' (default): Friendly, collaborative
   * - 'concise': Minimal, direct answers, less personality
   * - 'formal': Professional, structured, no emojis
   *
   * Formats:
   * - 'markdown' (default): rich markdown (bold, headings, bullet lists,
   *   tables), for a panel that renders it
   * - 'plain': short natural sentences and no markdown syntax of any kind,
   *   lists said as sentences and no tables, for a channel that shows the
   *   reply exactly as written (a web chat that renders no markdown, SMS)
   *
   * A preset alone (`'concise'`) is that preset in markdown, as it always
   * was. `{ preset: 'concise', format: 'plain' }` sets both; either may be
   * left out. An unknown preset or format in the object form throws.
   */
  communicationStyle?: CommunicationStyleSetting;
  /**
   * How much the agent says while it works: before a tool call, between
   * steps, after a step that fails.
   *
   * - 'brief' (default): the SDK fixes it. At most one brief line before a
   *   tool call, one short sentence of narration, no text between tool
   *   rounds, and a pivot past a failure without narrating it. A persona that
   *   names no narration is told exactly what it was told before the option
   *   existed.
   * - 'host': the host says how much, in an instruction it sends with each
   *   turn (its history's `stepContext`). The rules keep what holds at any
   *   amount (only words for the user, never reasoning, never a result a tool
   *   has not returned, never the same answer twice) and defer the amount to
   *   that instruction. A turn sent without one is held to one brief line.
   *
   * The setting is part of the system prompt, which stays the same on every
   * turn: a host that lets the person choose how much the agent says sends
   * its instruction with each turn, so a change keeps the cached
   * conversation. Any other value fails when the adapter is created.
   */
  narration?: NarrationSetting;
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
