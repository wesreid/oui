/**
 * The agent protocol — wire format types for the SDK's native protocol.
 * Richer than MCP; designed for deeply integrated hosts.
 */
import { AGENT_TURN_EVENTS } from '@ouispec/agent-events';
import type { ApprovalRequiredEvent } from '../approvals/types.js';
import { isTurnStopReason, type TurnStopReason } from '../turns/types.js';

/**
 * Canonical Socket.IO event names of an agent turn. Declared with their
 * payloads among the platform's events (`PLATFORM_EVENTS`,
 * @ouispec/agent-events); the SDK listens for these, with no
 * platform-side mapping.
 */
export const AGENT_SOCKET_EVENTS = AGENT_TURN_EVENTS;

export type AgentSocketEventName = (typeof AGENT_SOCKET_EVENTS)[keyof typeof AGENT_SOCKET_EVENTS];

export const ALL_AGENT_SOCKET_EVENTS: AgentSocketEventName[] = Object.values(AGENT_SOCKET_EVENTS);

/**
 * The tools an agent works a client's UI with (ADR-0245 §2.2): the model runs
 * one action of the page through `act`, and learns what actions take and
 * reads the page through the other two. A stored `act` call names the action
 * in its arguments (`{ action, input }`).
 */
export const AGENT_UI_TOOLS = { act: 'ui_act', describe: 'ui_describe', read: 'ui_read' } as const;

/**
 * A tool call as a person should see it: an `act` call is the action it ran,
 * with that action's input; any other call is itself.
 */
export function displayedToolCall(call: { name: string; arguments?: Record<string, unknown> }): {
  name: string;
  arguments?: Record<string, unknown>;
} {
  const action = call.arguments?.action;
  if (call.name !== AGENT_UI_TOOLS.act || typeof action !== 'string' || !action) return call;
  const input = call.arguments?.input;
  return { name: action, ...(input && typeof input === 'object' ? { arguments: input as Record<string, unknown> } : {}) };
}

export type AgentProtocolEvent =
  | TokenEvent
  | TokenClearEvent
  | IntentCallEvent
  | IntentResultEvent
  | UICommandEvent

  | ContextSyncEvent
  | LearningSignalEvent
  | SessionUpdateEvent
  | ErrorEvent
  | DoneEvent
  | ApprovalRequiredProtocolEvent;

export interface TokenEvent {
  type: 'token';
  content: string;
  turnId: string;
}

export interface TokenClearEvent {
  type: 'token_clear';
  turnId: string;
}

export interface IntentCallEvent {
  type: 'intent_call';
  id: string;
  intentId: string;
  parameters: Record<string, unknown>;
  turnId: string;
}

export interface IntentResultEvent {
  type: 'intent_result';
  callId: string;
  intentId: string;
  result: unknown;
  success: boolean;
  durationMs: number;
  turnId: string;
}

export interface UICommandEvent {
  type: 'ui_command';
  command: UICommand;
  turnId: string;
}

export type UICommand =
  | { action: 'navigate'; route: string; params?: Record<string, string> }
  | { action: 'annotate_focus'; entityType: string; entityId: string }
  | { action: 'annotate_highlight'; entityType: string; entityId: string; durationMs?: number }
  | { action: 'type_text'; target: string; value: string; animate?: boolean }
  | { action: 'click'; target: string }
  | { action: 'scroll_to'; target: string }
  | { action: 'select'; target: string; value: string }
  | { action: 'present_options'; options: PresentedOption[] }
  | { action: 'wait'; durationMs: number };

export interface PresentedOption {
  id: string;
  label: string;
  description?: string;
  image?: string;
  intent?: string;
  params?: Record<string, unknown>;
}

export interface ContextSyncEvent {
  type: 'context_sync';
  annotations: Array<{ entityType: string; entityId: string; visible: boolean }>;
  navigation: { route: string; params?: Record<string, string> };
  turnId: string;
}

export interface LearningSignalEvent {
  type: 'learning_signal';
  signal: 'positive' | 'negative' | 'neutral';
  source: 'explicit' | 'implicit' | 'outcome';
  detail?: string;
  turnId: string;
}

export interface SessionUpdateEvent {
  type: 'session_update';
  sessionId: string;
  update:
    | { kind: 'objective_status'; objectiveId: string; status: string; result?: unknown }
    | { kind: 'artifact_added'; artifact: { type: string; id: string; label: string } }
    | { kind: 'phase_change'; phase: string };
  turnId: string;
}

export interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
  turnId: string;
  recoverable: boolean;
}

/** The turn stopped at a call that needs the user's approval (ADR-0228): what the approval card renders. */
export interface ApprovalRequiredProtocolEvent extends Omit<ApprovalRequiredEvent, 'timestamp'> {
  type: 'approval_required';
}

export interface DoneEvent {
  type: 'done';
  turnId: string;
  messageId?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  maxRoundsReached?: boolean;
  /**
   * Set when the turn did not end by itself (ADR-0252): the person stopped it,
   * or a newer message superseded it. What it had produced is stored.
   */
  stopReason?: TurnStopReason;
}

/**
 * Maps a raw Socket.IO event (name + payload) to an AgentProtocolEvent.
 * This is the canonical mapping — platforms never need to write their own.
 */
export function parseSocketEvent(event: string, data: unknown, fallbackTurnId: string): AgentProtocolEvent | null {
  const payload = (data ?? {}) as Record<string, unknown>;
  const turnId = (payload.turnId as string) ?? fallbackTurnId;

  switch (event) {
    case AGENT_SOCKET_EVENTS.TURN_STARTED:
      // Turn started is informational — don't create an empty token.
      return null;

    case AGENT_SOCKET_EVENTS.TOKEN:
      return {
        type: 'token',
        content: (payload.text as string) ?? (payload.token as string) ?? (payload.content as string) ?? '',
        turnId,
      };

    case AGENT_SOCKET_EVENTS.TOKEN_CLEAR:
      return {
        type: 'token_clear',
        turnId,
      };

    case AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED:
      return {
        type: 'intent_call',
        id: (payload.callId as string) ?? (payload.toolUseId as string) ?? crypto.randomUUID(),
        intentId: (payload.toolName as string) ?? (payload.name as string) ?? 'unknown',
        // The worker sends the call's arguments as `input`.
        parameters:
          (payload.input as Record<string, unknown>) ??
          (payload.parameters as Record<string, unknown>) ??
          (payload.args as Record<string, unknown>) ??
          {},
        turnId,
      };

    case AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE:
      return {
        type: 'intent_result',
        callId: (payload.callId as string) ?? (payload.toolUseId as string) ?? '',
        intentId: (payload.toolName as string) ?? (payload.name as string) ?? 'unknown',
        result: payload.result ?? payload.output ?? null,
        success: (payload.success as boolean) ?? !(payload.error),
        durationMs: (payload.durationMs as number) ?? 0,
        turnId,
      };

    case AGENT_SOCKET_EVENTS.TURN_COMPLETE:
      return {
        type: 'done',
        turnId,
        messageId: payload.messageId as string | undefined,
        usage: payload.usage as { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
        ...(isTurnStopReason(payload.stopReason) ? { stopReason: payload.stopReason } : {}),
      };

    case AGENT_SOCKET_EVENTS.TURN_ERROR: {
      const errObj = (payload.error ?? payload) as Record<string, unknown>;
      return {
        type: 'error',
        code: (errObj.code as string) ?? 'TURN_ERROR',
        message: (errObj.message as string) ?? 'The agent turn failed',
        turnId,
        recoverable: (errObj.recoverable as boolean) ?? false,
      };
    }

    case AGENT_SOCKET_EVENTS.ERROR: {
      const errorObj = payload.error as Record<string, unknown> | string | undefined;
      const errorMessage = (payload.message as string)
        ?? (typeof errorObj === 'string' ? errorObj : (errorObj as Record<string, unknown>)?.message as string | undefined)
        ?? 'An error occurred';
      return {
        type: 'error',
        code: (payload.code as string) ?? (typeof errorObj === 'object' ? (errorObj as Record<string, unknown>)?.code as string : undefined) ?? 'AGENT_ERROR',
        message: errorMessage,
        turnId,
        recoverable: (payload.recoverable as boolean) ?? (typeof errorObj === 'object' ? (errorObj as Record<string, unknown>)?.recoverable as boolean : false) ?? false,
      };
    }



    case AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED: {
      const event = payload as Partial<ApprovalRequiredEvent>;
      return {
        type: 'approval_required',
        turnId,
        conversationId: event.conversationId ?? '',
        approvalId: event.approvalId ?? '',
        tool: event.tool ?? '',
        effect: event.effect ?? 'write',
        destructive: event.destructive ?? false,
        preview: event.preview ?? { title: event.tool ?? '', arguments: [], readback: '' },
        expiresAt: event.expiresAt ?? 0,
      };
    }

    default:
      return null;
  }
}
