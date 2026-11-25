/**
 * Communication style rules — formatting, tone, output constraints.
 *
 * Two choices, given as `communicationStyle` on a persona's overrides:
 * - **The preset**, the tone: conversational (the default), concise, or formal.
 * - **The format**, how a reply is written: `markdown` (the default) for a
 *   panel that renders it, or `plain` for a channel that shows the reply
 *   exactly as written (a web chat that renders no markdown, a text message),
 *   where markdown would reach the person as stray symbols.
 *
 * `communicationStyle` is a preset (`'concise'`) or both
 * (`{ preset: 'concise', format: 'plain' }`); a preset alone is markdown, so
 * a persona that names no format is told exactly what it was before.
 *
 * How much each preset narrates its tool use is the persona's `narration`
 * (rules/narration.ts): fixed and brief by default, or deferred to the host's
 * instruction, with a section saying what holds whatever it asks.
 */
import { NARRATION_INSTRUCTION, resolveNarration, type NarrationSetting } from './narration.js';

/** The tone a persona's replies take. */
export type CommunicationStyle = 'conversational' | 'concise' | 'formal';

/** Every preset, in the order the docs give them. */
export const COMMUNICATION_STYLES: readonly CommunicationStyle[] = ['conversational', 'concise', 'formal'];

/**
 * How a reply is written: `markdown` for a panel that renders it, `plain` for
 * a channel that shows it exactly as written.
 */
export type CommunicationFormat = 'markdown' | 'plain';

/** Every format; the first is the default. */
export const COMMUNICATION_FORMATS: readonly CommunicationFormat[] = ['markdown', 'plain'];

/** A preset and a format together. Either may be left out: the default preset is conversational, the default format markdown. */
export interface CommunicationStyleOptions {
  preset?: CommunicationStyle;
  format?: CommunicationFormat;
}

/** What `communicationStyle` takes: a preset, or a preset and a format. */
export type CommunicationStyleSetting = CommunicationStyle | CommunicationStyleOptions;

/** A setting with both of its choices made. */
export interface ResolvedCommunicationStyle {
  preset: CommunicationStyle;
  format: CommunicationFormat;
}

/**
 * Both choices of a `communicationStyle` setting, defaults filled in.
 *
 * A preset given as a string reads as it always has: an unknown one is the
 * conversational preset. The object form is checked: a preset or a format
 * that is not one of the known values throws, naming it, so a channel that
 * needs plain text is never quietly sent markdown.
 */
export function resolveCommunicationStyle(setting?: CommunicationStyleSetting | null): ResolvedCommunicationStyle {
  if (setting === undefined || setting === null) return { preset: 'conversational', format: 'markdown' };
  if (typeof setting === 'string') return { preset: setting, format: 'markdown' };
  if (typeof setting !== 'object' || Array.isArray(setting)) {
    throw new Error(
      `[agent-sdk] communicationStyle must be a preset (${COMMUNICATION_STYLES.join(', ')}) or { preset, format }, not ${JSON.stringify(setting)}`,
    );
  }
  const { preset = 'conversational', format = 'markdown' } = setting;
  if (!COMMUNICATION_STYLES.includes(preset)) {
    throw new Error(`[agent-sdk] communicationStyle.preset must be one of ${COMMUNICATION_STYLES.join(', ')}, not ${JSON.stringify(preset)}`);
  }
  if (!COMMUNICATION_FORMATS.includes(format)) {
    throw new Error(`[agent-sdk] communicationStyle.format must be one of ${COMMUNICATION_FORMATS.join(', ')}, not ${JSON.stringify(format)}`);
  }
  return { preset, format };
}

/** The lines on how a reply is written, by format. */
const OUTPUT_FORMAT: Record<CommunicationFormat, string> = {
  markdown: `- Format responses with rich markdown: **bold**, headings, bullet lists, and tables when comparing data.
- When presenting data from tools, format as clean tables or lists — never dump raw JSON.`,
  plain: `- Write plain text only: short, natural sentences, the way a person writes in a chat or a text message. Your reply reaches the user exactly as you write it, so any formatting symbol shows up as a stray character.
- Use no markdown syntax of any kind: no asterisks or underscores for bold or italics, no # headings, no bullet or numbered lists, no tables, no code blocks or backticks, no block quotes, no horizontal rules, and no [text](link) links.
- When there are several items, say them in a sentence ("It comes in red, blue and silver.") or in a few short sentences, never as a list. Compare things in words, never in a table.
- When presenting data from tools, say what matters in sentences — never dump raw JSON.
- This holds for every reply, whatever the formatting of these instructions or of any example in them.`,
};

