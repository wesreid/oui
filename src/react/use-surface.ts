import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  DefinedSurface,
  SurfaceRuntime,
  MountedSurface,
} from "../core/index.js";
import type { OUIActionResult } from "../spec/index.js";

// ─── Runtime context ─────────────────────────────────────────────────────────

const SurfaceRuntimeContext = createContext<SurfaceRuntime | null>(null);

export interface SurfaceRuntimeProviderProps {
  runtime: SurfaceRuntime;
  children?: ReactNode;
}

/** Makes one surface runtime available to every `useSurface` below it. */
export function SurfaceRuntimeProvider({
  runtime,
  children,
}: SurfaceRuntimeProviderProps) {
  return createElement(
    SurfaceRuntimeContext.Provider,
    { value: runtime },
    children,
  );
}

/** The surface runtime from the nearest `SurfaceRuntimeProvider`. */
export function useSurfaceRuntime(): SurfaceRuntime {
  const runtime = useContext(SurfaceRuntimeContext);
  if (!runtime) {
    throw new Error(
      "[OUI] useSurface needs a SurfaceRuntimeProvider above it. Create one runtime per client with " +
        "createSurfaceRuntime() and provide it at the root.",
    );
  }
  return runtime;
}

// ─── useSurface ──────────────────────────────────────────────────────────────

export interface UseSurfaceOptions<TContext> {
  /** The defined surface (from defineSurface()) */
  surface: DefinedSurface<TContext>;

  /** Passed to action handlers. Read when an action runs, so it is always current. */
  context: TContext;

  /** Mount the surface only while true. Default true. */
  active?: boolean;
}

export interface UseSurfaceResult {
  surfaceId: string;
  /** Record an observation value on this surface. Unchanged values are ignored. */
  pushObservation(observationId: string, value: unknown): void;
  /** Run one of this surface's actions locally, exactly as a dispatched request would. */
  execute(
    actionId: string,
    params?: Record<string, unknown>,
  ): Promise<OUIActionResult>;
}

let localRequestSeq = 0;

/**
 * Mount a surface into the client's surface runtime for as long as the
 * component is mounted (and `active`). The runtime answers dispatched requests
 * for it, so the component needs no listener of its own.
 */
export function useSurface<TContext>(
  options: UseSurfaceOptions<TContext>,
): UseSurfaceResult {
  const { surface, context, active = true } = options;
  const runtime = useSurfaceRuntime();

  const contextRef = useRef(context);
  contextRef.current = context;

  const mountedRef = useRef<MountedSurface | null>(null);
  // Observations pushed before the mount effect ran (effects declared earlier
  // in the same component run first) are kept and delivered on mount rather
  // than lost.
  const pendingRef = useRef(new Map<string, unknown>());

  useEffect(() => {
    if (!active) return;
    const mounted = runtime.mount(surface, () => contextRef.current);
    mountedRef.current = mounted;
    for (const [observationId, value] of pendingRef.current) {
      mounted.pushObservation(observationId, value);
    }
    pendingRef.current.clear();
    return () => {
      mounted.unmount();
      if (mountedRef.current === mounted) mountedRef.current = null;
    };
  }, [runtime, surface, active]);

  const pushObservation = useCallback(
    (observationId: string, value: unknown) => {
      const mounted = mountedRef.current;
      if (mounted) mounted.pushObservation(observationId, value);
      else pendingRef.current.set(observationId, value);
    },
    [],
  );

  const execute = useCallback(
    (actionId: string, params: Record<string, unknown> = {}) =>
      runtime.execute({
        requestId: `local_${Date.now()}_${++localRequestSeq}`,
        surfaceId: surface.id,
        actionId,
        params,
        timestamp: Date.now(),
      }),
    [runtime, surface.id],
  );

  return useMemo(
    () => ({ surfaceId: surface.id, pushObservation, execute }),
    [surface.id, pushObservation, execute],
  );
}

// ─── useObservation ──────────────────────────────────────────────────────────

/** Keep an observation on a mounted surface equal to `value`. */
export function useObservation(
  surface: Pick<UseSurfaceResult, "pushObservation">,
  observationId: string,
  value: unknown,
): void {
  const { pushObservation } = surface;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "undefined";
  } catch {
    serialized = String(value);
  }
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    pushObservation(observationId, valueRef.current);
  }, [pushObservation, observationId, serialized]);
}

// ─── useSurfaceHold ──────────────────────────────────────────────────────────

/**
 * Keep the UI unsettled while `busy` is true: an action's result waits for it.
 * For work mounting cannot show, such as a route's code or a page's data still
 * loading.
 */
export function useSurfaceHold(busy: boolean): void {
  const runtime = useSurfaceRuntime();
  useEffect(() => {
    if (!busy) return;
    return runtime.hold();
  }, [runtime, busy]);
}
