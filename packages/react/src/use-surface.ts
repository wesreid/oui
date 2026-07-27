import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { DefinedSurface, ActionHandlerResult } from '@oui/core';
import type { OUIActionRequest, OUIActionResult, OUIObservationUpdate } from '@oui/spec';

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
 * incoming action requests by routing them to the surface's action handlers.
 *
 * This is the primary integration point for React applications. Call it once
 * per surface (typically at the page/feature level).
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
      send({
        type: 'surface:deregister',
        payload: { surfaceId: surface.id, timestamp: Date.now() },
      });
    };
  }, [surface.id, active, send]);

  // Handler for incoming action requests
  const handleActionRequest = useCallback(async (request: OUIActionRequest) => {
    if (request.surfaceId !== surfaceRef.current.id) return;

    const startTime = Date.now();
    const result = await surfaceRef.current.executeAction(
      request.actionId,
      request.params,
      contextRef.current,
    );

    const response: OUIActionResult = {
      requestId: request.requestId,
      success: result.success,
      data: result.data,
      error: result.error,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    };

    send({ type: 'action:result', payload: response });
  }, [send]);

  // Expose the handler for the transport layer to call
  return useMemo(() => ({
    handleActionRequest,
    surfaceId: surface.id,
    manifest: surface.toManifest(),
  }), [handleActionRequest, surface]);
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
