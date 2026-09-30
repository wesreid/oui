/**
 * The client-side surface runtime.
 *
 * Holds the surfaces a client has mounted, answers every action request with a
 * result, and produces the snapshot an agent runtime works from.
 *
 * WHY THIS EXISTS
 *
 * The first integration kept no client-side record of what was mounted. Each
 * surface hook registered itself with a server-side registry and listened for
 * dispatches on its own. Three things followed:
 *
 * - The registry was the only record of what the client could do, and it lost
 *   entries: a dead socket's cleanup removed a live tab's registration, and the
 *   browser never registered again. The agent then had no UI tools at all.
 * - Nothing answered a dispatch. The agent was told an action succeeded before
 *   the client had run it, and never saw the page an action led to.
 * - Every hook listened independently, through two paths, so one dispatch ran
 *   twice and nothing de-duplicated it.
 *
 * Here the client is the record. `snapshot()` is what the client can do right
 * now, and every request is run once, waited on until the UI settles, and
 * answered with its result and the snapshot after it.
 */
import type {
  OUIActionRequest,
  OUIActionResult,
  OUISurface,
  OUISurfaceSnapshot,
  OUIObservationSnapshot,
} from "../spec/index.js";
import type { OUITransport, OUITransportConfig } from "../transport/types.js";
import {
  createWebSocketTransport,
  type SocketLike,
} from "../transport/websocket.js";
import type {
  ActionHandlerResult,
  ActionPollingConfig,
  DefinedSurface,
} from "./define-surface.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SettleOptions {
  /**
   * The UI counts as settled once nothing has mounted, unmounted or changed an
   * observation for this long, and no hold is open. Default 250 ms.
   */
  quietMs?: number;
  /** Give up waiting after this long and answer with `settled: false`. Default 5000 ms. */
  timeoutMs?: number;
}

export interface SurfaceRuntimeOptions {
  /** The socket to answer requests on. Can be set or replaced later with `attach`. */
  socket?: SocketLike | null;

  /** Wire configuration for the transport the runtime builds on the socket. */
  transport?: OUITransportConfig;

  /**
   * Also announce registrations and observations over the transport, for agent
   * runtimes that keep a server-side registry. Default true.
   *
   * An agent runtime that takes the client's snapshot instead (sent with each
   * turn, and returned on every result) has no use for them: set false.
   */
  announce?: boolean;

  settle?: SettleOptions;

  /** How many answered request ids to remember, for de-duplication. Default 500. */
  dedupeWindow?: number;

  /**
   * Decides whether a request that arrived on the socket may run at all. A
   * refused request is neither run nor answered, and is logged.
   *
   * The server should be the only sender of action requests, but a client can
   * also check that a request is one it expects: for example, only while its
   * agent has a turn in progress. Requests passed to `execute` directly are
   * not checked; they come from the application itself.
   */
  accept?: (request: OUIActionRequest) => boolean;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface MountedSurface {
  readonly surfaceId: string;
  /** Record an observation value. A no-op once unmounted. */
  pushObservation(observationId: string, value: unknown): void;
  /** Remove this mount. Other mounts of the same surface id are unaffected. */
  unmount(): void;
}

export interface SurfaceRuntime {
  /**
   * Mount a surface. `getContext` is read when an action runs, so handlers see
   * the latest state rather than the state at mount time.
   *
   * Mounting the same surface id twice is allowed (React StrictMode does it on
   * every mount); the most recent mount serves its actions.
   */
  mount<TContext>(
    surface: DefinedSurface<TContext>,
    getContext: () => TContext,
  ): MountedSurface;

  /** Answer requests arriving on this socket (null detaches). */
  attach(socket: SocketLike | null): void;

  /** What the client can do right now. */
  snapshot(): OUISurfaceSnapshot;

  /**
   * Run a request once and resolve with its result. A request id seen before
   * resolves with the first result instead of running again.
   */
  execute(request: OUIActionRequest): Promise<OUIActionResult>;

  /**
   * Keep the UI unsettled until the returned function is called. For work an
   * action starts that mounting and unmounting cannot show, such as a route's
   * code still loading or a page fetching the data it will display.
   */
  hold(): () => void;

  /** Called whenever the snapshot changes. */
  subscribe(listener: () => void): () => void;

