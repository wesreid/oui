/**
 * Tool strategy rules — discovery-first patterns, error handling,
 * multi-round behavior, and options presentation.
 *
 * Every rule that names a tool is a `ToolRule` (prompt/step-tools.ts): a step
 * that does not offer `present_options` is never told to use it.
 */
import { PRESENT_OPTIONS_TOOL } from '../../tools/sdk-tool-names.js';
import { EVERY_TOOL, renderPieces, rulesOf, type OfferedTools, type PromptPiece, type ToolRule } from '../step-tools.js';
import { resolveNarration, type NarrationSetting } from './narration.js';

/**
 * The multi-round and error-handling lines that say how much is written
 * between tool rounds, by narration setting (rules/narration.ts). With `host`
 * they fix no amount: the communication rules say once where it comes from.
 * The rest of the tool strategy is the same at every setting.
 */
const MULTI_ROUND: Record<NarrationSetting, string> = {
  brief: `- While one operation processes, move on to the next — narrate this briefly: "That's processing — meanwhile, let's handle..."
- Do NOT emit filler text between tool rounds. Users see text accumulate in real-time.
- If a tool fails and you retry with a different approach, do NOT re-emit the same explanation.
- When tools fail silently or return empty results, pivot immediately without narrating each failure.
- Users should see a smooth experience, not a log of your retries.

### Error Handling
- If a tool returns an error, acknowledge briefly and try an alternative approach.`,
  host: `- While one operation processes, move on to the next.
- Never write filler between tool rounds (pleasantries, or repeating what the user has already read): users see text as you write it.
- If a tool fails and you retry with a different approach, do NOT re-emit the same explanation.
- When tools fail silently or return empty results, pivot to an alternative.

### Error Handling
- If a tool returns an error, try an alternative approach.`,
};

/** The tool strategy rules, as pieces, at a narration setting. */
const toolStrategy = (narration: NarrationSetting): readonly PromptPiece[] => [
  `## TOOL STRATEGY

### Discovery First
When the user asks an exploratory question ("What do you have?", "Show me my stuff"), use explore/list tools FIRST for a dimensional summary. Only drill into search or get tools when they ask for something specific. Never dump raw data.

Granularity levels:
1. explore/list → dimensional summary (counts, facets, recent items)
2. search/filter → filtered results with pagination
3. get → full detail for a single item by ID

### Multi-Round Behavior
- When executing multi-step workflows, work on MULTIPLE THINGS IN PARALLEL when tools support it.
${MULTI_ROUND[narration]}
- Never expose error messages, stack traces, or internal tool names to the user.
- If multiple approaches fail, inform the user honestly and suggest a manual alternative.
- Never retry the exact same operation more than twice.

### Answering Questions
A question the user asks — what something is, how it works, why it happened, what their options are — is answered in your reply, in words, before anything else. A card is never the answer: its context only leads into a choice, and a user who asks what something is and gets "Want me to set it up?" has not been answered. Answer from what the page and its knowledge say, in your own words`,
  {
    tools: [PRESENT_OPTIONS_TOOL],
    text: `; then, only if a choice really follows from the answer, offer it with ${PRESENT_OPTIONS_TOOL}`,
  },
  `. A question asked again means your last reply did not answer it: answer it now, in words, and offer nothing new.`,
  {
    tools: [PRESENT_OPTIONS_TOOL],
    text: `

### Options Presentation
When you need the user to pick from choices, use the ${PRESENT_OPTIONS_TOOL} tool with a structured options array. Do NOT write options as text bullets — the UI renders them as clickable elements.
- Set allowCustom:true when the user might want to type their own answer.
- Use style:"cards" or style:"list" when options have descriptions, and style:"buttons" for simple labels.
- Asking the user ends your response: their answer arrives as their next message. Only ask when you genuinely need their choice to continue — not as a substitute for an action you can take.`,
  },
  `

### Approvals
- A tool marked "Needs the user's approval" (an order, a payment, a send, a publish, a permanent deletion) shows the user an approval card with exactly the arguments you called it with, and runs only if they approve it there. Call it directly when they ask for it; do not ask for a yes in chat first, and never treat a typed yes as an approval.
- Calling one ends your response: you are told the outcome in the next turn. Only one such action is approved at a time.
- A message may carry an <approval> block: what the user decided on the card and whether the action ran. Report that outcome as it says, and never say an action ran when the block says it did not.
- For anything else that is significant or expensive but needs no approval (a long generation, say), a brief check is enough: "Ready to generate?"`,
];

/**
 * The tool strategy rules' rules that name tools: what a step is not told when it does not offer them.
 * They are the same at every narration setting, which changes only words that name no tool.
 */
export const TOOL_STRATEGY_TOOL_RULES: readonly ToolRule[] = rulesOf(toolStrategy('brief'));

/**
 * The tool strategy rules, as a step offering `offered` is told them (every tool by default), at
 * a narration setting (`brief` by default).
 */
export function getToolStrategyRules(offered: OfferedTools = EVERY_TOOL, narration: NarrationSetting = 'brief'): string {
  return renderPieces(toolStrategy(resolveNarration(narration)), offered);
}
