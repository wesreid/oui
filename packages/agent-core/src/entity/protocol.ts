import type {
  EntityCapabilities,
  EntityDisplayContext,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
  EntityExecuteOptions,
  Unsubscribe,
} from './types.js';
import type { IntentResult } from '../types/api-surface.js';

/**
 * AgentEntityProtocol — the interface contract for entities that participate
 * in the agent SDK. Use this when class inheritance isn't desired.
 *
 * Any object conforming to this protocol can be registered with the EntityRegistry.
 */
export interface AgentEntityProtocol {
  /** The schema entity type (e.g., 'Character', 'Voice', 'Clip') */
  readonly entityType: string;

  /** The unique identifier for this specific entity instance */
  readonly entityId: string;

  /** Intent IDs this entity supports — determines what the agent can do with it */
  readonly intents: string[];

  /** Human-readable display information for the agent's context window */
  readonly displayContext: EntityDisplayContext;

  /** Capability flags — defaults to hybrid mode */
  readonly capabilities?: EntityCapabilities;

  // --- HYBRID (always available) ---

  /** Called when the agent targets this entity */
  onTargeted?(action: AgentAction): void;

  /** Called when the agent releases targeting of this entity */
  onReleased?(): void;

  /** Called when an intent begins executing on this entity */
  onExecuting?(intentId: string, params: Record<string, unknown>): void;

  /** Called when an intent execution completes on this entity */
  onExecutionComplete?(intentId: string, result: IntentResult): void;

  /** Called when the agent sends a direct command to this entity */
  onCommandReceived?(command: AgentCommand): AgentCommandResponse | Promise<AgentCommandResponse> | void;

  // --- FULL BIDIRECTIONAL (only when capabilities.observe === true) ---

  /** Called with user interaction observations (observe mode) */
  onObserve?(observation: UserObservation): void;
}

/**
 * Extended protocol with SDK-provided capabilities.
 * This is what entities get when registered — the SDK injects these methods.
 */
export interface AgentEntityCapable extends AgentEntityProtocol {
  /** Execute an intent through the SDK orchestrator */
  execute(intentId: string, params?: Record<string, unknown>, options?: EntityExecuteOptions): Promise<IntentResult>;

  /** Emit a signal to the agent (only available when observe: true) */
  emit?(signal: string, data?: unknown): void;

  /** Subscribe to events from other entities or the agent */
  subscribe?(event: string, handler: (data: unknown) => void): Unsubscribe;
}
