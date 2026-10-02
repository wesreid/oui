import type {
  EntityCapabilities,
  EntityDisplayContext,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
  EntityExecuteOptions,
  EntitySignal,
  Unsubscribe,
} from './types.js';
import type { IntentResult } from '../types/api-surface.js';
import type { AgentEntityProtocol } from './protocol.js';
import { EntityRegistry } from './registry.js';

/**
 * AgentEntityBase — the universal base class for entities in the agent SDK.
 *
 * This class is framework-agnostic. React, Vue, Svelte, and vanilla JS integrations
 * all delegate to this base. It provides:
 *
 * HYBRID (default):
 *   - execute() — trigger intents through the SDK orchestrator
 *   - onTargeted() / onReleased() — receive targeting from agent
 *   - onCommandReceived() — receive direct commands from agent
 *   - onExecutionComplete() — callback after intent execution
 *
 * FULL BIDIRECTIONAL (opt-in via capabilities.observe = true):
 *   - emit() — proactively signal the agent
 *   - subscribe() — listen to other entities or agent events
 *   - onObserve() — receive ambient user interaction observations
 */
export abstract class AgentEntityBase implements AgentEntityProtocol {
  abstract readonly entityType: string;
  abstract readonly entityId: string;
  abstract readonly intents: string[];
  abstract readonly displayContext: EntityDisplayContext;

  get capabilities(): EntityCapabilities { return {}; }

  // --- Internal state ---
  private _isTargeted = false;
  private _isExecuting = false;
  private _currentAction: AgentAction | null = null;
  private _subscriptions: Array<Unsubscribe> = [];
  private _registry: EntityRegistry | null = null;

  get isTargeted(): boolean {
    return this._isTargeted;
  }

  get isExecuting(): boolean {
    return this._isExecuting;
  }

  get currentAction(): AgentAction | null {
    return this._currentAction;
  }

  // --- Registration lifecycle ---

  /**
   * Register this entity with the given registry.
   * Called automatically by framework bindings (React hooks, etc.).
   */
  register(registry?: EntityRegistry): void {
    this._registry = registry ?? EntityRegistry.instance;
    this._registry.registerEntity(this);
  }

  /**
   * Unregister this entity from its registry.
   * Called automatically on unmount/destroy by framework bindings.
   */
  unregister(): void {
    this._cleanupSubscriptions();
    if (this._registry) {
      this._registry.unregisterEntity(this.entityType, this.entityId);
      this._registry = null;
    }
  }

  // --- HYBRID: Always available ---

  /**
   * Execute an intent through the SDK. This goes through the orchestrator/service registry,
   * ensuring trajectory capture, precondition checks, and learning signals.
   */
  async execute(
    intentId: string,
    params?: Record<string, unknown>,
    options?: EntityExecuteOptions,
  ): Promise<IntentResult> {
    if (!this._registry) {
      return { success: false, error: { code: 'NOT_REGISTERED', message: 'Entity is not registered with a registry' } };
    }
    return this._registry.executeFromEntity(this, intentId, params ?? {}, options);
  }

  /** @internal Called by the registry/orchestrator when this entity is targeted */
  _handleTargeted(action: AgentAction): void {
    this._isTargeted = true;
    this._currentAction = action;
    this.onTargeted?.(action);
  }

  /** @internal Called by the registry/orchestrator when targeting is released */
  _handleReleased(): void {
    this._isTargeted = false;
    this._currentAction = null;
    this.onReleased?.();
  }

  /** @internal Called by the registry/orchestrator when an intent starts executing */
  _handleExecuting(intentId: string, params: Record<string, unknown>): void {
    this._isExecuting = true;
    this.onExecuting?.(intentId, params);
  }

  /** @internal Called by the registry/orchestrator when execution completes */
  _handleExecutionComplete(intentId: string, result: IntentResult): void {
    this._isExecuting = false;
    this.onExecutionComplete?.(intentId, result);
  }

  /** @internal Called by the registry/orchestrator with a direct command */
  _handleCommand(command: AgentCommand): AgentCommandResponse | Promise<AgentCommandResponse> | void {
    return this.onCommandReceived?.(command);
  }

  // --- Lifecycle hooks (override in subclasses) ---

  onTargeted?(action: AgentAction): void;
  onReleased?(): void;
  onExecuting?(intentId: string, params: Record<string, unknown>): void;
  onExecutionComplete?(intentId: string, result: IntentResult): void;
  onCommandReceived?(command: AgentCommand): AgentCommandResponse | Promise<AgentCommandResponse> | void;

  // --- FULL BIDIRECTIONAL: Only when capabilities.observe === true ---

  /**
   * Emit a signal to the agent. Only available when capabilities.observe is true.
   * Signals are batched and debounced by the registry before reaching the orchestrator.
   */
  emit(signal: string, data?: unknown): void {
    if (!this.capabilities.observe) {
      if (typeof console !== 'undefined') {
        console.warn(`[AgentEntity] emit() called on ${this.entityType}:${this.entityId} but observe capability is not enabled`);
      }
      return;
    }
    if (!this._registry) return;

    const entitySignal: EntitySignal = {
      entityType: this.entityType,
      entityId: this.entityId,
      signal,
      data,
      timestamp: Date.now(),
    };
    this._registry.emitSignal(entitySignal);
  }

  /**
   * Subscribe to events from the registry/agent. Only available when capabilities.observe is true.
   * Returns an unsubscribe function.
   */
  subscribe(event: string, handler: (data: unknown) => void): Unsubscribe {
    if (!this.capabilities.observe) {
      if (typeof console !== 'undefined') {
        console.warn(`[AgentEntity] subscribe() called on ${this.entityType}:${this.entityId} but observe capability is not enabled`);
      }
      return () => {};
    }
    if (!this._registry) return () => {};

    const unsub = this._registry.subscribeEntityEvent(this.entityType, this.entityId, event, handler);
    this._subscriptions.push(unsub);
    return unsub;
  }

  /** @internal Called by the registry when a user observation is detected */
  _handleObservation(observation: UserObservation): void {
    if (!this.capabilities.observe) return;
    this.onObserve?.(observation);
  }

  onObserve?(observation: UserObservation): void;

  // --- Cleanup ---

  private _cleanupSubscriptions(): void {
    for (const unsub of this._subscriptions) {
      unsub();
    }
    this._subscriptions = [];
  }
}
