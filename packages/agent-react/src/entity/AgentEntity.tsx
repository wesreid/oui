import React, { useRef, useEffect, useCallback, useState } from 'react';
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
 * Props for the <AgentEntity> wrapper component.
 */
export interface AgentEntityProps {
  type: string;
  id: string;
  intents?: string[];
  displayContext: EntityDisplayContext;
  capabilities?: EntityCapabilities;
  onTargeted?: (action: AgentAction) => void;
  onReleased?: () => void;
  onExecuting?: (intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (intentId: string, result: IntentResult) => void;
  onCommandReceived?: (command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (observation: UserObservation) => void;
  children: React.ReactNode | ((context: AgentEntityChildContext) => React.ReactNode);
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Context passed to render-prop children of <AgentEntity>.
 */
export interface AgentEntityChildContext {
  isTargeted: boolean;
  isExecuting: boolean;
  currentAction: AgentAction | null;
  execute: (intentId: string, params?: Record<string, unknown>, options?: EntityExecuteOptions) => Promise<IntentResult>;
  emit: (signal: string, data?: unknown) => void;
}

/**
 * <AgentEntity> — wrapper component that grants agent capabilities to its children.
 *
 * Simplest integration pattern. Wrap any component to make it agent-addressable.
 *
 * Example:
 * ```tsx
 * <AgentEntity type="Character" id={char.id} displayContext={{ label: char.name }}>
 *   <CharacterCard character={char} />
 * </AgentEntity>
 *
 * // Or with render prop:
 * <AgentEntity type="Character" id={char.id} displayContext={{ label: char.name }}>
 *   {({ isTargeted, execute }) => (
 *     <div className={isTargeted ? 'highlighted' : ''}>
 *       <CharacterCard character={char} />
 *       <button onClick={() => execute('generate-clip', { character: char.id })}>
 *         Generate
 *       </button>
 *     </div>
 *   )}
 * </AgentEntity>
 * ```
 */
export function AgentEntity(props: AgentEntityProps): React.ReactElement {
  const {
    type,
    id,
    intents = [],
    displayContext,
    capabilities = {},
    onTargeted,
    onReleased,
    onExecuting,
    onExecutionComplete,
    onCommandReceived,
    onObserve,
    children,
    as: Tag = 'div',
    className,
    style,
  } = props;

  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);
  const elementRef = useRef<HTMLElement>(null);
  const bridgeRef = useRef<WrapperEntityBridge | null>(null);

  if (!bridgeRef.current) {
    bridgeRef.current = new WrapperEntityBridge();
  }

  const bridge = bridgeRef.current;
  bridge._sync(type, id, intents, displayContext, capabilities);
  bridge._setCallbacks({ onTargeted, onReleased, onExecuting, onExecutionComplete, onCommandReceived, onObserve });
  bridge._setRerender(rerender);

  useEffect(() => {
    bridge.register();
    return () => bridge.unregister();
  }, []);

  useEffect(() => {
    if (bridge._prevKey !== `${type}::${id}`) {
      bridge.unregister();
      bridge._sync(type, id, intents, displayContext, capabilities);
      bridge.register();
      bridge._prevKey = `${type}::${id}`;
    }
  }, [type, id]);

  const refCallback = useCallback((el: HTMLElement | null) => {
    (elementRef as React.MutableRefObject<HTMLElement | null>).current = el;
    EntityRegistry.instance.updateElement(type, id, el);
  }, [type, id]);

  const childContext: AgentEntityChildContext = {
    isTargeted: bridge.isTargeted,
    isExecuting: bridge.isExecuting,
    currentAction: bridge.currentAction,
    execute: (intentId, params, options) => bridge.execute(intentId, params, options),
    emit: (signal, data) => bridge.emit(signal, data),
  };

  const content = typeof children === 'function' ? children(childContext) : children;

  return React.createElement(
    Tag as string,
    { ref: refCallback, className, style, 'data-agent-entity': `${type}::${id}` },
    content,
  );
}

interface WrapperCallbacks {
  onTargeted?: (action: AgentAction) => void;
  onReleased?: () => void;
  onExecuting?: (intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (intentId: string, result: IntentResult) => void;
  onCommandReceived?: (command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (observation: UserObservation) => void;
}

class WrapperEntityBridge extends AgentEntityBase {
  private _type = '';
  private _id = '';
  private _intents: string[] = [];
  private _display: EntityDisplayContext = { label: '' };
  private _caps: EntityCapabilities = {};
  private _callbacks: WrapperCallbacks = {};
  private _rerender: (() => void) | null = null;
  _prevKey = '';

  get entityType() { return this._type; }
  get entityId() { return this._id; }
  get intents() { return this._intents; }
  get displayContext() { return this._display; }
  get capabilities() { return this._caps; }

  _sync(type: string, id: string, intents: string[], display: EntityDisplayContext, caps: EntityCapabilities) {
    this._type = type;
    this._id = id;
    this._intents = intents;
    this._display = display;
    this._caps = caps;
    this._prevKey = `${type}::${id}`;
  }

  _setCallbacks(callbacks: WrapperCallbacks) { this._callbacks = callbacks; }
  _setRerender(fn: () => void) { this._rerender = fn; }

  onTargeted(action: AgentAction) { this._callbacks.onTargeted?.(action); this._rerender?.(); }
  onReleased() { this._callbacks.onReleased?.(); this._rerender?.(); }
  onExecuting(intentId: string, params: Record<string, unknown>) { this._callbacks.onExecuting?.(intentId, params); this._rerender?.(); }
  onExecutionComplete(intentId: string, result: IntentResult) { this._callbacks.onExecutionComplete?.(intentId, result); this._rerender?.(); }
  onCommandReceived(command: AgentCommand) { return this._callbacks.onCommandReceived?.(command); }
  onObserve(observation: UserObservation) { this._callbacks.onObserve?.(observation); }
}
