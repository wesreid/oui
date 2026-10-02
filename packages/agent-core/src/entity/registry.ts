import type {
  EntityRegistration,
  EntityIdentity,
  EntitySignal,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
  EntityExecuteOptions,
  Unsubscribe,
} from './types.js';
import type { IntentResult, ViewAnnotationState } from '../types/api-surface.js';
import type { AgentEntityBase } from './base.js';
import type { AgentEntityProtocol } from './protocol.js';

type SignalHandler = (signal: EntitySignal) => void;
type EventHandler = (data: unknown) => void;
type RegistryListener = (event: RegistryEvent) => void;

export type RegistryEvent =
  | { type: 'entity_registered'; identity: EntityIdentity }
  | { type: 'entity_unregistered'; identity: EntityIdentity }
  | { type: 'entity_visible'; identity: EntityIdentity; visible: boolean }
  | { type: 'entity_targeted'; identity: EntityIdentity }
  | { type: 'entity_released'; identity: EntityIdentity }
  | { type: 'signal'; signal: EntitySignal };

interface EntityRecord {
  entity: AgentEntityBase | AgentEntityProtocol;
  registration: EntityRegistration;
}

interface IntentExecutor {
  execute(intentId: string, params: Record<string, unknown>, entityContext: EntityIdentity): Promise<IntentResult>;
}

/**
 * EntityRegistry — the singleton that tracks all active entity instances.
 *
 * Responsibilities:
 * - Maintains the set of registered entities and their lifecycle state
 * - Exposes visible entities to the orchestrator for context injection
 * - Routes agent commands/targeting to specific entity instances
 * - Batches and forwards entity signals (observe mode) to the orchestrator
 * - Provides the execution bridge for entity-initiated intents
 */
export class EntityRegistry {
  private static _instance: EntityRegistry | null = null;
  private entities = new Map<string, EntityRecord>();
  private listeners = new Set<RegistryListener>();
  private signalHandlers = new Set<SignalHandler>();
  private eventSubscriptions = new Map<string, Set<EventHandler>>();
  private intentExecutor: IntentExecutor | null = null;

  private signalBuffer: EntitySignal[] = [];
  private signalFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private signalDebounceMs = 500;

  static get instance(): EntityRegistry {
    if (!EntityRegistry._instance) {
      EntityRegistry._instance = new EntityRegistry();
    }
    return EntityRegistry._instance;
  }

  static reset(): void {
    EntityRegistry._instance = null;
  }

  private makeKey(type: string, id: string): string {
    return `${type}::${id}`;
  }

  // --- Registration ---

  registerEntity(entity: AgentEntityBase | AgentEntityProtocol): void {
    const key = this.makeKey(entity.entityType, entity.entityId);
    const registration: EntityRegistration = {
      identity: { type: entity.entityType, id: entity.entityId },
      intents: entity.intents,
      displayContext: entity.displayContext,
      capabilities: entity.capabilities ?? {},
      state: 'registered',
      visible: false,
      registeredAt: Date.now(),
    };

    this.entities.set(key, { entity, registration });
    this.notify({ type: 'entity_registered', identity: registration.identity });
  }

  unregisterEntity(type: string, id: string): void {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (record) {
      record.registration.state = 'unregistered';
      this.entities.delete(key);
      this.notify({ type: 'entity_unregistered', identity: { type, id } });
    }
  }

  // --- Visibility tracking ---

  updateVisibility(type: string, id: string, visible: boolean, rect?: DOMRect): void {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (!record) return;

    const changed = record.registration.visible !== visible;
    record.registration.visible = visible;
    record.registration.rect = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;

    if (visible && record.registration.state === 'registered') {
      record.registration.state = 'visible';
    } else if (!visible && record.registration.state === 'visible') {
      record.registration.state = 'registered';
    }

    if (changed) {
      this.notify({ type: 'entity_visible', identity: { type, id }, visible });
    }
  }

  updateElement(type: string, id: string, element: HTMLElement | null): void {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (record) {
      record.registration.element = element;
    }
  }

  // --- Querying ---

  getEntity(type: string, id: string): EntityRecord | undefined {
    return this.entities.get(this.makeKey(type, id));
  }

  getVisibleEntities(): EntityRegistration[] {
    return [...this.entities.values()]
      .filter(r => r.registration.visible)
      .map(r => r.registration);
  }

  getAllEntities(): EntityRegistration[] {
    return [...this.entities.values()].map(r => r.registration);
  }

  /**
   * Returns visible annotations in the format expected by the orchestrator/protocol.
   */
  getVisibleAnnotations(): ViewAnnotationState[] {
    return this.getVisibleEntities().map(reg => ({
      elementId: this.makeKey(reg.identity.type, reg.identity.id),
      entity: reg.identity,
      intents: reg.intents,
      displayContext: reg.displayContext,
      rect: reg.rect,
      visible: reg.visible,
    }));
  }

  findByType(type: string): EntityRecord[] {
    return [...this.entities.values()].filter(r => r.registration.identity.type === type);
  }

  findByContext(description: string): EntityRecord[] {
    const lower = description.toLowerCase();
    return [...this.entities.values()].filter(
      r => r.registration.visible && r.registration.displayContext.label.toLowerCase().includes(lower),
    );
  }

