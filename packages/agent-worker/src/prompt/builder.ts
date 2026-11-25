/**
 * Prompt Builder — assembles the full system prompt from:
 * 1. Platform persona (identity, capabilities, knowledge, workflows, instructions)
 * 2. SDK base rules (anti-hallucination, communication, tool strategy, UI control)
 * 3. Runtime context (userId, current UI state)
 *
 * Pure function — no side effects. Platforms can inspect, cache, or modify the output.
 */

import type { AgentPersonaConfig, PromptBuildContext } from './types.js';
import { getBaseRules } from './rules/base.js';
import { getCommunicationRules, resolveCommunicationStyle } from './rules/communication.js';
import { resolveNarration } from './rules/narration.js';
import { getToolStrategyRules, TOOL_STRATEGY_TOOL_RULES } from './rules/tool-strategy.js';
import { getUIControlRules, UI_CONTROL_TOOL_RULES } from './rules/ui-control.js';
import { promptForTools, type OfferedTools, type ToolRule } from './step-tools.js';
import { withoutClientUI } from '../ui/snapshot.js';

/** Every rule naming a tool that `buildAgentSystemPrompt` writes: the tool strategy's and the UI rules'. */
export const SDK_PROMPT_TOOL_RULES: readonly ToolRule[] = [...TOOL_STRATEGY_TOOL_RULES, ...UI_CONTROL_TOOL_RULES];

/**
 * A host's system prompt as a step offering `offered` is told it: each of the
 * SDK's rules it carries names only tools the step offers. A host builds its
 * prompt once a turn, with every rule (`buildAgentSystemPrompt`); the worker
 * calls this for each step. The host's own words are left as they are.
 */
export function systemPromptForTools(prompt: string, offered: OfferedTools): string {
  return promptForTools(prompt, SDK_PROMPT_TOOL_RULES, offered);
}

/**
 * Build a complete system prompt by combining SDK behavioral rules
 * with the platform's persona configuration and runtime context.
 *
 * Order of sections:
 * 1. Platform identity (who the agent is)
 * 2. SDK base rules (anti-hallucination, anti-repetition, identity boundaries)
 * 3. SDK communication rules (formatting, tone): `overrides.communicationStyle`,
 *    a preset and a format (markdown, or plain text)
 *
 * How much the agent says while it works (sections 2–4) is `overrides.narration`:
 * fixed and brief by default, or the host's to say with each turn.
 * 4. SDK tool strategy rules (discovery-first, error handling, options)
 * 5. SDK UI control rules (navigation, forms, player, toasts)
 * 6. Platform capabilities
 * 7. Platform knowledge
 * 8. Platform workflows
 * 9. Platform instructions (tool-specific, domain rules)
 * 10. Platform routes
 * 11. Few-shot examples
 * 12. Runtime UI context (or the persona's own `renderContext`)
 */