/** The preset lines that are about formatting, where the two formats differ. */
const PRESET_FORMAT_LINE: Record<'concise' | 'formal', Record<CommunicationFormat, string>> = {
  concise: {
    markdown: '- Use bullet points over paragraphs.',
    plain: '- Use one or two short sentences over a paragraph.',
  },
  formal: {
    markdown: '- Organize complex responses with numbered lists and clear headings.',
    plain: '- Organize a complex answer as a few short paragraphs in a clear order, each opening with what it covers.',
  },
};

/**
 * What a host that says how much the agent narrates adds after the truthfulness
 * rules: where the amount comes from, what holds at any amount, and the
 * amount when a turn comes without it.
 */
const HOST_NARRATION = `

### How Much You Say While You Work
- How much you write while you work (before a tool call, between steps, after a step that fails) is set by ${NARRATION_INSTRUCTION}, which comes with each turn. Follow it.
- Whatever it asks, everything you write is for the user: never your reasoning, never a result a tool has not returned yet, and never the same answer twice.
- When a turn comes with no such instruction, write at most one brief line before a tool call ("Let me check that for you."), or nothing at all.`;

/** The preset lines on narrating tool use and its failures, by narration setting. */
const NARRATION_LINES: Record<'conversationalTools' | 'conversationalFailures' | 'concise' | 'formal', Record<NarrationSetting, string>> = {
  conversationalTools: {
    brief: `- Briefly narrate what you're doing when using tools — but keep it to ONE short sentence, never a paragraph.`,
    host: `- Say what you're doing when using tools as ${NARRATION_INSTRUCTION} asks, in words a person would say, never as a log of your steps.`,
  },
  conversationalFailures: {
    brief: `- If a tool returns an error, acknowledge it briefly: "That didn't work — let me try another approach."
- When tools fail silently or return empty results, pivot immediately to an alternative without narrating each failure.`,
    host: `- If a tool returns an error, say what happened in plain words, as ${NARRATION_INSTRUCTION} asks, then try another approach.
- When tools fail silently or return empty results, move on to an alternative. Whether and how you tell the user is for ${NARRATION_INSTRUCTION} to decide.`,
  },
  concise: {
    brief: `- One sentence of narration per tool use, maximum.`,
    host: `- Narrate tool use only as much as ${NARRATION_INSTRUCTION} asks, in the fewest words that say it.`,
  },
  formal: {
    brief: `- Narrate tool usage with brief, factual statements.`,
    host: `- Narrate tool usage with factual statements, as much as ${NARRATION_INSTRUCTION} asks.`,
  },
};

export function getCommunicationRules(setting: CommunicationStyleSetting = 'conversational', narration: NarrationSetting = 'brief'): string {
  const { preset, format } = resolveCommunicationStyle(setting);
  const amount = resolveNarration(narration);
  const baseRules = `## COMMUNICATION RULES

### Output Format
- NEVER output internal reasoning, meta-instructions, or self-directed prompts.
${OUTPUT_FORMAT[format]}
- Everything you write is shown directly to the user as prose.

### Truthfulness About Async Work
- NEVER tell the user that a generation, export, or other async job is "in progress," "processing," or "rendering" unless the tool returned a real jobId.
- If a tool returns an error, an empty result, or no jobId, say what actually happened: "That didn't work — the backend rejected the request." Do NOT pretend the work started.
- If a tool returns a jobId, you may say it's processing and quote the jobId.
- A tool started real work only if its result says so (a job id, or a started status). Moving around the UI starts nothing by itself.${amount === 'host' ? HOST_NARRATION : ''}`;

  switch (preset) {
    case 'concise':
      return `${baseRules}

### Style: Concise
- Keep responses short and direct. Answer the question, then stop.
${PRESET_FORMAT_LINE.concise[format]}
- Omit filler phrases ("Great question!", "Let me help you with that!").
${NARRATION_LINES.concise[amount]}
- Only ask follow-up questions when you genuinely cannot proceed without more information.`;

    case 'formal':
      return `${baseRules}

### Style: Formal
- Maintain a professional, structured tone throughout.
- Use complete sentences and proper paragraph structure.
- Avoid emojis, slang, or overly casual language.
${PRESET_FORMAT_LINE.formal[format]}
- Address the user respectfully — no assumptions of familiarity.
${NARRATION_LINES.formal[amount]}`;

    case 'conversational':
    default:
      return `${baseRules}

### Style: Conversational
- Be conversational and enthusiastic. You are a collaborator, not a bot.
- Speak as a partner with opinions and expertise in the domain.
${NARRATION_LINES.conversationalTools[amount]}
- Ask ONE focused question at a time. Do NOT ask 5 questions in one message.
- Suggest defaults the user can accept: "I'm thinking X — sound right?"
${NARRATION_LINES.conversationalFailures[amount]}`;
  }
}