  /** Stop polling, detach from the socket and forget every mount. */
  dispose(): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

interface Entry {
  key: number;
  surface: DefinedSurface<unknown>;
  getContext: () => unknown;
}

const DEFAULT_QUIET_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 5000;
const DEFAULT_DEDUPE_WINDOW = 500;
const SETTLE_TICK_MS = 50;

export function createSurfaceRuntime(
  options: SurfaceRuntimeOptions = {},
): SurfaceRuntime {
  const announce = options.announce ?? true;
  const quietMs = options.settle?.quietMs ?? DEFAULT_QUIET_MS;
  const settleTimeoutMs =
    options.settle?.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const dedupeWindow = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW;

  let nextKey = 1;
  const entries: Entry[] = [];
  const observations = new Map<string, Map<string, unknown>>();
  const serializedObservations = new Map<string, string>();
  const holds = new Set<number>();
  let nextHold = 1;
  const results = new Map<string, Promise<OUIActionResult>>();
  const pollers = new Map<string, ReturnType<typeof setInterval>>();
  // How each running poll answers its request if it has to stop early.
  const abandon = new Map<
    string,
    (error: { code: string; message: string }) => void
  >();
  const listeners = new Set<() => void>();
  // Resolves once a request's first result has been handed to the transport.
  const acks = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  function ackFor(requestId: string) {
    let ack = acks.get(requestId);
    if (!ack) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      ack = { promise, resolve };
      acks.set(requestId, ack);
    }
    return ack;
  }
  function acknowledged(requestId: string): Promise<void> {
    return ackFor(requestId).promise;
  }
  let lastChangeAt = Date.now();

  let socket: SocketLike | null = null;
  let transport: OUITransport | null = null;
  let detachTransport: Array<() => void> = [];

  /**
   * `settles: false` for changes that are not the UI reacting to an action,
   * such as an async job's progress: those notify listeners but do not keep
   * an action's result waiting.
   */
  function changed(settles = true) {
    if (settles) lastChangeAt = Date.now();
    for (const l of [...listeners]) l();
  }

