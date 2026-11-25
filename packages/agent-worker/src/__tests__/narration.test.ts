/**
 * How much the agent says while it works: `narration` on a persona's
 * overrides. The artifact checked is the system prompt the builder writes.
 *
 * - With no setting, or `brief`, every rule is byte for byte the earlier
 *   release's (the fixtures in fixtures/communication were written by it).
 * - With `host`, no rule fixes the amount: the base, communication and tool
 *   strategy rules keep what holds at any amount and defer the amount to the
 *   host's instruction, with one brief line when a turn comes without it.
 * - The rules that name tools are the same at both settings, so a limited
 *   step is told the same tools either way.
 *
 * narration.e2e.test.ts checks the same through a whole turn.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAgentSystemPrompt,
  COMMUNICATION_STYLES,
  getBaseRules,
  getCommunicationRules,
  getToolStrategyRules,
  NARRATION_SETTINGS,
  resolveNarration,
  systemPromptForTools,
  type AgentPersonaConfig,
  type NarrationSetting,
} from '../index.js';
import { offeredTools } from '../prompt/step-tools.js';
import { TOOL_STRATEGY_TOOL_RULES } from '../prompt/rules/tool-strategy.js';
import { NARRATION_INSTRUCTION } from '../prompt/rules/narration.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/communication/${name}`, import.meta.url)), 'utf8');
/** A persona with every section the builder writes. */
const PERSONA = JSON.parse(fixture('persona.json')) as AgentPersonaConfig;
const CONTEXT = { userId: 'u1', accountId: 'a1', context: { currentPath: '/inventory' } };
const withNarration = (narration?: NarrationSetting) =>
  buildAgentSystemPrompt({ ...PERSONA, overrides: { ...PERSONA.overrides, ...(narration ? { narration } : {}) } }, CONTEXT);

/** Every line of today's rules that fixes how much is said while the agent works. */
const BRIEF_ONLY_LINES = [
  // base
  '- So before a tool call, write at most one brief line meant for the user ("Let me check that for you."), or nothing at all.',
  // communication, by preset
  "- Briefly narrate what you're doing when using tools — but keep it to ONE short sentence, never a paragraph.",
  '- If a tool returns an error, acknowledge it briefly: "That didn\'t work — let me try another approach."',
  '- When tools fail silently or return empty results, pivot immediately to an alternative without narrating each failure.',
  '- One sentence of narration per tool use, maximum.',
  '- Narrate tool usage with brief, factual statements.',
  // tool strategy
  '- While one operation processes, move on to the next — narrate this briefly',
  '- Do NOT emit filler text between tool rounds.',
  '- When tools fail silently or return empty results, pivot immediately without narrating each failure.',
  '- Users should see a smooth experience, not a log of your retries.',
  '- If a tool returns an error, acknowledge briefly and try an alternative approach.',
];

/** What holds at any amount: said at both settings. */
const EVERY_SETTING_LINES = [
  'Never write your reasoning, plans, guesses, corrections of yourself or notes about the user there, or anywhere else',
  '- Write your substantive answer once, after the tools you need have returned. Do not answer before a tool call and then answer again after it.',
  '- If a tool fails and you retry with a different approach, do NOT re-emit the same explanation.',
  '- NEVER tell the user that a generation, export, or other async job is "in progress," "processing," or "rendering" unless the tool returned a real jobId.',
  '- NEVER output internal reasoning, meta-instructions, or self-directed prompts.',
];

describe('no setting: the rules are the earlier release’s, byte for byte', () => {
  it('a whole persona prompt with no narration, or brief, is the earlier release’s', () => {
    const before = fixture('prompt.default.markdown.txt');
    expect(withNarration()).toBe(before);
    expect(withNarration('brief')).toBe(before);
  });

  it.each(COMMUNICATION_STYLES)('the %s preset’s rules are the earlier release’s with no narration and with brief', (preset) => {
    const before = fixture(`rules.${preset}.markdown.txt`);
    expect(getCommunicationRules(preset, 'brief')).toBe(before);
    expect(getCommunicationRules({ preset }, undefined)).toBe(before);
  });

  it('the base and tool strategy rules default to brief', () => {
    expect(getBaseRules('Ava')).toBe(getBaseRules('Ava', 'brief'));
    expect(getToolStrategyRules()).toBe(getToolStrategyRules(undefined, 'brief'));
    const everyPreset = (narration?: NarrationSetting) =>
      [withNarration(narration), ...COMMUNICATION_STYLES.map((preset) => getCommunicationRules(preset, narration))].join('\n');
    for (const line of BRIEF_ONLY_LINES) expect(everyPreset()).toContain(line);
    for (const line of BRIEF_ONLY_LINES) expect(everyPreset('brief')).toContain(line);
  });

  it('resolves no setting as brief, and refuses one it does not know, naming it', () => {
    expect(resolveNarration()).toBe('brief');
    expect(resolveNarration(null)).toBe('brief');
    expect(NARRATION_SETTINGS).toEqual(['brief', 'host']);
    for (const setting of NARRATION_SETTINGS) expect(resolveNarration(setting)).toBe(setting);
    expect(() => resolveNarration('chatty' as never)).toThrow(/narration must be one of brief, host, not "chatty"/);
    expect(() => getBaseRules('Ava', 'loud' as never)).toThrow(/narration must be one of/);
    expect(() => withNarration('explain' as never)).toThrow(/narration must be one of brief, host, not "explain"/);
  });
});

