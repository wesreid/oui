import type {
  OUIAcknowledgment,
  OUITransport,
  OUITransportConfig,
  OUIActionHandler,
  OUIObservationHandler,
  OUIResultHandler,
} from "./types.js";
import type {
  OUISurface,
  OUIObservationUpdate,
  OUIActionRequest,
  OUIActionResult,
  OUIActionApproval,
} from "../spec/index.js";

/**
 * WebSocket transport using Socket.IO.
 * Maps OUI protocol events to socket events with a configurable namespace prefix.
 *
 * Events:
 *   {ns}:dispatch            — action request   (runtime → client)
 *   {ns}:action:result       — action result    (client → runtime)
 *   {ns}:observation         — observation      (client → runtime)
 *   {ns}:surface:register    — registration     (client → runtime)
 *   {ns}:surface:deregister  — deregistration   (client → runtime)
 */
export function createWebSocketTransport(
  socket: SocketLike,
  config?: OUITransportConfig,
): OUITransport {
  const ns = config?.namespace ?? "oui";
  const buffer: Array<{ event: string; data: unknown; ack?: Ack }> = [];
  const maxBuffer = config?.maxBufferSize ?? 100;
  const shouldBuffer = config?.bufferWhileDisconnected ?? true;

  let connected = socket.connected ?? false;
  const connectionHandlers: Array<(c: boolean) => void> = [];

  // Every listener this transport attaches, so dispose() can remove exactly
  // these and nothing the integrator attached to the same socket.
  const attached: Array<{ event: string; handler: (...args: any[]) => void }> =
    [];
  function listen(
    event: string,
    handler: (...args: any[]) => void,
  ): () => void {
    socket.on(event, handler);
    const entry = { event, handler };
    attached.push(entry);
    return () => {
      socket.off(event, handler);
      const i = attached.indexOf(entry);
      if (i >= 0) attached.splice(i, 1);
    };
  }

  listen("connect", () => {
    connected = true;
    // Flush before announcing: anything queued while offline was sent earlier
    // than whatever a connection handler is about to send.
    if (shouldBuffer) {
      while (buffer.length > 0) {
        const msg = buffer.shift()!;
        if (msg.ack) socket.emit(msg.event, msg.data, msg.ack);
        else socket.emit(msg.event, msg.data);
      }
    }
    connectionHandlers.forEach((h) => h(true));
  });

  listen("disconnect", () => {
    connected = false;
    connectionHandlers.forEach((h) => h(false));
  });

  function emit(event: string, data: unknown, ack?: Ack) {
    if (connected) {
      if (ack) socket.emit(event, data, ack);
      else socket.emit(event, data);
    } else if (shouldBuffer && buffer.length < maxBuffer) {
      buffer.push({ event, data, ...(ack ? { ack } : {}) });
    }
  }

  return {
    // ─── Dispatch ───────────────────────────────────────────────
    dispatch(request: OUIActionRequest) {
      emit(`${ns}:dispatch`, request);
    },

    onAction(handler: OUIActionHandler) {
      return listen(
        `${ns}:dispatch`,
        (data: Partial<OUIActionRequest> | undefined, ack?: unknown) => {
          // The sender's receipt, when it asked for one (§7.3.7).
          const receipt =
            typeof ack === "function"
              ? (a: OUIAcknowledgment) => (ack as (r: unknown) => void)(a)
              : undefined;
          // A request without a requestId cannot be answered, and answering is
          // the contract. Refuse it loudly rather than run an action whose
          // result has nowhere to go.
          if (
            !data ||
            typeof data.requestId !== "string" ||
            !data.requestId ||
            typeof data.surfaceId !== "string" ||
            typeof data.actionId !== "string"
          ) {
            console.warn(
              "[OUI] Dropped a dispatch without requestId/surfaceId/actionId",
              data,
            );
            receipt?.({
              ok: false,
              reason: "a request needs requestId, surfaceId and actionId",
            });
            return;
          }
          handler(
            {
              requestId: data.requestId,
              surfaceId: data.surfaceId,
              actionId: data.actionId,
              params: data.params ?? {},
              timestamp: data.timestamp ?? Date.now(),
              ...(isApproval(data.approval)
                ? {
                    approval: {
                      approvalId: data.approval.approvalId,
                      argsHash: data.approval.argsHash,
                    },
                  }
                : {}),
              // The surfaces the agent runtime holds, so the answer need not repeat them (§7.3.4).
              ...(typeof data.knownSurfaces === "string" && data.knownSurfaces
                ? { knownSurfaces: data.knownSurfaces }
                : {}),
              // The turn the request belongs to, for a client that accepts per turn (§7.3.1).
              ...(typeof data.turnId === "string" && data.turnId
                ? { turnId: data.turnId }
                : {}),
            },
            receipt,
          );
        },
      );
    },

    // ─── Result ─────────────────────────────────────────────────
    sendResult(
      result: OUIActionResult,
      onAcknowledged?: (ack: OUIAcknowledgment) => void,
    ) {
      // Acknowledged, so a refusal is heard rather than silent (§7.3.6).
      emit(
        `${ns}:action:result`,
        result,
        onAcknowledged
          ? (response: unknown) => {
              const ack = acknowledgmentOf(response);
              if (ack) onAcknowledged(ack);
            }
          : undefined,
      );
    },

    onResult(handler: OUIResultHandler) {
      return listen(`${ns}:action:result`, (data: OUIActionResult) =>
        handler(data),
      );
    },

    // ─── Observation Channel ────────────────────────────────────
    pushObservation(update: OUIObservationUpdate) {
      emit(`${ns}:observation`, update);
    },

    onObservation(handler: OUIObservationHandler) {
      return listen(`${ns}:observation`, (data: OUIObservationUpdate) =>
        handler(data),
      );
    },

    // ─── Surface Lifecycle ──────────────────────────────────────
    registerSurface(surface: OUISurface) {
      emit(`${ns}:surface:register`, { surface, timestamp: Date.now() });
    },

    deregisterSurface(surfaceId: string) {
      emit(`${ns}:surface:deregister`, { surfaceId, timestamp: Date.now() });
    },

    onSurfaceRegister(handler: (surface: OUISurface) => void) {
      return listen(`${ns}:surface:register`, (data: { surface: OUISurface }) =>
        handler(data.surface),
      );
    },

    onSurfaceDeregister(handler: (surfaceId: string) => void) {
      return listen(`${ns}:surface:deregister`, (data: { surfaceId: string }) =>
        handler(data.surfaceId),
      );
    },

    // ─── Connection ─────────────────────────────────────────────
    get connected() {
      return connected;
    },

    async connect() {
      if (connected) return;
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `OUI transport connect timeout (${config?.connectTimeoutMs ?? 10000}ms)`,
            ),
          );
        }, config?.connectTimeoutMs ?? 10000);

        socket.once("connect", () => {
          clearTimeout(timeout);
          resolve();
        });

        if (typeof socket.connect === "function") {
          socket.connect();
        }
      });
    },

    disconnect() {
      if (typeof socket.disconnect === "function") {
        socket.disconnect();
      }
    },

    onConnectionChange(handler: (c: boolean) => void) {
      connectionHandlers.push(handler);
      return () => {
        const idx = connectionHandlers.indexOf(handler);
        if (idx >= 0) connectionHandlers.splice(idx, 1);
      };
    },

    dispose() {
      for (const { event, handler } of attached.splice(0)) {
        socket.off(event, handler);
      }
      connectionHandlers.length = 0;
      buffer.length = 0;
    },
  };
}