  function activeFor(surfaceId: string): Entry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].surface.id === surfaceId) return entries[i];
    }
    return undefined;
  }

  /** Active entries, one per surface id, in the order each id was first mounted. */
  function activeEntries(): Entry[] {
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const e of entries) {
      if (seen.has(e.surface.id)) continue;
      seen.add(e.surface.id);
      out.push(activeFor(e.surface.id)!);
    }
    return out;
  }

  function announceSurface(entry: Entry) {
    if (!announce || !transport) return;
    transport.registerSurface(entry.surface.toManifest());
    const obs = observations.get(entry.surface.id);
    if (obs) {
      for (const [observationId, value] of obs) {
        transport.pushObservation({
          surfaceId: entry.surface.id,
          observationId,
          value,
          timestamp: Date.now(),
        });
      }
    }
  }

  function announceAll() {
    for (const e of activeEntries()) announceSurface(e);
  }

  function setObservation(
    surfaceId: string,
    observationId: string,
    value: unknown,
    settles = true,
  ) {
    const key = `${surfaceId}\u0000${observationId}`;
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? "undefined";
    } catch {
      serialized = String(value);
    }
    if (serializedObservations.get(key) === serialized) return;
    serializedObservations.set(key, serialized);

    let obs = observations.get(surfaceId);
    if (!obs) {
      obs = new Map();
      observations.set(surfaceId, obs);
    }
    obs.set(observationId, toJsonSafe(value));

    if (announce && transport) {
      transport.pushObservation({
        surfaceId,
        observationId,
        value,
        timestamp: Date.now(),
      });
    }
    changed(settles);
  }

  function forgetSurface(surfaceId: string) {
    observations.delete(surfaceId);
    for (const key of [...serializedObservations.keys()]) {
      if (key.startsWith(`${surfaceId}\u0000`))
        serializedObservations.delete(key);
    }
    for (const [key, timer] of pollers) {
      if (key.startsWith(`${surfaceId}\u0000`)) {
        clearInterval(timer);
        pollers.delete(key);
        // The request still gets its final answer: a poll that stops
        // without one leaves the agent waiting forever.
        abandon.get(key)?.({
          code: "SURFACE_NOT_MOUNTED",
          message:
            `Surface "${surfaceId}" left the page before its action finished, ` +
            "so it is no longer being followed. Check what the page shows " +
            "before trying again.",
        });
        abandon.delete(key);
      }
    }
  }

  // ─── Polling (async actions) ──────────────────────────────────────────────

  /**
   * Polls an async action to completion, publishing progress as an observation
   * and, when it ends, the request's final result (OUI spec §7.3: an async
   * action is acknowledged, then answered once more when it finishes).
   */
  function startPolling(
    requestId: string,
    surfaceId: string,
    actionId: string,
    polling: ActionPollingConfig<unknown>,
    dispatchResult: unknown,
  ) {
    const finish = async (
      success: boolean,
      data: unknown,
      error?: { code: string; message: string },
    ) => {
      // The acknowledgment goes first: a job can finish before the UI settles.
      await acknowledged(requestId);
      const snap = snapshot();
      transport?.sendResult({
        requestId,
        success,
        ...(data !== undefined ? { data: toJsonSafe(data) } : {}),
        ...(error ? { error } : {}),
        interim: false,
        timestamp: Date.now(),
        surfaces: snap.surfaces,
        observations: snap.observations,
      });
      acks.delete(requestId);
    };

    // The observation id is the one surfaces have always published under.
    const observationId = `${surfaceId}:${actionId}:status`;
    const pollerKey = `${surfaceId}\u0000${actionId}`;

    if (polling.subscribe) {
      setObservation(
        surfaceId,
        observationId,
        { status: "dispatched", dispatchResult, interim: true },
        false,
      );
      return;
    }
    if (!polling.resolve) {
      setObservation(
        surfaceId,
        observationId,
        { status: "dispatched", dispatchResult, interim: false },
        false,
      );
      return;
    }

    const existing = pollers.get(pollerKey);
    if (existing) {
      clearInterval(existing);
      pollers.delete(pollerKey);
      abandon.get(pollerKey)?.({
        code: "SUPERSEDED",
        message:
          `"${actionId}" was started again before this run finished, ` +
          "so only the newer run is being followed.",
      });
      abandon.delete(pollerKey);
    }

    setObservation(
      surfaceId,
      observationId,
      { status: "polling", dispatchResult, interim: true },
      false,
    );

    const maxAttempts = polling.maxAttempts ?? Infinity;
    const maxDuration = polling.maxDurationMs ?? Infinity;
    const startedAt = Date.now();
    let attempts = 0;

    const timer = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts || Date.now() - startedAt > maxDuration) {
        clearInterval(timer);
        pollers.delete(pollerKey);
        abandon.delete(pollerKey);
        setObservation(
          surfaceId,
          observationId,
          { status: "timeout", dispatchResult, interim: false },
          false,
        );
        void finish(false, undefined, {
          code: "TIMEOUT",
          message: `"${actionId}" did not finish within its polling limits.`,
        });
        return;
      }
      const entry = activeFor(surfaceId);
      if (!entry) {
        // forgetSurface normally gets here first; answer anyway.
        clearInterval(timer);
        pollers.delete(pollerKey);
        const gone = abandon.get(pollerKey);
        abandon.delete(pollerKey);
        gone?.({
          code: "SURFACE_NOT_MOUNTED",
          message:
            `Surface "${surfaceId}" left the page before "${actionId}" ` +
            "finished, so it is no longer being followed. Check what the " +
            "page shows before trying again.",
        });
        return;
      }
      // The surface may have remounted without this action (a control that is
      // disabled while its job runs, say). The job is still running, so keep
      // following it with the polling it started with.
      const action = entry.surface.actions.find((a) => a.id === actionId);
      const resolve = action?.polling?.resolve ?? polling.resolve;
      if (!resolve) return;
      try {
        const r = await resolve(dispatchResult, entry.getContext());
        setObservation(
          surfaceId,
          observationId,
          {
            ...(r.data as Record<string, unknown>),
            interim: !r.done,
          },
          false,
        );
        if (r.done) {
          clearInterval(timer);
          pollers.delete(pollerKey);
          abandon.delete(pollerKey);
          void finish(true, r.data);
        }
      } catch (err) {
        // A transient failure is reported, not fatal: keep polling.
        setObservation(
          surfaceId,
          observationId,
          { status: "poll_error", error: String(err), interim: true },
          false,
        );
      }
    }, polling.intervalMs);

    pollers.set(pollerKey, timer);
    abandon.set(pollerKey, (error) => void finish(false, undefined, error));
  }

  // ─── Settling ─────────────────────────────────────────────────────────────

  async function waitUntilSettled(since: number): Promise<boolean> {
    const deadline = since + settleTimeoutMs;
    for (;;) {
      const now = Date.now();
      const quietFor = now - Math.max(since, lastChangeAt);
      if (holds.size === 0 && quietFor >= quietMs) return true;
      if (now >= deadline) return false;
      await sleep(Math.min(SETTLE_TICK_MS, deadline - now));
    }
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  async function run(request: OUIActionRequest): Promise<OUIActionResult> {
    const startedAt = Date.now();
    const entry = activeFor(request.surfaceId);

    let result: ActionHandlerResult;
    let interim = false;
    if (!entry) {
      const mounted = activeEntries().map((e) => e.surface.id);
      result = {
        success: false,
        error: {
          code: "SURFACE_NOT_MOUNTED",
          message:
            `Surface "${request.surfaceId}" is not on screen. ` +
            `Mounted surfaces: ${mounted.length ? mounted.join(", ") : "none"}.`,
        },
      };
    } else {
      // executeAction turns a thrown handler into ACTION_EXECUTION_ERROR.
      result = await entry.surface.executeAction(
        request.actionId,
        request.params ?? {},
        entry.getContext(),
      );
      if (result.success) {
        const action = entry.surface.actions.find(
          (a) => a.id === request.actionId,
        );
        if (action?.polling) {
          interim = true;
          startPolling(
            request.requestId,
            entry.surface.id,
            action.id,
            action.polling,
            result.data ?? result.dispatchMeta,
          );
        }
      }
    }

    const settled = await waitUntilSettled(startedAt);
    const snap = snapshot();

    return {
      requestId: request.requestId,
      success: result.success,
      ...(result.data !== undefined ? { data: toJsonSafe(result.data) } : {}),
      ...(result.error
        ? { error: toJsonSafe(result.error) as OUIActionResult["error"] }
        : {}),
      ...(interim ? { interim: true } : {}),
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
      surfaces: snap.surfaces,
      observations: snap.observations,
      settled,
    };
  }

  function execute(request: OUIActionRequest): Promise<OUIActionResult> {
    const seen = results.get(request.requestId);
    if (seen) return seen;

    const pending = run(request);
    results.set(request.requestId, pending);
    while (results.size > dedupeWindow) {
      const oldest = results.keys().next().value as string;
      results.delete(oldest);
    }
    return pending;
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  function snapshot(): OUISurfaceSnapshot {
    const surfaces: OUISurface[] = [];
    const obs: OUIObservationSnapshot = {};
    for (const e of activeEntries()) {
      surfaces.push(e.surface.toManifest());
      const values = observations.get(e.surface.id);
      if (values && values.size > 0)
        obs[e.surface.id] = Object.fromEntries(values);
    }
    return { surfaces, observations: obs };
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  function attach(next: SocketLike | null) {
    if (next === socket) return;
    for (const off of detachTransport) off();
    detachTransport = [];
    transport?.dispose();
    transport = null;
    socket = next;
    if (!next) return;

    const t = createWebSocketTransport(next, options.transport);
    transport = t;

    detachTransport.push(
      t.onAction((request) => {
        if (options.accept && !options.accept(request)) {
          console.warn(
            `[OUI] Refused a request the client does not accept: ${request.surfaceId}.${request.actionId} (${request.requestId})`,
          );
          return;
        }
        void execute(request).then((result) => {
          // Answer on whichever transport is live when the result is ready: a
          // reconnect in between keeps the same socket, so this still reaches
          // the runtime that asked.
          transport?.sendResult(result);
          const ack = ackFor(request.requestId);
          ack.resolve();
          // Keep the gate only while a final result may still follow.
          if (!result.interim) acks.delete(request.requestId);
        });
      }),
    );

    if (announce) {
      // A server-side registry forgets a socket's surfaces when it drops, so
      // every (re)connection announces them again.
      detachTransport.push(
        t.onConnectionChange((connected) => {
          if (connected) announceAll();
        }),
      );
      if (t.connected) announceAll();
    }
  }

  if (options.socket) attach(options.socket);

  // ─── Mounting ─────────────────────────────────────────────────────────────

  function mount<TContext>(
    surface: DefinedSurface<TContext>,
    getContext: () => TContext,
  ): MountedSurface {
    const entry: Entry = {
      key: nextKey++,
      surface: surface as unknown as DefinedSurface<unknown>,
      getContext: getContext as () => unknown,
    };
    entries.push(entry);
    announceSurface(entry);
    changed();

    let mounted = true;
    return {
      surfaceId: surface.id,
      pushObservation(observationId, value) {
        // Only the mount serving the surface speaks for it.
        if (!mounted || activeFor(surface.id) !== entry) return;
        setObservation(surface.id, observationId, value);
      },
      unmount() {
        if (!mounted) return;
        mounted = false;
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
        const replacement = activeFor(surface.id);
        if (replacement) {
          announceSurface(replacement);
        } else {
          forgetSurface(surface.id);
          if (announce && transport) transport.deregisterSurface(surface.id);
        }
        changed();
      },
    };
  }

  return {
    mount,
    attach,
    snapshot,
    execute,
    hold() {
      const id = nextHold++;
      holds.add(id);
      changed();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.delete(id);
        changed();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const timer of pollers.values()) clearInterval(timer);
      pollers.clear();
      abandon.clear();
      attach(null);
      entries.length = 0;
      observations.clear();
      serializedObservations.clear();
      holds.clear();
      listeners.clear();
      acks.clear();
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Results and observations cross a wire as JSON. A handler returning something
 * that is not (a DOM node, a class instance with cycles) must not take the
 * result down with it.
 */
function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
