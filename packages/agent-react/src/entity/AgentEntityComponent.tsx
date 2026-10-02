import React from 'react';
import {
  AgentEntityBase,
  EntityRegistry,
} from '@ouispec/agent-core';
import type {
  EntityCapabilities,
  EntityDisplayContext,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
  EntityExecuteOptions,
  Unsubscribe,
} from '@ouispec/agent-core';
import type { IntentResult } from '@ouispec/agent-core';

/**
 * AgentEntityComponent — class-based React component that extends the core AgentEntityBase.
 *
 * This is the primary integration pattern for complex, stateful entity components.
 * Subclass this and implement the abstract getters for your entity.
 *
 * Example:
 * ```tsx
 * class CharacterCard extends AgentEntityComponent<{ character: Character }> {
 *   get entityType() { return 'Character'; }
 *   get entityId() { return this.props.character.id; }
 *   get intents() { return ['generate-clip', 'clone-voice']; }
 *   get displayContext() {
 *     return { label: this.props.character.name, image: this.props.character.thumbnailUrl };
 *   }
 *
 *   onTargeted(action) {
 *     this.setState({ highlighted: true });
 *   }
 *
 *   onReleased() {
 *     this.setState({ highlighted: false });
 *   }
 *
 *   render() {
 *     return <div ref={this.entityRef}>...</div>;
 *   }
 * }
 * ```
 */
export abstract class AgentEntityComponent<
  P = Record<string, never>,
  S = Record<string, never>,
> extends React.Component<P, S> {
  private _entityBridge: EntityBridge<P, S>;
  private _entityRef = React.createRef<HTMLElement>();

  abstract get entityType(): string;
  abstract get entityId(): string;
  abstract get intents(): string[];
  abstract get displayContext(): EntityDisplayContext;

  get capabilities(): EntityCapabilities {
    return {};
  }

  constructor(props: P) {
    super(props);
    this._entityBridge = new EntityBridge(this);
  }

  /**
   * Ref to attach to the root DOM element.
   * The registry uses this for visibility tracking (IntersectionObserver).
   */
  get entityRef(): React.RefObject<HTMLElement | null> {
    return this._entityRef;
  }

  get isTargeted(): boolean {
    return this._entityBridge.isTargeted;
  }

  get isExecuting(): boolean {
    return this._entityBridge.isExecuting;
  }

  /**
   * Execute an intent through the SDK orchestrator.
   */
  async execute(
    intentId: string,
    params?: Record<string, unknown>,
    options?: EntityExecuteOptions,
  ): Promise<IntentResult> {
    return this._entityBridge.execute(intentId, params, options);
  }

  /**
   * Emit a signal to the agent (only when capabilities.observe is true).
   */
  emit(signal: string, data?: unknown): void {
    this._entityBridge.emit(signal, data);
  }

  /**
   * Subscribe to events (only when capabilities.observe is true).
   */
  subscribe(event: string, handler: (data: unknown) => void): Unsubscribe {
    return this._entityBridge.subscribe(event, handler);
  }

  // --- Lifecycle hooks (override in subclasses) ---
  onTargeted?(action: AgentAction): void;
  onReleased?(): void;
  onExecuting?(intentId: string, params: Record<string, unknown>): void;
  onExecutionComplete?(intentId: string, result: IntentResult): void;
  onCommandReceived?(command: AgentCommand): AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?(observation: UserObservation): void;

  // --- React lifecycle ---

  componentDidMount(): void {
    this._entityBridge.syncProperties();
    this._entityBridge.register();
    this._setupDomObservation();
  }

  componentDidUpdate(_prevProps: P): void {
    this._entityBridge.syncProperties();
  }

  componentWillUnmount(): void {
    this._entityBridge.unregister();
  }

  private _setupDomObservation(): void {
    const el = this._entityRef.current;
    if (el) {
      EntityRegistry.instance.updateElement(this.entityType, this.entityId, el);
    }
  }
}

/**
 * Internal bridge between the React component and AgentEntityBase.
 * Extends AgentEntityBase and delegates lifecycle hooks to the React component.
 */
class EntityBridge<P, S> extends AgentEntityBase {
  private component: AgentEntityComponent<P, S>;

  constructor(component: AgentEntityComponent<P, S>) {
    super();
    this.component = component;
  }

  get entityType(): string { return this.component.entityType; }
  get entityId(): string { return this.component.entityId; }
  get intents(): string[] { return this.component.intents; }
  get displayContext(): EntityDisplayContext { return this.component.displayContext; }
  get capabilities(): EntityCapabilities { return this.component.capabilities; }

  syncProperties(): void {
    // Properties are read dynamically from the component — no sync needed
  }

  onTargeted(action: AgentAction): void {
    this.component.onTargeted?.(action);
    this.component.forceUpdate();
  }

  onReleased(): void {
    this.component.onReleased?.();
    this.component.forceUpdate();
  }

  onExecuting(intentId: string, params: Record<string, unknown>): void {
    this.component.onExecuting?.(intentId, params);
    this.component.forceUpdate();
  }

  onExecutionComplete(intentId: string, result: IntentResult): void {
    this.component.onExecutionComplete?.(intentId, result);
    this.component.forceUpdate();
  }

  onCommandReceived(command: AgentCommand): AgentCommandResponse | Promise<AgentCommandResponse> | void {
    return this.component.onCommandReceived?.(command);
  }

  onObserve(observation: UserObservation): void {
    this.component.onObserve?.(observation);
  }
}