/**
 * Minimal socket interface — compatible with Socket.IO client or server socket.
 * Only the methods OUI actually uses.
 */
export interface SocketLike {
  readonly connected?: boolean;
  /** An optional last argument is the receiver's acknowledgment callback, as Socket.IO takes it. */
  emit(event: string, ...args: any[]): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
  connect?(): void;
  disconnect?(): void;
}

/** An approval as the wire carries it; anything else is dropped, so the runtime treats the request as unapproved. */
function isApproval(value: unknown): value is OUIActionApproval {
  const a = value as Partial<OUIActionApproval> | null | undefined;
  return (
    !!a &&
    typeof a.approvalId === "string" &&
    !!a.approvalId &&
    typeof a.argsHash === "string"
  );
}

/** The receiver's acknowledgment callback. */
type Ack = (response: unknown) => void;

/**
 * A receiver's acknowledgment: `{ ok: true }`, or `{ ok: false, error }` /
 * `{ ok: false, reason }` as a refusal; null for anything else.
 */
function acknowledgmentOf(response: unknown): OUIAcknowledgment | null {
  const r = response as
    { ok?: unknown; error?: unknown; reason?: unknown } | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (r.ok === true) return { ok: true };
  if (r.ok !== false) return null;
  const why =
    typeof r.error === "string"
      ? r.error
      : typeof r.reason === "string"
        ? r.reason
        : "";
  return { ok: false, reason: why || "refused" };
}
