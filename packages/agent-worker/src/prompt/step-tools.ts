/**
 * What the SDK tells the model names only the tools its step offers.
 *
 * A host's turn policy can hold a step to some of the turn's tools
 * (`activeTools`), or to none (`toolChoice: 'none'`), or make it call one.
 * The SDK's own words about tools (its rules in the system prompt, the
 * page's index, the turn's context lines, a step's notes) used to name every
 * tool the SDK knows whatever the step offered. A step limited to one tool
 * still read "offer it with present_options", and the model sometimes called
 * `present_options` beside the tool it was given: the call failed
 * (`AI_NoSuchToolError`), and the turn ended with no reply (Nova, 2026-11-19).
 *
 * So every piece of the SDK's prompt that names a tool is a `ToolRule`: it
 * says which tools it names, and it is said only when the step offers every
 * one of them, or else its `otherwise` (often nothing). What a step offers is
 * one value, `OfferedTools`, worked out once per step by the orchestrator and
 * handed to everything that writes the step's prompt. The SDK's rules that a
 * host renders into its own prompt (`getToolStrategyRules`,
 * `getUIControlRules`, through `buildAgentSystemPrompt`) are filtered out of
 * that prompt by the same rules (`promptForTools`), so a host never passes
 * the step's tools anywhere.
 *
 * A limited step already sends the provider a different tool list, and the
 * tools come first in the cached prefix, so saying less on it costs no cache
 * that the limit had not already cost. Steps that offer the same tools are
 * told exactly the same words.
 */

/** The tools one step of a turn offers the model, by the names the model calls them. */
export interface OfferedTools {
  /** Whether the step offers a tool of this name. */
  has(name: string): boolean;
  /** One key per set: the names in order, or `*` for every tool. */
  readonly key: string;
}

/** The tools a step offers: exactly these. */
export function offeredTools(names: Iterable<string>): OfferedTools {
  const set = new Set(names);
  return { has: (name) => set.has(name), key: [...set].sort().join(',') };
}

/** Every tool: what the SDK's rules are written for when nothing limits them (a host's prompt, a rule's full text). */
export const EVERY_TOOL: OfferedTools = { has: () => true, key: '*' };

/** A piece of the SDK's prompt: words said as they are, or a rule said only when its tools are offered. */
export type PromptPiece = string | ToolRule;

/** Words of the SDK's prompt that name tools: said only when the step offers every tool they name. */
export interface ToolRule {
  /** The tools the words name. The rule is said when the step offers all of them. */
  readonly tools: readonly string[];
  /** What is said when it offers them, before what is `within` it. */
  readonly text: string;
  /** Pieces said after `text`, only when the rule itself is: a narrower rule inside a broader one. */
  readonly within?: readonly PromptPiece[];
  /** What is said in its place when the step does not offer them. Nothing by default. */
  readonly otherwise?: string;
}

/** Whether a step offers every tool the rule names. */
export const offersAll = (offered: OfferedTools, tools: readonly string[]): boolean => tools.every((name) => offered.has(name));

/** The pieces as the step is told them. */
export function renderPieces(pieces: readonly PromptPiece[], offered: OfferedTools): string {
  return pieces.map((piece) => (typeof piece === 'string' ? piece : renderRule(piece, offered))).join('');
}

/** A rule as the step is told it: its words, or what is said in their place. */
export function renderRule(rule: ToolRule, offered: OfferedTools): string {
  if (!offersAll(offered, rule.tools)) return rule.otherwise ?? '';
  return rule.text + renderPieces(rule.within ?? [], offered);
}

/** A rule's words when every tool is offered: what a host's prompt carries. */
export function fullText(rule: ToolRule): string {
  return renderRule(rule, EVERY_TOOL);
}

/** The rules among the pieces, outermost only: the ones a prompt carries whole. */
export function rulesOf(pieces: readonly PromptPiece[]): ToolRule[] {
  return pieces.filter((piece): piece is ToolRule => typeof piece !== 'string');
}

/**
 * A prompt as a step that offers `offered` is told it: every rule of `rules`
 * the prompt carries in full is replaced by what the step is told of it.
 * Everything else in the prompt (the host's own words) is left as it is.
 */
export function promptForTools(prompt: string, rules: readonly ToolRule[], offered: OfferedTools): string {
  if (offered === EVERY_TOOL) return prompt;
  let told = prompt;
  for (const rule of rules) {
    const full = fullText(rule);
    const said = renderRule(rule, offered);
    if (full !== said && told.includes(full)) told = told.split(full).join(said);
  }
  return told;
}
