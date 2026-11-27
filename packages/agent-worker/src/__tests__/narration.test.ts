/**
 * How much the agent says while it works: `narration` on a persona's
 * overrides. The artifact checked is the system prompt the builder writes.
 *
 * - With no setting, or `brief`, every rule is byte for byte the earlier
 *   release's (the fixtures in fixtures/communication were written by it).
 * - With `host`, no rule fixes the amount: the base, communication and tool
 *   strategy rules keep what holds at any amount, and one section says the
 *   amount is the host's instruction, with one brief line when a turn comes
 *   without it. The host rules are held to a size: they add next to nothing
 *   to the brief prompt.
 * - With `host` and `narrationDefault`, that section states the host's default
 *   level, which a turn's instruction replaces, in place of the brief line.
 * - The rules that name tools are the same at both settings, so a limited
 *   step is told the same tools either way.
 *
 * narration.e2e.test.ts checks the same through a whole turn.
 */
import { createHash } from 'node:crypto';
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
  resolveNarrationDefault,
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
const withNarration = (narration?: NarrationSetting, narrationDefault?: string) =>
  buildAgentSystemPrompt(
    { ...PERSONA, overrides: { ...PERSONA.overrides, ...(narration ? { narration } : {}), ...(narrationDefault !== undefined ? { narrationDefault } : {}) } },
    CONTEXT,
  );
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The lines of a prompt that the brief prompt does not have: what the host rules cost. */
const hostOnly = (prompt: string) => {
  const brief = new Set(withNarration().split('\n'));
  return prompt.split('\n').filter((line) => !brief.has(line));
};
/** A host's default level, as it states it once (`narrationDefault`). */
const EXPLAIN_DEFAULT = [
  '- Before you act, say which feature fits the task, where it lives and why.',
  '- Before each distinct step, say in a sentence or two what you will do and why.',
  '- After a failed step, say what happened and what you will try next.',
].join('\n');

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
    // The hash of the prompt for this persona, pinned so a change to any rule is a deliberate one: agent SDK
    // 0.40.0's (8eabd0ee…, 17,234 characters) until the index line said what each input is (0.47.0, 4d6e661f…, 17,652),
    // then where a room's choices made at run time are read (0.48.0, 6872c61a…, 17,644), then what "row" alone is
    // (0.49.0): its one rule of working from the index is the only change.
    expect(sha256(withNarration())).toBe('3f32e8102d27960d35803bb8034a28a9b29969e9008fb795e6e5518145090da3');
    expect(withNarration()).toHaveLength(17_721);
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
    expect(host).toContain('- Never say something is done, made, saved or found before the tool that does it has returned success.');
  });

  it('says once, in one section, that the amount is the host’s instruction, which comes with the turn', () => {
    expect(host).toContain('### How Much You Say While You Work');
    expect(host).toContain(`- How much you write before a tool call, between steps and after a failed step is set by ${NARRATION_INSTRUCTION}, which comes with the turn.`);
    expect(host.split(NARRATION_INSTRUCTION)).toHaveLength(2);
    // The base and tool strategy rules fix no amount and name no instruction: the section is where it is said.
    expect(getBaseRules('Ava', 'host')).not.toContain(NARRATION_INSTRUCTION);
    expect(getToolStrategyRules(undefined, 'host')).not.toContain(NARRATION_INSTRUCTION);
    expect(getToolStrategyRules(undefined, 'host')).toContain('- Never write filler between tool rounds (pleasantries, or repeating what the user has already read)');
    expect(getToolStrategyRules(undefined, 'host')).toContain('- If a tool returns an error, try an alternative approach.');
    for (const preset of COMMUNICATION_STYLES) {
      const rules = getCommunicationRules(preset, 'host');
      expect(rules.split(NARRATION_INSTRUCTION)).toHaveLength(2);
      expect(rules).toContain('### How Much You Say While You Work');
    }
  });

  it('is the trimmed host prompt, byte for byte (fixtures/communication/prompt.host.markdown.txt)', () => {
    expect(host).toBe(fixture('prompt.host.markdown.txt'));
  });

  it('costs next to nothing over the brief prompt: the host rules are trimmed to what is needed', () => {
    // Agent SDK 0.40.0's host rules were 1,249 characters longer than the brief prompt (about 431 tokens at
    // 2.9 characters a token), and their own lines came to 2,320 characters (about 800 tokens).
    expect(host.length - withNarration().length).toBeLessThanOrEqual(50);
    expect(hostOnly(host).join('\n').length).toBeLessThanOrEqual(1_100);
  });

  it('asks for no check of its own work: verifying is for after a failed step', () => {
    for (const line of hostOnly(host)) expect(line).not.toMatch(/confirm|verif|re-?read|check|took effect/i);
    for (const line of hostOnly(withNarration('host', EXPLAIN_DEFAULT))) expect(line).not.toMatch(/confirm|verif|re-?read|check|took effect/i);
  });

  it('holds a turn that comes with no instruction to one brief line', () => {
    expect(host).toContain('Without one, write at most one brief line before a tool call, or nothing.');
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

describe('host with a default level: the host states it once, in the system prompt', () => {
  const stated = withNarration('host', EXPLAIN_DEFAULT);

  it('states the default where the brief line was, and says a turn’s instruction replaces it', () => {
    expect(stated).toContain(
      `### How Much You Say While You Work\nHow much you write before a tool call, between steps and after a failed step is as follows, unless the turn comes with ${NARRATION_INSTRUCTION}, which then replaces it:\n${EXPLAIN_DEFAULT}`,
    );
    expect(stated).not.toContain('Without one, write at most one brief line');
    expect(stated.split(NARRATION_INSTRUCTION)).toHaveLength(2);
    // Only the section changes: everything else is the host prompt's.
    const section = (prompt: string) => prompt.replace(/### How Much You Say While You Work\n[\s\S]*?\n\n### Style/, '### Style');
    expect(section(stated)).toBe(section(withNarration('host')));
  });

  it('takes the text as given, trimmed, at every preset, and is the same prompt whatever the turn', () => {
    expect(withNarration('host', `\n${EXPLAIN_DEFAULT}\n\n`)).toBe(stated);
    for (const preset of COMMUNICATION_STYLES) expect(getCommunicationRules(preset, 'host', EXPLAIN_DEFAULT)).toContain(EXPLAIN_DEFAULT);
    expect(buildAgentSystemPrompt({ ...PERSONA, overrides: { narration: 'host', narrationDefault: EXPLAIN_DEFAULT } }, { ...CONTEXT, context: { currentPath: '/inventory' } })).toBe(
      buildAgentSystemPrompt({ ...PERSONA, overrides: { narration: 'host', narrationDefault: EXPLAIN_DEFAULT } }, CONTEXT),
    );
  });

  it('is the host’s only: refused with brief or no narration, and refused empty or not text', () => {
    expect(resolveNarrationDefault('host', undefined)).toBeNull();
    expect(resolveNarrationDefault(undefined, null)).toBeNull();
    expect(resolveNarrationDefault('host', ' - Say it. ')).toBe('- Say it.');
    expect(() => withNarration(undefined, EXPLAIN_DEFAULT)).toThrow(/narrationDefault is the host's default amount: it needs narration: 'host'/);
    expect(() => withNarration('brief', EXPLAIN_DEFAULT)).toThrow(/needs narration: 'host'/);
    expect(() => withNarration('host', '   ')).toThrow(/narrationDefault must be the text of the default amount, not " {3}"/);
    expect(() => resolveNarrationDefault('host', 3)).toThrow(/not 3/);
    expect(() => getCommunicationRules('conversational', 'brief', EXPLAIN_DEFAULT)).toThrow(/needs narration: 'host'/);
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
