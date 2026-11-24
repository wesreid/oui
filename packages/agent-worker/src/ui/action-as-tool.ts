/**
 * An action of the page called as if it were a tool.
 *
 * The model is given four UI tools, and runs a page's action by its id
 * through `ui_act`. It sometimes calls the action's id as a tool of its own
 * instead (`app_navigate` with `{ path }`): the provider refuses the unknown
 * tool, the model then calls `ui_act` with the same action, and the person
 * sees two attempts for one request (DEOS, 2026-10-30: "It navigated twice").
 *
 * Such a call is run as what it means, once: the SDK's tool-call repair turns
 * it into the `ui_act` call of that action with that input, before anything
 * runs, so it is validated, judged by policy, approved and dispatched exactly
 * as a `ui_act` call is, and the history records it as one. The name is read
 * as `ui_act` reads one (`resolveActionName`): an action's id, or the name its
 * index line starts with, which the call names by its full id. A name that
 * stands for actions on several surfaces goes to `ui_act` as given, which
 * refuses it with their full ids. A name that is not an action of the page as
 * it is now is left to the SDK, which answers the model that there is no such
 * tool and which tools there are.
 */
import type { ActionNameResolution } from './page-index.js';


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
  resolve: (name: string) => ActionNameResolution,
  uiActTool: string,
): T | null {
  if (Object.prototype.hasOwnProperty.call(tools, call.toolName)) return null;
  if (!Object.prototype.hasOwnProperty.call(tools, uiActTool)) return null;
  const meant = resolve(call.toolName);
  if (!meant) return null;
  let input: unknown;
  try {
    input = call.input.trim() ? JSON.parse(call.input) : {};
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { ...call, toolName: uiActTool, input: JSON.stringify({ action: 'id' in meant ? meant.id : call.toolName, input }) };
}