describe('host: the amount is the host’s instruction', () => {
  const host = withNarration('host');

  it('fixes no amount anywhere in the prompt, at any preset', () => {
    const everyPreset = [host, ...COMMUNICATION_STYLES.map((preset) => getCommunicationRules(preset, 'host'))].join('\n');
    for (const line of BRIEF_ONLY_LINES) expect(everyPreset).not.toContain(line);
    expect(everyPreset).not.toMatch(/ONE short sentence|filler text|without narrating each failure|narrate this briefly|brief, factual/);
  });

  it('keeps what holds at any amount: words for the user only, no early claims, one answer', () => {
    for (const line of EVERY_SETTING_LINES) {
      expect(host).toContain(line);
      expect(withNarration()).toContain(line);
    }
    expect(host).toContain('- So whatever you write before or between tool calls is meant for the user: only words you would say to them.');
    expect(host).toContain('- Never say something is done, made, saved or found before the tool that does it has returned and confirmed it.');
    expect(host).toContain('never your reasoning, never a result a tool has not returned yet, and never the same answer twice');
  });

  it('defers the amount to the host’s instruction, which comes with the turn, in every rule that spoke of it', () => {
    expect(host).toContain('### How Much You Say While You Work');
    expect(host).toContain(`is set by ${NARRATION_INSTRUCTION}, which comes with each turn. Follow it.`);
    expect(getBaseRules('Ava', 'host')).toContain(`How much you write there is set by ${NARRATION_INSTRUCTION}, which comes with the turn.`);
    expect(getToolStrategyRules(undefined, 'host')).toContain(`write there what ${NARRATION_INSTRUCTION} asks for, and nothing more`);
    expect(getToolStrategyRules(undefined, 'host')).toContain(`- If a tool returns an error, say so as ${NARRATION_INSTRUCTION} asks, and try an alternative approach.`);
    for (const preset of COMMUNICATION_STYLES) {
      const rules = getCommunicationRules(preset, 'host');
      expect(rules).toContain(NARRATION_INSTRUCTION);
      expect(rules).toContain('### How Much You Say While You Work');
    }
    expect(getCommunicationRules('conversational', 'host')).toContain(
      `Whether and how you tell the user is for ${NARRATION_INSTRUCTION} to decide.`,
    );
  });

  it('holds a turn that comes with no instruction to one brief line', () => {
    expect(host).toContain(
      '- When a turn comes with no such instruction, write at most one brief line before a tool call ("Let me check that for you."), or nothing at all.',
    );
  });

  it('changes nothing before the multi-round rules, and nothing from the answering rules on', () => {
    const brief = withNarration();
    const head = (prompt: string) => prompt.slice(0, prompt.indexOf('#### MULTI-ROUND TURNS'));
    const tail = (prompt: string) => prompt.slice(prompt.indexOf('### Answering Questions'));
    expect(head(host)).toBe(head(brief));
    expect(tail(host)).toBe(tail(brief));
    expect(tail(host)).toContain('## CAPABILITIES');
  });

  it('is the same prompt whatever the turn: the setting, not the amount, is in the system prompt', () => {
    expect(withNarration('host')).toBe(host);
    expect(buildAgentSystemPrompt({ ...PERSONA, overrides: { narration: 'host' } }, { ...CONTEXT, context: { currentPath: '/inventory' } })).toBe(
      buildAgentSystemPrompt({ ...PERSONA, overrides: { narration: 'host' } }, CONTEXT),
    );
  });
});

describe('the rules that name tools, at both settings', () => {
  it('are the same rules, so a limited step is told the same tools either way', () => {
    const offered = offeredTools(['ui_act']);
    for (const narration of NARRATION_SETTINGS) {
      expect(systemPromptForTools(getToolStrategyRules(undefined, narration), offered)).toBe(getToolStrategyRules(offered, narration));
      for (const rule of TOOL_STRATEGY_TOOL_RULES) expect(getToolStrategyRules(undefined, narration)).toContain(rule.text);
    }
    expect(getToolStrategyRules(offered, 'host')).not.toContain('present_options');
  });
});
