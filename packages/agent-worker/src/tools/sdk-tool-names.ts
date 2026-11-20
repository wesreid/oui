/**
 * The names of the SDK's own tools, in one place: the modules that build each
 * tool, and the prompt text that names it (prompt/step-tools.ts says it only
 * to a step that offers it), both take the name from here.
 *
 * The tools that work the page (`ui_act`, `ui_describe`, `ui_read`,
 * `ui_wait`) are the protocol's: `AGENT_UI_TOOLS` in `@ouispec/agent-core`.
 */

/** The choice built-in: offers the user choices as buttons, and ends the turn. */
export const PRESENT_OPTIONS_TOOL = 'present_options';

/** Looks at the caller through the call service (vision/look-tool.ts). */
export const LOOK_TOOL = 'look';

/** Starts a photo capture of one of the client's plans (capture/capture-tools.ts). */
export const CAPTURE_START_TOOL = 'capture_start';
/** Asks where the running capture stands. */
export const CAPTURE_STATUS_TOOL = 'capture_status';
/** Stops the running capture. */
export const CAPTURE_STOP_TOOL = 'capture_stop';

/** Moves the call to the caller's phone (handoff/handoff-tool.ts). */
export const CALL_HANDOFF_TOOL = 'call_handoff';

/** The attachment tools (attachments/tools.ts). */
export const ATTACHMENT_VIEW_TOOL = 'attachment_view';
export const ATTACHMENT_READ_TOOL = 'attachment_read';
export const ATTACHMENT_LIST_TOOL = 'attachment_list';

/** Reads what the prompt leaves out of the client's knowledge (ui/knowledge.ts). */
export const KNOWLEDGE_TOOL = 'ui_guide';
