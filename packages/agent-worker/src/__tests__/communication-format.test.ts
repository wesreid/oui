/**
 * How a persona's replies are written: `communicationStyle` is a preset, or a
 * preset and a format. The markdown format is what every persona was told
 * before the format existed, byte for byte; the plain format asks for short
 * natural sentences and no markdown of any kind, and nothing else in the
 * prompt asks for markdown. The artifact checked is the system prompt the
 * builder writes; communication-format.e2e.test.ts checks the same through a
 * whole turn.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAgentSystemPrompt,
  COMMUNICATION_FORMATS,
  COMMUNICATION_STYLES,
  getCommunicationRules,
  resolveCommunicationStyle,
  type AgentPersonaConfig,
  type CommunicationStyle,
  type CommunicationStyleSetting,
} from '../index.js';
import { markdownRequests, MARKDOWN_ONLY_LINES, PLAIN_LINES } from './support/communication-format.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/communication/${name}`, import.meta.url)), 'utf8');
/** A persona with every section the builder writes: capabilities, knowledge, a workflow, instructions, routes and an example. */
const PERSONA = JSON.parse(fixture('persona.json')) as AgentPersonaConfig;
const CONTEXT = { userId: 'u1', accountId: 'a1', context: { currentPath: '/inventory' } };
const withStyle = (communicationStyle: CommunicationStyleSetting) => buildAgentSystemPrompt({ ...PERSONA, overrides: { communicationStyle } }, CONTEXT);

/** Each preset's own formatting line, by format. */
const PRESET_LINES: Record<CommunicationStyle, { markdown: string | null; plain: string | null }> = {
  conversational: { markdown: null, plain: null },
  concise: { markdown: '- Use bullet points over paragraphs.', plain: '- Use one or two short sentences over a paragraph.' },
  formal: {
    markdown: '- Organize complex responses with numbered lists and clear headings.',
    plain: '- Organize a complex answer as a few short paragraphs in a clear order, each opening with what it covers.',
  },
};

describe('the default: markdown, exactly as before the format existed', () => {
  it.each(COMMUNICATION_STYLES)('the %s preset’s rules are byte for byte the earlier release’s, however markdown is asked for', (preset) => {
    const before = fixture(`rules.${preset}.markdown.txt`);
    expect(getCommunicationRules(preset)).toBe(before);
    expect(getCommunicationRules({ preset })).toBe(before);
    expect(getCommunicationRules({ preset, format: 'markdown' })).toBe(before);
  });

  it('no setting at all is the conversational preset in markdown', () => {
    const before = fixture('rules.conversational.markdown.txt');
    expect(getCommunicationRules()).toBe(before);
    expect(getCommunicationRules({})).toBe(before);
    expect(getCommunicationRules({ format: 'markdown' })).toBe(before);
  });

  it('a whole persona prompt with no style, or markdown asked for, is byte for byte the earlier release’s', () => {
    const before = fixture('prompt.default.markdown.txt');
    expect(buildAgentSystemPrompt(PERSONA, CONTEXT)).toBe(before);
    expect(withStyle('conversational')).toBe(before);
    expect(withStyle({ format: 'markdown' })).toBe(before);
    expect(withStyle({ preset: 'conversational', format: 'markdown' })).toBe(before);
  });

  it('an unknown preset given as a string is still the conversational preset, as it always was', () => {
    expect(getCommunicationRules('chatty' as CommunicationStyle)).toBe(fixture('rules.conversational.markdown.txt'));
  });
});

