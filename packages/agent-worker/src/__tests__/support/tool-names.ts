/**
 * Test support: whether a text names a tool, as the SDK writes tool names.
 */

/**
 * Whether `text` names `tool`: the name as a word of its own. "look" is also
 * an English word, so it counts as the SDK writes the tool's name: in backticks.
 */
export function names(text: string, tool: string): boolean {
  if (tool === 'look') return text.includes('`look`');
  return new RegExp(`(^|[^A-Za-z0-9_])${tool}([^A-Za-z0-9_]|$)`).test(text);
}
