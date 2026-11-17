/**
 * What the communication format tests look for: the lines only the markdown
 * format writes, the lines only the plain format writes, and a reader that
 * finds every request for markdown in a text the model is given.
 */

/** Lines only the markdown format writes: in every preset, and in the concise and formal presets. */
export const MARKDOWN_ONLY_LINES = {
  common: [
    '- Format responses with rich markdown: **bold**, headings, bullet lists, and tables when comparing data.',
    '- When presenting data from tools, format as clean tables or lists — never dump raw JSON.',
  ],
  presets: ['- Use bullet points over paragraphs.', '- Organize complex responses with numbered lists and clear headings.'],
};

/** The lines the plain format writes in every preset, in order. */
export const PLAIN_LINES = [
  '- Write plain text only: short, natural sentences, the way a person writes in a chat or a text message. Your reply reaches the user exactly as you write it, so any formatting symbol shows up as a stray character.',
  '- Use no markdown syntax of any kind: no asterisks or underscores for bold or italics, no # headings, no bullet or numbered lists, no tables, no code blocks or backticks, no block quotes, no horizontal rules, and no [text](link) links.',
  '- When there are several items, say them in a sentence ("It comes in red, blue and silver.") or in a few short sentences, never as a list. Compare things in words, never in a table.',
  '- When presenting data from tools, say what matters in sentences — never dump raw JSON.',
  '- This holds for every reply, whatever the formatting of these instructions or of any example in them.',
];

/** Words a request for formatted output uses. */
const FORMATTING = /\bmarkdown\b|\bbold\b|\bitalics?\b|\bbullet(?: point)?s?\b|\bheadings?\b|\btables?\b|\bnumbered lists?\b|\bas (?:a |clean )?lists?\b/i;
/** Words that make a sentence about formatting a prohibition rather than a request. */
const PROHIBITION = /\b(?:no|never|not|without)\b|n['’]t\b/i;

/** A line's clauses: its sentences, and the parts of each on either side of a dash or a semicolon. */
const CLAUSE_BREAK = /(?<=[.!?])\s+|\s+[—–]\s+|;\s+/;

/**
 * Every line of `text` with a clause that asks for formatted output: one that
 * names markdown, bold, bullets, headings, tables or lists, and does not
 * forbid them ("format as clean tables or lists — never dump raw JSON" asks,
 * in its first clause). Empty when nothing in it asks for markdown.
 */
export function markdownRequests(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.split(CLAUSE_BREAK).some((clause) => FORMATTING.test(clause) && !PROHIBITION.test(clause)));
}
