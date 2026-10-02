/**
 * Capability flags for an AgentEntity — layered model.
 * Hybrid (default): entity triggers intents through SDK + receives agent commands.
 * Full bidirectional (observe: true): entity can emit signals to the agent proactively.
 */
export interface EntityCapabilities {
  observe?: boolean;
}

export interface EntityDisplayContext {
  label: string;
  image?: string;
  badge?: string;
}

export interface EntityIdentity {
  type: string;
  id: string;
}

/**
 * Describes an action the agent is performing on this entity.
 */
export interface AgentAction {
  type: 'target' | 'execute' | 'highlight' | 'focus';
  intentId?: string;
  params?: Record<string, unknown>;
  source: 'orchestrator' | 'user' | 'workflow';
  timestamp: number;
}

/**
 * A command sent from the agent to a specific entity.
 */
export interface AgentCommand {
  id: string;
  action: string;
  params?: Record<string, unknown>;
  expectsResponse?: boolean;
  timeout?: number;
}

/**
 * Command response from entity back to agent.
 */
export interface AgentCommandResponse {
  commandId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * User observation signal — only available when `observe: true`.
 * Represents ambient user behavior the entity detects.
 */
export interface UserObservation {
  type: 'hover' | 'focus' | 'scroll_into_view' | 'click' | 'long_press' | 'drag_start';
  durationMs?: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Signal emitted by an entity to the agent (observe mode only).
 */
export interface EntitySignal {
  entityType: string;
  entityId: string;
  signal: string;
  data?: unknown;
  timestamp: number;
}

/**
 * Lifecycle state of a registered entity.
 */
export type EntityLifecycleState = 'registered' | 'visible' | 'targeted' | 'executing' | 'unregistered';

/**
 * Registration record maintained by the EntityRegistry.
 */
export interface EntityRegistration {
  identity: EntityIdentity;
  intents: string[];
  displayContext: EntityDisplayContext;
  capabilities: EntityCapabilities;
  state: EntityLifecycleState;
  element?: HTMLElement | null;
  rect?: { x: number; y: number; width: number; height: number };
  visible: boolean;
  lastAction?: AgentAction;
  registeredAt: number;
}

/**
 * Options for executing an intent from an entity.
 */
export interface EntityExecuteOptions {
  optimistic?: boolean;
  onProgress?: (progress: number) => void;
}

/**
 * Unsubscribe function returned by subscribe calls.
 */
export type Unsubscribe = () => void;
