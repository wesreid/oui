import React, { useRef, useEffect, useMemo, useCallback, useState } from 'react';
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
  IntentResult,
} from '@ouispec/agent-core';

/**
 * Agent context passed to the render function of a defined entity.
 */
export interface AgentEntityRenderContext {
  ref: React.RefCallback<HTMLElement>;
  isTargeted: boolean;
  isExecuting: boolean;
  currentAction: AgentAction | null;
  execute: (intentId: string, params?: Record<string, unknown>, options?: EntityExecuteOptions) => Promise<IntentResult>;
  emit: (signal: string, data?: unknown) => void;
}

/**
 * Configuration for defining an agent entity component.
 */
export interface DefineAgentEntityConfig<P> {
  entityType: string | ((props: P) => string);
  entityId: (props: P) => string;
  intents: string[] | ((props: P) => string[]);
  displayContext: (props: P) => EntityDisplayContext;
  capabilities?: EntityCapabilities | ((props: P) => EntityCapabilities);
  onTargeted?: (props: P, action: AgentAction) => void;
  onReleased?: (props: P) => void;
  onExecuting?: (props: P, intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (props: P, intentId: string, result: IntentResult) => void;
  onCommandReceived?: (props: P, command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (props: P, observation: UserObservation) => void;
}

/**
 * defineAgentEntity — factory function that creates a React component with full
 * AgentEntity capabilities baked in.
 *
 * Example:
 * ```tsx
 * const CharacterCard = defineAgentEntity({
 *   entityType: 'Character',
 *   entityId: (props) => props.character.id,
 *   intents: ['generate-clip', 'clone-voice'],
 *   displayContext: (props) => ({ label: props.character.name, image: props.character.thumbnailUrl }),
 * }, (props, agent) => {
 *   return (
 *     <div ref={agent.ref} className={agent.isTargeted ? 'targeted' : ''}>
 *       <h3>{props.character.name}</h3>
 *       <button onClick={() => agent.execute('generate-clip', { character: props.character.id })}>
 *         Generate Clip
 *       </button>
 *     </div>
 *   );
 * });
 * ```
 */
export function defineAgentEntity<P extends Record<string, unknown>>(
  config: DefineAgentEntityConfig<P>,
  render: (props: P, agent: AgentEntityRenderContext) => React.ReactElement | null,
): React.FC<P> {
  const DefinedEntity: React.FC<P> = (props) => {
    const [, forceUpdate] = useState(0);
    const rerender = useCallback(() => forceUpdate(n => n + 1), []);

    const resolvedType = typeof config.entityType === 'function' ? config.entityType(props) : config.entityType;
    const resolvedId = config.entityId(props);
    const resolvedIntents = typeof config.intents === 'function' ? config.intents(props) : config.intents;
    const resolvedDisplay = config.displayContext(props);
    const resolvedCapabilities = typeof config.capabilities === 'function'
      ? config.capabilities(props)
      : (config.capabilities ?? {});

    const bridgeRef = useRef<FunctionalEntityBridge | null>(null);

    if (!bridgeRef.current) {
      bridgeRef.current = new FunctionalEntityBridge();
    }

    const bridge = bridgeRef.current;
    bridge._syncProps(resolvedType, resolvedId, resolvedIntents, resolvedDisplay, resolvedCapabilities);
    bridge._setCallbacks({
      onTargeted: config.onTargeted ? (action) => config.onTargeted!(props, action) : undefined,
      onReleased: config.onReleased ? () => config.onReleased!(props) : undefined,
      onExecuting: config.onExecuting ? (intentId, params) => config.onExecuting!(props, intentId, params) : undefined,
      onExecutionComplete: config.onExecutionComplete ? (intentId, result) => config.onExecutionComplete!(props, intentId, result) : undefined,
      onCommandReceived: config.onCommandReceived ? (cmd) => config.onCommandReceived!(props, cmd) : undefined,
      onObserve: config.onObserve ? (obs) => config.onObserve!(props, obs) : undefined,
    });
    bridge._setRerender(rerender);

    useEffect(() => {
      bridge.register();
      return () => bridge.unregister();
    }, []);

    useEffect(() => {
      const prevKey = `${bridge._prevType}::${bridge._prevId}`;
      const currKey = `${resolvedType}::${resolvedId}`;
      if (prevKey !== currKey) {
        bridge.unregister();
        bridge.register();
      }
      bridge._prevType = resolvedType;
      bridge._prevId = resolvedId;
    }, [resolvedType, resolvedId]);

    const refCallback = useCallback((element: HTMLElement | null) => {
      EntityRegistry.instance.updateElement(resolvedType, resolvedId, element);
    }, [resolvedType, resolvedId]);

    const agentContext: AgentEntityRenderContext = useMemo(() => ({
      ref: refCallback,
      isTargeted: bridge.isTargeted,
      isExecuting: bridge.isExecuting,
      currentAction: bridge.currentAction,
      execute: (intentId, params, options) => bridge.execute(intentId, params, options),
      emit: (signal, data) => bridge.emit(signal, data),
    }), [bridge.isTargeted, bridge.isExecuting, bridge.currentAction, refCallback]);

    return render(props, agentContext);
  };

  DefinedEntity.displayName = `AgentEntity(${typeof config.entityType === 'string' ? config.entityType : 'dynamic'})`;
  return DefinedEntity;
}

interface BridgeCallbacks {
  onTargeted?: (action: AgentAction) => void;
  onReleased?: () => void;
  onExecuting?: (intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (intentId: string, result: IntentResult) => void;
  onCommandReceived?: (command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (observation: UserObservation) => void;
}

class FunctionalEntityBridge extends AgentEntityBase {
  private _type = '';
  private _id = '';
  private _intents: string[] = [];
  private _display: EntityDisplayContext = { label: '' };
  private _caps: EntityCapabilities = {};
  private _callbacks: BridgeCallbacks = {};
  private _rerender: (() => void) | null = null;

  _prevType = '';
  _prevId = '';

  get entityType() { return this._type; }
  get entityId() { return this._id; }
  get intents() { return this._intents; }
  get displayContext() { return this._display; }
  get capabilities() { return this._caps; }

  _syncProps(type: string, id: string, intents: string[], display: EntityDisplayContext, caps: EntityCapabilities) {
    this._type = type;
    this._id = id;
    this._intents = intents;
    this._display = display;
    this._caps = caps;
  }

  _setCallbacks(callbacks: BridgeCallbacks) {
    this._callbacks = callbacks;
  }

  _setRerender(fn: () => void) {
    this._rerender = fn;
  }

  onTargeted(action: AgentAction) {
    this._callbacks.onTargeted?.(action);
    this._rerender?.();
  }

  onReleased() {
    this._callbacks.onReleased?.();
    this._rerender?.();
  }

  onExecuting(intentId: string, params: Record<string, unknown>) {
    this._callbacks.onExecuting?.(intentId, params);
    this._rerender?.();
  }

  onExecutionComplete(intentId: string, result: IntentResult) {
    this._callbacks.onExecutionComplete?.(intentId, result);
    this._rerender?.();
  }

  onCommandReceived(command: AgentCommand) {
    return this._callbacks.onCommandReceived?.(command);
  }

  onObserve(observation: UserObservation) {
    this._callbacks.onObserve?.(observation);
  }
}
