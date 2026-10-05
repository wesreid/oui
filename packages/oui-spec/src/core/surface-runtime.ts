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
  OUIAction,
  OUIActionRequest,
  OUIActionResult,
  OUIApprovalGrant,
  OUIFit,
  OUIIndexSnapshot,
  OUIResultDelivery,
  OUISurface,
  OUISurfaceIndex,
  OUISurfaceSnapshot,
  OUIObservationSnapshot,
} from "../spec/index.js";
import {
  ARGS_HASH_PATTERN,
  argsHash,
  requiresApproval,
} from "../spec/approval.js";
import { surfacesHash } from "../spec/surfaces-hash.js";
import {
  jsonBytes,
  OUI_DESCRIBE_ACTION,
  OUI_READ_ACTION,
  OUI_RUNTIME_SURFACE,
  surfaceIndex,
} from "../spec/index-form.js";
import { atPointer, fitObservations } from "../spec/fit.js";
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
   * refused request is not run: its sender gets a receipt saying it was
   * received and not accepted, and the refusal is logged.
   *
   * The server should be the only sender of action requests, but a client can
   * also check that a request is one it expects: for example, only for the
   * turn its agent is running now (the request's `turnId`), so a request sent
   * late by a stopped turn does not run. Requests passed to `execute` directly are
   * not checked; they come from the application itself.
   */
  accept?: (request: OUIActionRequest) => boolean;

  /**
   * What a snapshot and an answer say of the mounted surfaces (§7.3.8):
   * - `"index"`: each action as an index entry. The agent runtime fetches a
   *   definition when it needs one (`oui.describe`). Use it with an agent
   *   runtime that reads the index form.
   * - `"full"` (the default until 1.0): each action's whole definition, as
   *   every earlier version sent. A page's definitions can outweigh what a
   *   frame may carry; then its answers are refused and arrive trimmed.
   */
  form?: "index" | "full";

  /** The most bytes of JSON a frame carries; what does not fit is shortened and said so (§7.3.9). */
  budgets?: {
    /** One answer. Default 480 KB: under the 512 KB a relay commonly caps a frame at. */
    answerBytes?: number;
    /** One snapshot, as sent with a turn. Default 256 KB. */
    snapshotBytes?: number;
  };

  /**
   * A request sent again while its answer is on the way is not answered again
   * (§7.3.7): every copy of a large answer queues on the one socket, ahead of
   * the next request's answer. Only once the answer has gone this long without
   * the receiver acknowledging it — lost, or a receiver that does not
   * acknowledge — is a repeat answered again. Default 8000 ms.
   */
  reanswerAfterMs?: number;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface MountedSurface {
  readonly surfaceId: string;
  /** Record an observation value. A no-op once unmounted. */
  pushObservation(observationId: string, value: unknown): void;
  /** Remove this mount. Other mounts of the same surface id are unaffected. */
  unmount(): void;
}

/** The form a runtime sends its surfaces in (§7.3.8). */
export type SurfaceForm = "full" | "index";

export interface SurfaceRuntime<F extends SurfaceForm = "full"> {
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
  snapshot(): F extends "index" ? OUIIndexSnapshot : OUISurfaceSnapshot;

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

  /**
   * Record that the user approved one request, here, through their own
   * confirmation (the agent runtime's approval store answered it to this tab).
   * An action that needs approval — a `transaction`, or a destructive write —
   * runs only on a request whose `approval` matches an unused, unexpired grant
   * for exactly its params. Each grant admits one request.
   */
  grantApproval(grant: OUIApprovalGrant): void;

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
const DEFAULT_REANSWER_AFTER_MS = 8000;
const SETTLE_TICK_MS = 50;
const DEFAULT_ANSWER_BYTES = 480 * 1024;
const DEFAULT_SNAPSHOT_BYTES = 256 * 1024;
/** What an answer keeps for the page's observations whatever its `data` weighs. */
const OBSERVATION_FLOOR_BYTES = 16 * 1024;
/** Rows `oui.read` returns of a list when the request names no limit. */
const DEFAULT_READ_ROWS = 50;

export function createSurfaceRuntime(
  options: SurfaceRuntimeOptions & { form: "index" },
): SurfaceRuntime<"index">;
export function createSurfaceRuntime(
  options?: SurfaceRuntimeOptions & { form?: "full" },
): SurfaceRuntime<"full">;
export function createSurfaceRuntime(
  options: SurfaceRuntimeOptions = {},
): SurfaceRuntime<SurfaceForm> {
  const announce = options.announce ?? true;
  const quietMs = options.settle?.quietMs ?? DEFAULT_QUIET_MS;
  const settleTimeoutMs =
    options.settle?.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const dedupeWindow = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW;
  const reanswerAfterMs = options.reanswerAfterMs ?? DEFAULT_REANSWER_AFTER_MS;
  const form: SurfaceForm = options.form ?? "full";
  const answerBytes = options.budgets?.answerBytes ?? DEFAULT_ANSWER_BYTES;
  const snapshotBytes =
    options.budgets?.snapshotBytes ?? DEFAULT_SNAPSHOT_BYTES;
  // A defined surface never changes, so its manifest and index are made once.
  const manifests = new WeakMap<object, OUISurface>();
  const indexes = new WeakMap<object, OUISurfaceIndex>();
  const manifestOf = (surface: DefinedSurface<unknown>): OUISurface => {
    let manifest = manifests.get(surface);
    if (!manifest)
      manifests.set(
        surface,
        (manifest = toJsonSafe(surface.toManifest()) as OUISurface),
      );
    return manifest;
  };
  const indexOf = (surface: DefinedSurface<unknown>): OUISurfaceIndex => {
    let index = indexes.get(surface);
    if (!index)
      indexes.set(surface, (index = surfaceIndex(manifestOf(surface))));
    return index;
  };

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
  // How each request's first answer is getting to the agent runtime: still
  // being worked out, sent (when), or acknowledged as received. A repeat of the
  // request is answered again only when the answer may have been lost (§7.3.7).
  const delivery = new Map<
    string,
    { state: "running" | "sent" | "received"; at: number }
  >();
  // The surfaces hash each request's first answer reported: an async action's
  // final answer repeats its surfaces only if they changed since then, since
  // the agent runtime waited for that first answer before waiting for this one.
  const answeredHash = new Map<string, string>();
  let lastChangeAt = Date.now();
  // Approvals the user gave in this tab, by approval id, until used or expired.
  const grants = new Map<string, OUIApprovalGrant>();

  /**
   * Why a request for an action that needs approval may not run, or null when
   * it may — in which case its grant is used up.
   */
  async function approvalRefusal(
    request: OUIActionRequest,
  ): Promise<string | null> {
    const approval = request.approval;
    if (!approval)
      return "it needs the user's approval, and the request carries none";
    let hash: string;
    try {
      hash = await argsHash(request.params ?? {});
    } catch (err) {
      return `its params cannot be checked against an approval: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Checked and used up with no await in between, so one grant admits one request.
    const grant = grants.get(approval.approvalId);
    if (!grant) return "this tab holds no unused approval for it";
    if (Date.now() >= grant.expiresAt) {
      grants.delete(approval.approvalId);
      return "its approval has expired";
    }
    if (approval.argsHash !== grant.argsHash || hash !== grant.argsHash) {
      return "its params are not the ones the user approved";
    }
    grants.delete(approval.approvalId);
    return null;
  }

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
      answer(
        frame(
          {
            requestId,
            success,
            ...(data !== undefined ? { data: toJsonSafe(data) } : {}),
            ...(error ? { error } : {}),
            interim: false,
            timestamp: Date.now(),
          },
          answeredHash.get(requestId),
        ),
      );
      acks.delete(requestId);
      answeredHash.delete(requestId);
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
          // Work that failed ends as a failure, with what it reported.
          void finish(!r.error, r.data, r.error);
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

  /**
   * Wait until the page has been quiet for `quietMs` since `since`, with no
   * hold open; false when `settleTimeoutMs` passes first.
   *
   * `since` is when the handler RETURNED, not when the request arrived. A
   * handler that awaits its own work — a save, a restore over the network —
   * and only then changes the page returns later than `quietMs` after it
   * started; measured from the start, the page had already "been quiet" for
   * the whole of that wait, so the answer was taken at once, before the UI had
   * rendered the change the handler had just made. The result said the
   * restore had worked and the observations beside it still showed the page
   * before it (dev, 2026-10-03).
   */
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
    if (request.surfaceId === OUI_RUNTIME_SURFACE)
      return builtin(request, startedAt);
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
      const declared = entry.surface.actions.find(
        (a) => a.id === request.actionId,
      );
      const refusal =
        declared && requiresApproval(declared.effect, declared.confirm)
          ? await approvalRefusal(request)
          : null;
      // executeAction turns a thrown handler into ACTION_EXECUTION_ERROR.
      result = refusal
        ? {
            success: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: `"${request.actionId}" was not run: ${refusal}.`,
            },
          }
        : await entry.surface.executeAction(
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

    // From now: the handler has returned, and what it changed is still to render.
    const settled = await waitUntilSettled(Date.now());
    const answered = frame(
      {
        requestId: request.requestId,
        success: result.success,
        ...(result.data !== undefined ? { data: toJsonSafe(result.data) } : {}),
        ...(result.error
          ? { error: toJsonSafe(result.error) as OUIActionResult["error"] }
          : {}),
        ...(interim ? { interim: true } : {}),
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
        settled,
      },
      request.knownSurfaces,
    );
    if (interim) answeredHash.set(request.requestId, answered.surfacesHash!);
    return answered;
  }

  /**
   * An outcome as the answer that carries it: with what the page offers, only
   * when the agent runtime does not already hold it (§7.3.4), and the page's
   * observations, all within the answer's byte budget (§7.3.9). The action's
   * own `data` is kept whole unless it alone outweighs the frame; the
   * observations take what is left, and say where they were cut.
   */
  function frame(
    outcome: OUIActionResult,
    knownSurfaces: string | undefined,
  ): OUIActionResult {
    const page = capture();
    const out: OUIActionResult = {
      ...outcome,
      ...(page.surfacesHash !== knownSurfaces
        ? form === "index"
          ? { index: page.index }
          : { surfaces: page.surfaces }
        : {}),
      surfacesHash: page.surfacesHash,
    };
    const fit: OUIFit = {};
    // Definitions that alone outweigh the frame are refused and then left out
    // (§7.3.6): the rest is fitted as the answer that will then be sent.
    const carried =
      jsonBytes(out.index ?? out.surfaces) >= answerBytes
        ? { ...out, index: undefined, surfaces: undefined }
        : out;
    const dataLimit =
      answerBytes -
      jsonBytes({ ...carried, data: undefined }) -
      OBSERVATION_FLOOR_BYTES;
    const dataBytes = jsonBytes(out.data);
    if (dataBytes > Math.max(0, dataLimit)) {
      delete out.data;
      fit.data = { bytes: dataBytes, limit: Math.max(0, dataLimit) };
    }
    const fitted = fitObservations(
      page.observations,
      Math.max(
        0,
        answerBytes -
          jsonBytes(
            out.data === undefined ? { ...carried, data: undefined } : carried,
          ),
      ),
    );
    out.observations = fitted.observations;
    if (fitted.cuts.length) fit.observations = fitted.cuts;
    if (fit.data || fit.observations) out.fit = fit;
    return out;
  }

  // ─── The runtime's own actions (§7.3.10) ─────────────────────────────────────

  /**
   * `oui.describe` and `oui.read`: answered here, at once. They read what the
   * client holds and change nothing, so there is nothing to settle, and their
   * answer carries their data and the surfaces hash only.
   */
  function builtin(
    request: OUIActionRequest,
    startedAt: number,
  ): OUIActionResult {
    const done = (
      body: Pick<OUIActionResult, "success" | "data" | "error">,
    ): OUIActionResult => ({
      requestId: request.requestId,
      ...body,
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
      surfacesHash: capture().surfacesHash,
      settled: true,
    });
    const refuse = (code: string, message: string) =>
      done({ success: false, error: { code, message } });
    const params = request.params ?? {};

    if (request.actionId === OUI_DESCRIBE_ACTION) {
      const asked = params.actions;
      if (
        !Array.isArray(asked) ||
        asked.length === 0 ||
        !asked.every(
          (a) =>
            a &&
            typeof a === "object" &&
            typeof (a as Record<string, unknown>).surface === "string" &&
            typeof (a as Record<string, unknown>).action === "string",
        )
      ) {
        return refuse(
          "INVALID_PARAMS",
          '"describe" takes actions: [{ surface, action }], at least one',
        );
      }
      const definitions: Array<{ surface: string; action: OUIAction }> = [];
      const missing: Array<{ surface: string; action: string }> = [];
      const deferred: Array<{ surface: string; action: string }> = [];
      let bytes = 0;
      for (const { surface, action } of asked as Array<{
        surface: string;
        action: string;
      }>) {
        const entry = activeFor(surface);
        const definition =
          entry &&
          manifestOf(entry.surface).actions.find((a) => a.id === action);
        if (!definition) {
          missing.push({ surface, action });
          continue;
        }
        const size = jsonBytes(definition);
        // One definition always goes, however large: the rest wait for the next request.
        if (
          definitions.length > 0 &&
          bytes + size > answerBytes - OBSERVATION_FLOOR_BYTES
        ) {
          deferred.push({ surface, action });
          continue;
        }
        bytes += size;
        definitions.push({ surface, action: definition });
      }
      return done({
        success: true,
        data: {
          definitions,
          ...(missing.length ? { missing } : {}),
          ...(deferred.length ? { deferred } : {}),
        },
      });
    }

    if (request.actionId === OUI_READ_ACTION) {
      const { surface, observation } = params as Record<string, unknown>;
      const path = params.path === undefined ? "" : params.path;
      const offset = params.offset === undefined ? 0 : params.offset;
      const limit =
        params.limit === undefined ? DEFAULT_READ_ROWS : params.limit;
      if (
        typeof surface !== "string" ||
        typeof observation !== "string" ||
        typeof path !== "string"
      ) {
        return refuse(
          "INVALID_PARAMS",
          '"read" takes surface, observation and, to read part of the value, path',
        );
      }
      if (
        !Number.isInteger(offset) ||
        (offset as number) < 0 ||
        !Number.isInteger(limit) ||
        (limit as number) < 1
      ) {
        return refuse(
          "INVALID_PARAMS",
          '"read" takes offset (0 or more) and limit (1 or more) as whole numbers',
        );
      }
      const values = observations.get(surface);
      if (!values || !values.has(observation)) {
        const known = values ? [...values.keys()] : [];
        return refuse(
          "NOT_FOUND",
          values
            ? `Surface "${surface}" reports no observation "${observation}". It reports: ${known.join(", ") || "none"}.`
            : `Surface "${surface}" is not on screen, or reports nothing.`,
        );
      }
      let value: unknown;
      try {
        value = atPointer(values.get(observation), path);
      } catch (err) {
        return refuse(
          "INVALID_PARAMS",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (value === undefined) {
        return refuse(
          "NOT_FOUND",
          `Nothing is at "${path}" in ${surface}.${observation}.`,
        );
      }
      const room = answerBytes - OBSERVATION_FLOOR_BYTES;
      if (Array.isArray(value)) {
        const total = value.length;
        let rows = value.slice(
          offset as number,
          (offset as number) + (limit as number),
        );
        // A page of rows that outweighs the frame is halved until it fits; one row always goes.
        while (rows.length > 1 && jsonBytes(rows) > room)
          rows = rows.slice(0, Math.ceil(rows.length / 2));
        const next = (offset as number) + rows.length;
        return done({
          success: true,
          data: {
            rows,
            total,
            offset,
            ...(next < total ? { more: true, next } : {}),
          },
        });
      }
      const fitted = fitObservations(
        { [surface]: { [observation]: value } },
        room,
      );
      // Cuts are reported relative to the observation, as every other cut is.
      const cuts = fitted.cuts.map((c) => ({ ...c, path: `${path}${c.path}` }));
      return done({
        success: true,
        data: {
          value: fitted.observations[surface][observation],
          ...(cuts.length ? { fit: { observations: cuts } } : {}),
        },
      });
    }

    return refuse(
      "ACTION_NOT_FOUND",
      `The runtime answers "${OUI_DESCRIBE_ACTION}" and "${OUI_READ_ACTION}"; it has no "${request.actionId}".`,
    );
  }

  // ─── Answering ────────────────────────────────────────────────────────────

  /**
   * Send an answer, and if the receiving side refuses it, send it again
   * trimmed, saying why (§7.3.6): first without what the page offers, then
   * without the page's observations too, then without the action's data. What
   * the page shows is given up after what it offers: an agent that still sees
   * the page can carry on, and one that does not must stop. An answer that is
   * refused and not sent again leaves the agent waiting until its deadline,
   * then reporting an action that ran as one that did not answer.
   */
  function answer(result: OUIActionResult, onReceived?: () => void) {
    const offered = form === "index" ? "index" : "surfaces";
    const steps: Array<OUIResultDelivery["omitted"]> = [
      [offered],
      [offered, "observations"],
      [offered, "observations", "data"],
    ];
    const send = (frame: OUIActionResult, step: number) => {
      transport?.sendResult(frame, (ack) => {
        if (ack.ok) {
          onReceived?.();
          return;
        }
        const omitted = steps[step];
        if (!omitted) {
          console.warn(
            `[OUI] The answer to ${result.requestId} was refused even trimmed: ${ack.reason}`,
          );
          return;
        }
        console.warn(
          `[OUI] The answer to ${result.requestId} was refused (${ack.reason}); sending it without ${omitted.join(", ")}`,
        );
        send(trimmed(result, ack.reason, omitted), step + 1);
      });
    };
    send(result, 0);
  }

  function execute(request: OUIActionRequest): Promise<OUIActionResult> {
    const seen = results.get(request.requestId);
    if (seen) return seen;

    const pending = run(request);
    results.set(request.requestId, pending);
    while (results.size > dedupeWindow) {
      const oldest = results.keys().next().value as string;
      results.delete(oldest);
      delivery.delete(oldest);
    }
    return pending;
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  /** What is mounted, in the runtime's form, with every observation whole. */
  function capture(): {
    surfaces?: OUISurface[];
    index?: OUISurfaceIndex[];
    observations: OUIObservationSnapshot;
    surfacesHash: string;
  } {
    const active = activeEntries();
    const obs: OUIObservationSnapshot = {};
    for (const e of active) {
      const values = observations.get(e.surface.id);
      if (values && values.size > 0)
        obs[e.surface.id] = Object.fromEntries(values);
    }
    if (form === "index") {
      const index = active.map((e) => indexOf(e.surface));
      return { index, observations: obs, surfacesHash: surfacesHash(index) };
    }
    const surfaces = active.map((e) => manifestOf(e.surface));
    return {
      surfaces,
      observations: obs,
      surfacesHash: surfacesHash(surfaces),
    };
  }

  function snapshot(): OUISurfaceSnapshot | OUIIndexSnapshot {
    const page = capture();
    const offered =
      form === "index" ? { index: page.index! } : { surfaces: page.surfaces! };
    // Definitions that alone outweigh the snapshot cannot be shortened here:
    // the observations are then fitted to the whole budget, not to none of it.
    const offeredBytes = jsonBytes(offered);
    const fitted = fitObservations(
      page.observations,
      offeredBytes >= snapshotBytes
        ? snapshotBytes
        : snapshotBytes - offeredBytes,
    );
    return {
      ...offered,
      observations: fitted.observations,
      surfacesHash: page.surfacesHash,
      ...(fitted.cuts.length ? { fit: { observations: fitted.cuts } } : {}),
    };
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
      t.onAction((request, receipt) => {
        if (options.accept && !options.accept(request)) {
          console.warn(
            `[OUI] Refused a request the client does not accept: ${request.surfaceId}.${request.actionId} (${request.requestId})`,
          );
          receipt?.({
            ok: false,
            reason: "this client does not accept requests now",
          });
          return;
        }
        // Received: the sender need not send it again (§7.3.7).
        receipt?.({ ok: true });
        const id = request.requestId;
        const prior = delivery.get(id);
        // A repeat while the answer is being worked out, or is on its way, or
        // has arrived, gets no second copy: copies of a large answer queue on
        // the one socket ahead of the next request's answer.
        if (prior && prior.state !== "sent") return;
        if (prior && Date.now() - prior.at < reanswerAfterMs) return;
        if (!prior) delivery.set(id, { state: "running", at: Date.now() });
        void execute(request).then((result) => {
          // Answer on whichever transport is live when the result is ready: a
          // reconnect in between keeps the same socket, so this still reaches
          // the runtime that asked.
          if (results.has(id))
            delivery.set(id, { state: "sent", at: Date.now() });
          answer(result, () => {
            if (results.has(id))
              delivery.set(id, { state: "received", at: Date.now() });
          });
          const ack = ackFor(id);
          ack.resolve();
          // Keep the gate only while a final result may still follow.
          if (!result.interim) acks.delete(id);
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
    snapshot: snapshot as SurfaceRuntime<SurfaceForm>["snapshot"],
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
    grantApproval(grant) {
      if (
        !grant ||
        typeof grant.approvalId !== "string" ||
        !grant.approvalId ||
        typeof grant.argsHash !== "string" ||
        !ARGS_HASH_PATTERN.test(grant.argsHash) ||
        !Number.isFinite(grant.expiresAt)
      ) {
        throw new Error(
          "[OUI] grantApproval needs an approvalId, an args hash and an expiry",
        );
      }
      const now = Date.now();
      for (const [id, g] of grants) if (now >= g.expiresAt) grants.delete(id);
      grants.set(grant.approvalId, { ...grant });
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
      answeredHash.clear();
      delivery.clear();
      grants.clear();
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** `result` without the fields `omitted` names, saying so and why (§7.3.6). */
function trimmed(
  result: OUIActionResult,
  reason: string,
  omitted: OUIResultDelivery["omitted"],
): OUIActionResult {
  const out: OUIActionResult = { ...result };
  for (const field of omitted) delete out[field];
  out.delivery = { trimmed: true, reason, omitted: [...omitted] };
  return out;
}

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