  // --- Agent → Entity (targeting, commands) ---

  targetEntity(type: string, id: string, action: AgentAction): boolean {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (!record) return false;

    record.registration.state = 'targeted';
    record.registration.lastAction = action;

    if ('_handleTargeted' in record.entity) {
      (record.entity as AgentEntityBase)._handleTargeted(action);
    } else if (record.entity.onTargeted) {
      record.entity.onTargeted(action);
    }

    this.notify({ type: 'entity_targeted', identity: { type, id } });
    return true;
  }

  releaseEntity(type: string, id: string): void {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (!record) return;

    record.registration.state = record.registration.visible ? 'visible' : 'registered';
    record.registration.lastAction = undefined;

    if ('_handleReleased' in record.entity) {
      (record.entity as AgentEntityBase)._handleReleased();
    } else if (record.entity.onReleased) {
      record.entity.onReleased();
    }

    this.notify({ type: 'entity_released', identity: { type, id } });
  }

  async sendCommand(type: string, id: string, command: AgentCommand): Promise<AgentCommandResponse | void> {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (!record) return { commandId: command.id, success: false, error: 'Entity not found' };

    if ('_handleCommand' in record.entity) {
      return (record.entity as AgentEntityBase)._handleCommand(command);
    } else if (record.entity.onCommandReceived) {
      return record.entity.onCommandReceived(command);
    }

    return { commandId: command.id, success: false, error: 'Entity does not handle commands' };
  }

  // --- Entity → Agent (intent execution) ---

  setIntentExecutor(executor: IntentExecutor): void {
    this.intentExecutor = executor;
  }

  async executeFromEntity(
    entity: AgentEntityBase | AgentEntityProtocol,
    intentId: string,
    params: Record<string, unknown>,
    _options?: EntityExecuteOptions,
  ): Promise<IntentResult> {
    if (!this.intentExecutor) {
      return { success: false, error: { code: 'NO_EXECUTOR', message: 'No intent executor configured' } };
    }

    const identity: EntityIdentity = { type: entity.entityType, id: entity.entityId };

    if ('_handleExecuting' in entity) {
      (entity as AgentEntityBase)._handleExecuting(intentId, params);
    } else if (entity.onExecuting) {
      entity.onExecuting(intentId, params);
    }

    const result = await this.intentExecutor.execute(intentId, params, identity);

    if ('_handleExecutionComplete' in entity) {
      (entity as AgentEntityBase)._handleExecutionComplete(intentId, result);
    } else if (entity.onExecutionComplete) {
      entity.onExecutionComplete(intentId, result);
    }

    return result;
  }

  // --- Entity signals (observe mode) ---

  emitSignal(signal: EntitySignal): void {
    this.signalBuffer.push(signal);
    this.scheduleSignalFlush();
  }

  onSignal(handler: SignalHandler): Unsubscribe {
    this.signalHandlers.add(handler);
    return () => this.signalHandlers.delete(handler);
  }

  private scheduleSignalFlush(): void {
    if (this.signalFlushTimer) return;
    this.signalFlushTimer = setTimeout(() => {
      this.flushSignals();
      this.signalFlushTimer = null;
    }, this.signalDebounceMs);
  }

  private flushSignals(): void {
    const signals = this.signalBuffer.splice(0);
    for (const signal of signals) {
      for (const handler of this.signalHandlers) {
        handler(signal);
      }
      this.notify({ type: 'signal', signal });
    }
  }

  setSignalDebounceMs(ms: number): void {
    this.signalDebounceMs = ms;
  }

  // --- Entity event subscriptions (observe mode) ---

  subscribeEntityEvent(type: string, id: string, event: string, handler: EventHandler): Unsubscribe {
    const key = `${type}::${id}::${event}`;
    if (!this.eventSubscriptions.has(key)) {
      this.eventSubscriptions.set(key, new Set());
    }
    this.eventSubscriptions.get(key)!.add(handler);
    return () => {
      const subs = this.eventSubscriptions.get(key);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) this.eventSubscriptions.delete(key);
      }
    };
  }

  emitEntityEvent(type: string, id: string, event: string, data: unknown): void {
    const key = `${type}::${id}::${event}`;
    const handlers = this.eventSubscriptions.get(key);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  // --- Observations (observe mode) ---

  observeEntity(type: string, id: string, observation: UserObservation): void {
    const key = this.makeKey(type, id);
    const record = this.entities.get(key);
    if (!record || !record.registration.capabilities.observe) return;

    if ('_handleObservation' in record.entity) {
      (record.entity as AgentEntityBase)._handleObservation(observation);
    } else if (record.entity.onObserve) {
      record.entity.onObserve(observation);
    }
  }

  // --- Registry listeners ---

  subscribe(listener: RegistryListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: RegistryEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // --- Utilities ---

  get size(): number {
    return this.entities.size;
  }

  clear(): void {
    this.entities.clear();
    this.signalBuffer = [];
    if (this.signalFlushTimer) {
      clearTimeout(this.signalFlushTimer);
      this.signalFlushTimer = null;
    }
  }
}