export function buildAgentSystemPrompt(
  persona: AgentPersonaConfig,
  context?: PromptBuildContext,
): string {
  const parts: string[] = [];
  const overrides = persona.overrides ?? {};
  const style = resolveCommunicationStyle(overrides.communicationStyle);
  const narration = resolveNarration(overrides.narration);
  // In plain text, the prompt's own labels carry no markdown either, so no
  // example shows the model a formatting symbol to copy.
  const label = (name: string) => (style.format === 'plain' ? `${name}:` : `**${name}:**`);

  // 1. Platform identity
  parts.push(persona.identity);

  // 2. SDK base rules
  if (!overrides.disableAntiHallucination && !overrides.disableAntiRepetition) {
    parts.push('\n\n' + getBaseRules(persona.name, narration));
  } else {
    if (!overrides.disableAntiHallucination) {
      const baseRules = getBaseRules(persona.name, narration);
      const antiHallucSection = baseRules.split('### Anti-Repetition')[0];
      parts.push('\n\n' + antiHallucSection.trim());
    }
    if (!overrides.disableAntiRepetition) {
      const baseRules = getBaseRules(persona.name, narration);
      const repetitionStart = baseRules.indexOf('### Anti-Repetition');
      const identityStart = baseRules.indexOf('### Identity Boundaries');
      if (repetitionStart !== -1 && identityStart !== -1) {
        parts.push('\n\n' + baseRules.slice(repetitionStart, identityStart).trim());
      }
    }
  }

  // 3. SDK communication rules
  parts.push('\n\n' + getCommunicationRules(style, narration));

  // 4. SDK tool strategy rules
  if (!overrides.disableToolStrategy) {
    parts.push('\n\n' + getToolStrategyRules(undefined, narration));
  }

  // 5. SDK UI control rules
  if (!overrides.disableUIControlRules) {
    parts.push('\n\n' + getUIControlRules());
  }

  // 6. Platform capabilities
  if (persona.capabilities?.length) {
    parts.push('\n\n## CAPABILITIES\n');
    parts.push(persona.capabilities.map(c => `- ${c}`).join('\n'));
  }

  // 7. Platform knowledge
  if (persona.knowledge?.length) {
    parts.push('\n\n## DOMAIN KNOWLEDGE\n');
    for (const entry of persona.knowledge) {
      parts.push(`\n### ${entry.title}\n${entry.content}`);
    }
  }

  // 8. Platform workflows
  if (persona.workflows?.length) {
    parts.push('\n\n## GUIDED WORKFLOWS\n');
    for (const wf of persona.workflows) {
      parts.push(`\n### ${wf.name}`);
      parts.push(`${label('Trigger')} ${wf.trigger}`);
      parts.push(wf.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }
  }

  // 9. Platform instructions
  if (persona.instructions?.length) {
    parts.push('\n\n## PLATFORM-SPECIFIC INSTRUCTIONS\n');
    parts.push(persona.instructions.join('\n\n'));
  }

  // 10. Platform routes
  if (persona.routes && Object.keys(persona.routes).length > 0) {
    parts.push('\n\n## PLATFORM ROUTES\n');
    parts.push('Key pages you can navigate to:');
    for (const [path, desc] of Object.entries(persona.routes)) {
      parts.push(`- ${path} — ${desc}`);
    }
  }

  // 11. Few-shot examples
  if (persona.fewShotExamples?.length) {
    parts.push('\n\n## EXAMPLE CONVERSATIONS\n');
    for (const example of persona.fewShotExamples) {
      parts.push(`\n${label('User')} ${example.user}`);
      if (example.toolCalls?.length) {
        const used = `[Uses tools: ${example.toolCalls.join(', ')}]`;
        parts.push(style.format === 'plain' ? used : `*${used}*`);
      }
      parts.push(`${label('Assistant')} ${example.assistant}`);
      if (example.followUp) {
        parts.push(`${label('Follow-up')} ${example.followUp}`);
      }
    }
  }

  // 12. Runtime UI context. What the client's UI sent for the worker is
  // excluded: its surface snapshot is the turn's UI tools, not prose, and
  // repeating every manifest here would cost thousands of tokens for nothing;
  // its knowledge is rendered once, after this prompt (ui/knowledge.ts).
  // A persona that renders its own context says how, or that there is none.
  const uiContext = withoutClientUI(context?.context);
  if (persona.renderContext) {
    const rendered = context ? persona.renderContext({ ...context, context: uiContext }) : null;
    if (typeof rendered === 'string' && rendered.trim()) parts.push('\n\n' + rendered.trim());
  } else if (uiContext && Object.keys(uiContext).length > 0) {
    parts.push('\n\n## CURRENT UI CONTEXT\n');
    parts.push('The user is currently on this page/state:');
    parts.push('```json');
    parts.push(JSON.stringify(uiContext, null, 2));
    parts.push('```');
  }

  return parts.join('\n');
}
