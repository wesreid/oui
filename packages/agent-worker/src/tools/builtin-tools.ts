/**
 * Built-in SDK tools — interaction tools that every platform gets for free.
 * These are SDK-owned (contract §2) and generated, not hand-authored by the host.
 *
 * Interaction tools return `{ __present_options: true, ... }` which the client
 * SDK handles natively to present choices to the user.
 *
 * UI control tools (navigate_to, fill_form, submit_form, trigger_action,
 * show_toast, control_player, open_entity, highlight_entity) were removed per
 * ADR-0137 — they used the deprecated CustomEvent dispatch pattern that nothing
 * handles. Navigation and UI control is now exclusively handled by OUI surfaces
 * registered by the client app at runtime.
 */
import type { RegisteredTool } from './types.js';

/**
 * Generate the built-in interaction tools.
 * These are the same tools every platform needs — present options, confirm, request decision.
 */
export function loadBuiltinTools(): RegisteredTool[] {
  return loadInteractionTools();
}

function loadInteractionTools(): RegisteredTool[] {
  return [
    {
      name: 'present_options',
      description:
        'Present a set of options to the user as clickable choices. Use when the user needs to pick from a discrete set (e.g. which item to use, a style, a name). Returns the selected value.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Question or prompt for the user' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Option label' },
                value: { type: 'string', description: 'Option value (returned on selection)' },
                description: { type: 'string', description: 'Optional description' },
              },
              required: ['label', 'value'],
            },
          },
          style: { type: 'string', enum: ['buttons', 'list', 'cards'], description: 'Presentation style', default: 'buttons' },
          allowCustom: { type: 'boolean', description: 'Allow custom user input', default: false },
        },
        required: ['prompt', 'options'],
      },
      async execute(input) {
        return {
          __present_options: true,
          prompt: input.prompt,
          options: input.options,
          style: input.style ?? 'buttons',
          ...(input.allowCustom ? { allowCustom: input.allowCustom } : {}),
        } as unknown as ReturnType<RegisteredTool['execute']> extends Promise<infer R> ? R : never;
      },
    },
    {
      name: 'confirm_action',
      description:
        'Ask the user a quick yes-or-no before something significant that needs no approval ("Ready to generate?"). ' +
        'Never use it for a tool marked "Needs the user\'s approval": call that tool directly, and its approval card asks. ' +
        'An answer here never approves anything. Returns true (confirmed) or false (cancelled).',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What you are about to do' },
          details: { type: 'string', description: 'Additional context about the consequences' },
          confirmLabel: { type: 'string', description: 'Label for the confirm button', default: 'Confirm' },
          cancelLabel: { type: 'string', description: 'Label for the cancel button', default: 'Cancel' },
        },
        required: ['message'],
      },
      async execute(input) {
        return {
          __present_options: true,
          prompt: input.message,
          options: [
            { label: input.confirmLabel ?? 'Confirm', value: 'true' },
            { label: input.cancelLabel ?? 'Cancel', value: 'false' },
          ],
          style: 'buttons',
        } as unknown as ReturnType<RegisteredTool['execute']> extends Promise<infer R> ? R : never;
      },
    },
    {
      name: 'request_user_decision',
      description:
        'Request a decision from the user when the agent needs direction (e.g. which approach to take, whether to proceed). More open-ended than present_options.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          context: { type: 'string', description: 'Background context for the decision' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label', 'value'],
            },
            description: 'Optional choices; if omitted, the user gives free-form input',
          },
        },
        required: ['question'],
      },
      async execute(input) {
        return {
          __present_options: true,
          prompt: input.question,
          ...(input.context ? { context: input.context } : {}),
          ...(input.options ? { options: input.options } : { options: [{ label: 'Proceed', value: 'proceed' }] }),
          style: 'list',
          allowCustom: true,
        } as unknown as ReturnType<RegisteredTool['execute']> extends Promise<infer R> ? R : never;
      },
    },
  ];
}
