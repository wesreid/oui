import { useRef, useCallback, useEffect, useState } from 'react';
import {
  AgentEntityBase,
  EntityRegistry,
} from '@ouispec/agent-core';
import { annotationRegistry } from '../annotations/singleton.js';
import type {
  EntityCapabilities,
  EntityDisplayContext,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
  EntityExecuteOptions,
  IntentResult,
  Unsubscribe,
} from '@ouispec/agent-core';

/**
 * Options for the useViewAnnotation hook.
 */
export interface UseViewAnnotationOptions {
  entity: { type: string; id: string };
  intents?: string[];
  displayContext: EntityDisplayContext;
  capabilities?: EntityCapabilities;
  metadata?: Record<string, unknown>;
  onTargeted?: (action: AgentAction) => void;
  onReleased?: () => void;
  onExecuting?: (intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (intentId: string, result: IntentResult) => void;
  onCommandReceived?: (command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (observation: UserObservation) => void;
}

/**
 * Return value of useViewAnnotation — provides the ref callback and agent entity state/methods.
 */
export interface UseViewAnnotationReturn {
  ref: (element: HTMLElement | null) => void;
  isTargeted: boolean;
  isExecuting: boolean;
  currentAction: AgentAction | null;
  execute: (intentId: string, params?: Record<string, unknown>, options?: EntityExecuteOptions) => Promise<IntentResult>;
  emit: (signal: string, data?: unknown) => void;
  subscribe: (event: string, handler: (data: unknown) => void) => Unsubscribe;
}

/**
 * useViewAnnotation — hook that registers a DOM element as an agent-addressable entity.
 *
 * This is the escape-hatch pattern for SVGs, portals, canvas overlays, or any case
 * where class inheritance or wrapper components don't fit.
 *
 * Now delegates to the core AgentEntityBase for full lifecycle management.
 *
 * Example:
 * ```tsx
 * function CharacterCard({ character }) {
 *   const agent = useViewAnnotation({
 *     entity: { type: 'Character', id: character.id },
 *     intents: ['generate-clip', 'clone-voice'],
 *     displayContext: { label: character.name, image: character.thumbnailUrl },
 *     onTargeted: () => setHighlighted(true),
 *     onReleased: () => setHighlighted(false),
 *   });
 *
 *   return (
 *     <div ref={agent.ref} className={agent.isTargeted ? 'targeted' : ''}>
 *       {character.name}
 *       <button onClick={() => agent.execute('generate-clip', { character: character.id })}>
 *         Generate
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useViewAnnotation(options: UseViewAnnotationOptions): UseViewAnnotationReturn {
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);
  const bridgeRef = useRef<HookEntityBridge | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  if (!bridgeRef.current) {
    bridgeRef.current = new HookEntityBridge();
  }

  const bridge = bridgeRef.current;
  bridge._sync(
    options.entity.type,
    options.entity.id,
    options.intents ?? [],
    options.displayContext,
    options.capabilities ?? {},
  );
  bridge._setCallbacks({
    onTargeted: options.onTargeted,
    onReleased: options.onReleased,
    onExecuting: options.onExecuting,
    onExecutionComplete: options.onExecutionComplete,
    onCommandReceived: options.onCommandReceived,
    onObserve: options.onObserve,
  });
  bridge._setRerender(rerender);

  useEffect(() => {
    bridge.register();
    return () => bridge.unregister();
  }, []);

  // Register with annotation registry so collectContext() includes metadata
  useEffect(() => {
    const annotationId = `annotation-${options.entity.type}-${options.entity.id}`;
    const unregister = annotationRegistry.register({
      id: annotationId,
      element: null,
      options: {
        entity: options.entity,
        intents: options.intents,
        displayContext: options.displayContext,
        metadata: options.metadata,
      },
      visible: true,
    });
    return () => unregister();
  }, [options.entity.type, options.entity.id, options.metadata]);

  useEffect(() => {
    const newKey = `${options.entity.type}::${options.entity.id}`;
    if (bridge._prevKey && bridge._prevKey !== newKey) {
      bridge.unregister();
      bridge._sync(
        options.entity.type,
        options.entity.id,
        options.intents ?? [],
        options.displayContext,
        options.capabilities ?? {},
      );
      bridge.register();
    }
    bridge._prevKey = newKey;
  }, [options.entity.type, options.entity.id]);

  const refCallback = useCallback((element: HTMLElement | null) => {
    EntityRegistry.instance.updateElement(
      optionsRef.current.entity.type,
      optionsRef.current.entity.id,
      element,
    );
  }, []);

  return {
    ref: refCallback,
    isTargeted: bridge.isTargeted,
    isExecuting: bridge.isExecuting,
    currentAction: bridge.currentAction,
    execute: (intentId, params, opts) => bridge.execute(intentId, params, opts),
    emit: (signal, data) => bridge.emit(signal, data),
    subscribe: (event, handler) => bridge.subscribe(event, handler),
  };
}

interface HookCallbacks {
  onTargeted?: (action: AgentAction) => void;
  onReleased?: () => void;
  onExecuting?: (intentId: string, params: Record<string, unknown>) => void;
  onExecutionComplete?: (intentId: string, result: IntentResult) => void;
  onCommandReceived?: (command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (observation: UserObservation) => void;
}

class HookEntityBridge extends AgentEntityBase {
  private _type = '';
  private _id = '';
  private _intents: string[] = [];
  private _display: EntityDisplayContext = { label: '' };
  private _caps: EntityCapabilities = {};
  private _callbacks: HookCallbacks = {};
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
  }

  _setCallbacks(callbacks: HookCallbacks) { this._callbacks = callbacks; }
  _setRerender(fn: () => void) { this._rerender = fn; }

  onTargeted(action: AgentAction) { this._callbacks.onTargeted?.(action); this._rerender?.(); }
  onReleased() { this._callbacks.onReleased?.(); this._rerender?.(); }
  onExecuting(intentId: string, params: Record<string, unknown>) { this._callbacks.onExecuting?.(intentId, params); this._rerender?.(); }
  onExecutionComplete(intentId: string, result: IntentResult) { this._callbacks.onExecutionComplete?.(intentId, result); this._rerender?.(); }
  onCommandReceived(command: AgentCommand) { return this._callbacks.onCommandReceived?.(command); }
  onObserve(observation: UserObservation) { this._callbacks.onObserve?.(observation); }
}
