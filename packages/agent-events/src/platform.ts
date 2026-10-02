/**
 * The platform's own events: what the agent worker emits to a turn's room,
 * turn events and UI action dispatches.
 * Declared like any product's, so the realtime server holds them to the same
 * rule: a declared name, a valid payload, a declared room.
 *
 * Every catalog a realtime server or client uses includes this document
 * beside the product's (`createEventCatalog(PLATFORM_EVENTS, productEvents)`).
 */
import { OUI_WIRE } from './oui-wire.js';
import { TURN_ROOM, type EventDeclarationDocument, type JsonSchema } from './types.js';

/**
 * The agent's turn events on the wire. A client parses all of them
 * (`parseSocketEvent` in agent-sdk-core); the worker emits the ones
 * `PLATFORM_EVENTS` declares.
 */
export const AGENT_TURN_EVENTS = {
  TURN_STARTED: 'agent:turn_started',
  TOKEN: 'agent:token',
  TOKEN_CLEAR: 'agent:token_clear',
  TOOL_CALL_STARTED: 'agent:tool_call_started',
  TOOL_CALL_COMPLETE: 'agent:tool_call_complete',
  TURN_COMPLETE: 'agent:turn_complete',
  TURN_ERROR: 'agent:turn_error',
  ERROR: 'agent:error',
  /** The turn stopped at a call that needs the user's approval (ADR-0228); the payload is agent-sdk-core's `ApprovalRequiredEvent`. */
  APPROVAL_REQUIRED: 'agent:approval_required',
} as const;

const turnId: JsonSchema = { type: 'string', minLength: 1, description: 'The turn the event belongs to.' };
const timestamp: JsonSchema = { type: 'number', description: 'When it happened, epoch ms.' };

const turnEvent = (description: string, properties: Record<string, JsonSchema>, required: string[]) => ({
  description,
  payload: {
    type: 'object',
    properties: { turnId, ...properties, timestamp },
    required: ['turnId', ...required, 'timestamp'],
  } satisfies JsonSchema,
  rooms: [TURN_ROOM],
  correlation: ['turnId'],
  role: 'notice' as const,
});

export const PLATFORM_EVENTS: EventDeclarationDocument = {
  version: 1,
  product: 'agent-sdk',
  description: "The agent worker's turn events and UI action dispatches, emitted to the room of the turn they belong to.",
  rooms: {},
  events: {
    [AGENT_TURN_EVENTS.TOKEN]: turnEvent(
      'Reply text as it streams: the next piece, not the whole reply.',
      { text: { type: 'string' } },
      ['text'],
    ),
    [AGENT_TURN_EVENTS.TOOL_CALL_STARTED]: turnEvent(
      'A tool call began.',
      {
        toolUseId: { type: 'string', description: 'The call id, which its completion repeats.' },
        name: { type: 'string', description: 'The tool.' },
        input: { type: 'object', description: 'The arguments.' },
      },
      ['toolUseId', 'name'],
    ),
    [AGENT_TURN_EVENTS.TOOL_CALL_COMPLETE]: turnEvent(
      'A tool call ended, with its result or error.',
      {
        toolUseId: { type: 'string' },
        name: { type: 'string' },
        result: { description: 'What the model was given.' },
        success: { type: 'boolean' },
        durationMs: { type: 'number' },
      },
      ['toolUseId', 'name', 'success'],
    ),
    [AGENT_TURN_EVENTS.TURN_COMPLETE]: turnEvent(
      'The turn finished. The last event of a turn: everything before it has been sent.',
      {
        rounds: { type: 'integer', description: 'Model calls the turn made.' },
        usage: { type: 'object', description: 'Token usage.' },
      },
      [],
    ),
    [AGENT_TURN_EVENTS.TURN_ERROR]: turnEvent(
      'The turn failed.',
      {
        error: {
          type: 'object',
          properties: { code: { type: 'string' }, message: { type: 'string' } },
          required: ['code', 'message'],
        },
      },
      ['error'],
    ),
    [AGENT_TURN_EVENTS.APPROVAL_REQUIRED]: turnEvent(
      "The turn stopped at a call that needs the user's approval (ADR-0228): the card the tab shows, and what the approval is bound to.",
      {
        conversationId: { type: 'string' },
        approvalId: { type: 'string', minLength: 1, description: 'Equals the tool call id.' },
        tool: { type: 'string' },
        effect: { type: 'string', description: "The action's declared effect kind, or `write`." },
        destructive: { type: 'boolean' },
        preview: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            consequence: { type: 'string' },
            arguments: { type: 'array', items: { type: 'object' } },
            readback: { type: 'string' },
          },
          required: ['title', 'arguments', 'readback'],
        },
        expiresAt: { type: 'number', description: 'Epoch ms.' },
      },
      ['conversationId', 'approvalId', 'tool', 'effect', 'destructive', 'preview', 'expiresAt'],
    ),
    [OUI_WIRE.dispatch]: {
      description: "A UI action request for the tab that sent the turn (ADR-0209). The tab answers on OUI's result event.",
      payload: {
        type: 'object',
        properties: {
          requestId: { type: 'string', minLength: 1 },
          surfaceId: { type: 'string', minLength: 1 },
          actionId: { type: 'string', minLength: 1 },
          params: { type: 'object' },
          timestamp: { type: 'number' },
        },
        required: ['requestId', 'surfaceId', 'actionId'],
      },
      rooms: [TURN_ROOM],
      correlation: ['requestId'],
      role: 'notice',
    },
  },
};
