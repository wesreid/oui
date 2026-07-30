import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { DefinedSurface, ActionHandlerResult, ActionPollingConfig } from '../core/index.js';
import type { OUIActionRequest, OUIObservationUpdate } from '../spec/index.js';

/**
 * Configuration for the useSurface hook.
 */
export interface UseSurfaceOptions<TContext> {
  /** The defined surface (from defineSurface()) */
  surface: DefinedSurface<TContext>;

  /** The context passed to action handlers (app state, utilities, etc.) */
  context: TContext;

  /** Transport send function — how to send protocol events to the agent runtime */
  send: (event: { type: string; payload: unknown }) => void;

  /** Whether the surface is currently active (respects activation conditions) */
  active?: boolean;
}

/**
 * useSurface — registers an OUI surface with the agent runtime and handles
 * incoming action requests by executing them locally and pushing observation
 * updates. Actions are dispatched one-way (no request/response correlation).
 *
 * After an action handler executes, if the action has a polling config, the
 * hook starts a polling loop that pushes observation updates until the
 * operation completes or times out.
 *
 * @example
 * ```tsx
 * function DataVizPage() {
 *   const { state, updateState, goToStep } = useDataVizWizard();
 *
 *   useSurface({
 *     surface: datavizSurface,
 *     context: { state, updateState, goToStep },
 *     send: agentTransport.send,
 *     active: true,
 *   });
 *
 *   return <DataVizWizard />;
 * }
 * ```
 */
export function useSurface<TContext>(options: UseSurfaceOptions<TContext>) {
  const { surface, context, send, active = true } = options;
  const contextRef = useRef(context);
  contextRef.current = context;

  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const sendRef = useRef(send);
  sendRef.current = send;

  // Track active polling intervals for cleanup
  const activePollers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Push an observation update to the agent runtime
  const pushObservation = useCallback((observationId: string, value: unknown) => {
    const update: OUIObservationUpdate = {
      surfaceId: surfaceRef.current.id,
      observationId,
      value,
      timestamp: Date.now(),
    };
    sendRef.current({ type: 'observation:update', payload: update });
  }, []);

  // Start the polling runtime for an async action
  const startPolling = useCallback((
    actionId: string,
    pollingConfig: ActionPollingConfig<TContext>,
    dispatchResult: unknown,
  ) => {
    const observationId = `${surfaceRef.current.id}:${actionId}:status`;
    let attempts = 0;
    const maxAttempts = pollingConfig.maxAttempts ?? Infinity;
    const startTime = Date.now();
    const maxDuration = pollingConfig.maxDurationMs ?? Infinity;

    // Subscribe mode — transport layer handles events, just push initial state
    if (pollingConfig.subscribe) {
      pushObservation(observationId, { status: 'dispatched', dispatchResult, interim: true });
      return;
    }

    // Polling mode — requires a resolve function
    if (!pollingConfig.resolve) {
      pushObservation(observationId, { status: 'dispatched', dispatchResult, interim: false });
      return;
    }

    // Push initial dispatched state
    pushObservation(observationId, { status: 'polling', dispatchResult, interim: true });

    const timer = setInterval(async () => {
      attempts++;
      const elapsed = Date.now() - startTime;

      if (attempts > maxAttempts || elapsed > maxDuration) {
        clearInterval(timer);
        activePollers.current.delete(actionId);
        pushObservation(observationId, { status: 'timeout', dispatchResult, interim: false });
        return;
      }

      try {
        const action = surfaceRef.current.actions.find(a => a.id === actionId);
        if (action?.polling?.resolve) {
          const result = await action.polling.resolve(dispatchResult, contextRef.current);
          pushObservation(observationId, { ...result.data as Record<string, unknown>, interim: !result.done });
          if (result.done) {
            clearInterval(timer);
            activePollers.current.delete(actionId);
          }
        }
      } catch (err) {
        // Don't stop polling on transient errors — push error state and continue
        pushObservation(observationId, { status: 'poll_error', error: String(err), interim: true });
      }
    }, pollingConfig.intervalMs);

    activePollers.current.set(actionId, timer);
  }, [pushObservation]);

  // Clear all active pollers
  const clearAllPollers = useCallback(() => {
    for (const [, timer] of activePollers.current) {
      clearInterval(timer);
    }
    activePollers.current.clear();
  }, []);

  // Register surface when it becomes active
  useEffect(() => {
    if (!active) {
      send({
        type: 'surface:deregister',
        payload: { surfaceId: surface.id, timestamp: Date.now() },
      });
      return;
    }

    send({
      type: 'surface:register',
      payload: {
        surface: surface.toManifest(),
        timestamp: Date.now(),
      },
    });

    return () => {
      // Clean up all active pollers on deregister
      clearAllPollers();
      send({
        type: 'surface:deregister',
        payload: { surfaceId: surface.id, timestamp: Date.now() },
      });
    };
  }, [surface.id, active, send, clearAllPollers]);

  // Clean up pollers on unmount (safety net)
  useEffect(() => {
    return () => {
      clearAllPollers();
    };
  }, [clearAllPollers]);

  // Handler for incoming action requests — fully async, no response correlation
  const handleActionRequest = useCallback(async (request: OUIActionRequest) => {
    if (request.surfaceId !== surfaceRef.current.id) return;

    const { actionId, params } = request;
    const observationId = `${surfaceRef.current.id}:${actionId}:status`;

    // Execute the handler locally
    let result: ActionHandlerResult;
    try {
      result = await surfaceRef.current.executeAction(actionId, params, contextRef.current);
    } catch (err) {
      // Execution failed — push error observation
      pushObservation(observationId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        interim: false,
      });
      return;
    }

    // Push observation with dispatch result immediately
    pushObservation(observationId, {
      status: result.success ? 'dispatched' : 'error',
      data: result.data,
      error: result.error,
      interim: !!result.success,
    });

    // If action has polling config and dispatch succeeded, start polling runtime
    if (result.success) {
      const action = surfaceRef.current.actions.find(a => a.id === actionId);
      if (action?.polling) {
        startPolling(actionId, action.polling, result.data ?? result.dispatchMeta);
      } else {
        // Non-async action — mark as complete (not interim)
        pushObservation(observationId, {
          status: 'complete',
          data: result.data,
          interim: false,
        });
      }
    }
  }, [pushObservation, startPolling]);

  // Expose the handler for the transport layer to call
  return useMemo(() => ({
    handleActionRequest,
    surfaceId: surface.id,
    manifest: surface.toManifest(),
    /** Manually stop polling for a specific action */
    stopPolling: (actionId: string) => {
      const timer = activePollers.current.get(actionId);
      if (timer) {
        clearInterval(timer);
        activePollers.current.delete(actionId);
      }
    },
    /** Stop all active pollers */
    stopAllPolling: clearAllPollers,
  }), [handleActionRequest, surface, clearAllPollers]);
}

/**
 * Helper to push an observation update to the agent runtime.
 */
export function useObservation(
  surfaceId: string,
  observationId: string,
  value: unknown,
  send: (event: { type: string; payload: unknown }) => void,
) {
  const prevValueRef = useRef<string>('');

  useEffect(() => {
    const serialized = JSON.stringify(value);
    if (serialized === prevValueRef.current) return;
    prevValueRef.current = serialized;

    const update: OUIObservationUpdate = {
      surfaceId,
      observationId,
      value,
      timestamp: Date.now(),
    };

    send({ type: 'observation:update', payload: update });
  }, [surfaceId, observationId, value, send]);
}