describe.each(COMMUNICATION_STYLES)('the %s preset', (preset) => {
  const markdown = getCommunicationRules({ preset, format: 'markdown' });
  const plain = getCommunicationRules({ preset, format: 'plain' });

  it('in markdown asks for rich markdown, and for tables or lists from tools', () => {
    for (const line of MARKDOWN_ONLY_LINES.common) expect(markdown).toContain(line);
    if (PRESET_LINES[preset].markdown) expect(markdown).toContain(PRESET_LINES[preset].markdown);
    for (const line of PLAIN_LINES) expect(markdown).not.toContain(line);
  });

  it('in plain text drops every markdown line and says how to write without it', () => {
    for (const line of [...MARKDOWN_ONLY_LINES.common, ...MARKDOWN_ONLY_LINES.presets]) expect(plain).not.toContain(line);
    for (const line of PLAIN_LINES) expect(plain).toContain(line);
    if (PRESET_LINES[preset].plain) expect(plain).toContain(PRESET_LINES[preset].plain);
  });

  it('keeps every other rule as it is: only the lines about formatting differ', () => {
    const formatting = new Set([
      ...MARKDOWN_ONLY_LINES.common,
      ...MARKDOWN_ONLY_LINES.presets,
      ...PLAIN_LINES,
      ...Object.values(PRESET_LINES).flatMap((l) => [l.markdown, l.plain].filter((x): x is string => !!x)),
    ]);
    const rest = (text: string) => text.split('\n').filter((line) => !formatting.has(line));
    expect(rest(plain)).toEqual(rest(markdown));
    expect(plain).toContain(`### Style: ${preset[0].toUpperCase()}${preset.slice(1)}`);
  });

  it('in plain text, the whole persona prompt asks for no markdown anywhere and carries no bold of its own', () => {
    const prompt = withStyle({ preset, format: 'plain' });
    expect(markdownRequests(prompt)).toEqual([]);
    expect(prompt).not.toContain('**');
    expect(prompt).toContain(PLAIN_LINES[0]);
    // The example and the workflow keep their content, under plain labels.
    expect(prompt).toContain('\nUser: Do you have a blue RAV4?');
    expect(prompt).toContain('[Uses tools: inventory_search]');
    expect(prompt).toContain('Assistant: We have two. Want me to show them?');
    expect(prompt).toContain('Follow-up: Shows them on the page.');
    expect(prompt).toContain('Trigger: The user wants to drive a car');
  });

  it('in markdown, the same check finds the requests it is there to find', () => {
    const found = markdownRequests(withStyle({ preset, format: 'markdown' }));
    expect(found).toEqual([...MARKDOWN_ONLY_LINES.common, ...(PRESET_LINES[preset].markdown ? [PRESET_LINES[preset].markdown] : [])]);
  });

  it('in plain text, with the SDK’s rule sections turned off, still asks for none', () => {
    const prompt = buildAgentSystemPrompt(
      {
        ...PERSONA,
        overrides: {
          communicationStyle: { preset, format: 'plain' },
          disableToolStrategy: true,
          disableUIControlRules: true,
          disableAntiRepetition: true,
        },
      },
      CONTEXT,
    );
    expect(markdownRequests(prompt)).toEqual([]);
    expect(prompt).toContain(PLAIN_LINES[1]);
  });
});

describe('resolveCommunicationStyle', () => {
  it('fills in the defaults: conversational, markdown', () => {
    expect(resolveCommunicationStyle()).toEqual({ preset: 'conversational', format: 'markdown' });
    expect(resolveCommunicationStyle(null)).toEqual({ preset: 'conversational', format: 'markdown' });
    expect(resolveCommunicationStyle('formal')).toEqual({ preset: 'formal', format: 'markdown' });
    expect(resolveCommunicationStyle({ format: 'plain' })).toEqual({ preset: 'conversational', format: 'plain' });
    expect(resolveCommunicationStyle({ preset: 'concise', format: 'plain' })).toEqual({ preset: 'concise', format: 'plain' });
    expect(COMMUNICATION_FORMATS[0]).toBe('markdown');
  });

  it('refuses an object form it cannot read, naming the field', () => {
    expect(() => resolveCommunicationStyle({ format: 'html' as never })).toThrow(/communicationStyle\.format must be one of markdown, plain, not "html"/);
    expect(() => resolveCommunicationStyle({ preset: 'chatty' as never })).toThrow(/communicationStyle\.preset must be one of conversational, concise, formal, not "chatty"/);
    expect(() => resolveCommunicationStyle(['plain'] as never)).toThrow(/communicationStyle must be a preset/);
    expect(() => resolveCommunicationStyle(7 as never)).toThrow(/communicationStyle must be a preset/);
    expect(() => buildAgentSystemPrompt({ ...PERSONA, overrides: { communicationStyle: { format: 'PLAIN' as never } } })).toThrow(/communicationStyle\.format/);
  });
});
