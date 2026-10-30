/**
 * An action of the page called as if it were a tool.
 *
 * The model is given three UI tools, and runs a page's action by its id
 * through `ui_act`. It sometimes calls the action's id as a tool of its own
 * instead (`app_navigate` with `{ path }`): the provider refuses the unknown
 * tool, the model then calls `ui_act` with the same action, and the person
 * sees two attempts for one request (DEOS, 2026-10-30: "It navigated twice").
 *
 * Such a call is run as what it means, once: the SDK's tool-call repair turns
 * it into the `ui_act` call of that action with that input, before anything
 * runs, so it is validated, judged by policy, approved and dispatched exactly
 * as a `ui_act` call is, and the history records it as one. A name that is
 * not an action of the page as it is now is left to the SDK, which answers
 * the model that there is no such tool and which tools there are.
 */

/** A tool call as the provider returned it: its input is JSON text. */
export interface ProviderToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

/**
 * The `ui_act` call an action called as a tool stands for, or null when the
 * call is not one: a tool of the turn, a name that is not an action of the
 * page now, a turn with no `ui_act`, or an input that is not a JSON object.
 */
export function actionCallAsUiAct<T extends ProviderToolCall>(
  call: T,
  tools: Readonly<Record<string, unknown>>,
  isAction: (name: string) => boolean,
  uiActTool: string,
): T | null {
  if (Object.prototype.hasOwnProperty.call(tools, call.toolName)) return null;
  if (!Object.prototype.hasOwnProperty.call(tools, uiActTool) || !isAction(call.toolName)) return null;
  let input: unknown;
  try {
    input = call.input.trim() ? JSON.parse(call.input) : {};
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { ...call, toolName: uiActTool, input: JSON.stringify({ action: call.toolName, input }) };
}
