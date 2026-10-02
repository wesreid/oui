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
import { getCommunicationRules } from './rules/communication.js';
import { getToolStrategyRules } from './rules/tool-strategy.js';
import { getUIControlRules } from './rules/ui-control.js';
import { withoutClientUI } from '../ui/snapshot.js';

/**
 * Build a complete system prompt by combining SDK behavioral rules
 * with the platform's persona configuration and runtime context.
 *
 * Order of sections:
 * 1. Platform identity (who the agent is)
 * 2. SDK base rules (anti-hallucination, anti-repetition, identity boundaries)
 * 3. SDK communication rules (formatting, tone)
 * 4. SDK tool strategy rules (discovery-first, error handling, options)
 * 5. SDK UI control rules (navigation, forms, player, toasts)
 * 6. Platform capabilities
 * 7. Platform knowledge
 * 8. Platform workflows
 * 9. Platform instructions (tool-specific, domain rules)
 * 10. Platform routes
 * 11. Few-shot examples
 * 12. Runtime UI context
 */
export function buildAgentSystemPrompt(
  persona: AgentPersonaConfig,
  context?: PromptBuildContext,
): string {
  const parts: string[] = [];
  const overrides = persona.overrides ?? {};
  const style = overrides.communicationStyle ?? 'conversational';

  // 1. Platform identity
  parts.push(persona.identity);

  // 2. SDK base rules
  if (!overrides.disableAntiHallucination && !overrides.disableAntiRepetition) {
    parts.push('\n\n' + getBaseRules(persona.name));
  } else {
    if (!overrides.disableAntiHallucination) {
      const baseRules = getBaseRules(persona.name);
      const antiHallucSection = baseRules.split('### Anti-Repetition')[0];
      parts.push('\n\n' + antiHallucSection.trim());
    }
    if (!overrides.disableAntiRepetition) {
      const baseRules = getBaseRules(persona.name);
      const repetitionStart = baseRules.indexOf('### Anti-Repetition');
      const identityStart = baseRules.indexOf('### Identity Boundaries');
      if (repetitionStart !== -1 && identityStart !== -1) {
        parts.push('\n\n' + baseRules.slice(repetitionStart, identityStart).trim());
      }
    }
  }

  // 3. SDK communication rules
  parts.push('\n\n' + getCommunicationRules(style));

  // 4. SDK tool strategy rules
  if (!overrides.disableToolStrategy) {
    parts.push('\n\n' + getToolStrategyRules());
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
      parts.push(`**Trigger:** ${wf.trigger}`);
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
      parts.push(`\n**User:** ${example.user}`);
      if (example.toolCalls?.length) {
        parts.push(`*[Uses tools: ${example.toolCalls.join(', ')}]*`);
      }
      parts.push(`**Assistant:** ${example.assistant}`);
      if (example.followUp) {
        parts.push(`**Follow-up:** ${example.followUp}`);
      }
    }
  }

  // 12. Runtime UI context. What the client's UI sent for the worker is
  // excluded: its surface snapshot is the turn's UI tools, not prose, and
  // repeating every manifest here would cost thousands of tokens for nothing;
  // its knowledge is rendered once, after this prompt (ui/knowledge.ts).
  const uiContext = withoutClientUI(context?.context);
  if (uiContext && Object.keys(uiContext).length > 0) {
    parts.push('\n\n## CURRENT UI CONTEXT\n');
    parts.push('The user is currently on this page/state:');
    parts.push('```json');
    parts.push(JSON.stringify(uiContext, null, 2));
    parts.push('```');
  }

  return parts.join('\n');
}
