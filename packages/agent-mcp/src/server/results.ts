/** A tool's outcome, as every tool server reports it. */
export interface ToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** An MCP tool result made of text, as every tool server here returns. */
export type TextToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * An MCP tool result from a tool's outcome: its data as JSON on success; on failure
 * `Error: <message>`, followed by any data the failure carries (a refused call's
 * status and body). `bare` reports the message as it is, for refusals the server
 * itself makes.
 */
export function toCallToolResult(outcome: ToolOutcome, options: { bare?: boolean } = {}): TextToolResult {
  if (outcome.success) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(outcome.data ?? null, null, 2) }] };
  }
  const message = outcome.error ?? 'Unknown error';
  const lines = [options.bare ? message : `Error: ${message}`];
  if (outcome.data !== undefined) lines.push(JSON.stringify(outcome.data, null, 2));
  return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: true };
}
