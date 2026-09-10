/**
 * createOUI — the only supported way to instantiate OUI.
 *
 * WHY THIS EXISTS
 *
 * OUI shipped a correct protocol and a correct transport, and its first
 * integrator used neither. studio-ui imported only the `SocketLike` TYPE from
 * oui-spec and rebuilt the wire by hand: a literal map of protocol types to
 * socket names, `oui:` hardcoded so the configurable namespace was unreachable,
 * payload interfaces re-declared on the server, and an `action:result` channel
 * mapped but never sent — duplicating the observation channel that already
 * carries results.
 *
 * Nothing was wrong with the spec. Nothing enforced it. Structural typing meant
 * every hand-rolled piece type-checked, and both ends agreed only by the
 * coincidence of matching string literals. Rename one and the other keeps
 * compiling and silently stops receiving.
 *
 * So the requirements are gated here:
 *
 *   OUI owns the wire. The integrator provides a socket; it cannot provide a
 *   transport, because `OUITransport` values are branded and only this module
 *   brands them.
 *
 *   OUI owns the result path. Results return through the observation channel,
 *   as `use-surface` already implements. An integrator cannot add a parallel
 *   channel because it cannot construct a transport to add one to.
 *
 *   The integrator owns content. Surfaces, action schemas, observation schemas
 *   and handlers all arrive through `defineSurface`, whose output is branded —
 *   so a plain object shaped like a surface will not compile.
 *
 *   Violations fail at compile time with a message naming the offending id.
 */
import type { OUITransport, OUITransportConfig } from "../transport/types.js";
import type { SocketLike } from "../transport/websocket.js";
import { createWebSocketTransport } from "../transport/websocket.js";
import type { DefinedSurface } from "./define-surface.js";
import { brand, type OUIBranded } from "./brand.js";
import type { OUIConfigError, ValidateSurfaceIds } from "./validate.js";
import type { OUISurface } from "../spec/index.js";

/** A transport OUI constructed. Integrators cannot produce one. */
export type OwnedTransport = OUITransport & OUIBranded<"transport">;

/** Surface ids as literal types, for the duplicate check. */
type SurfaceIds<T extends readonly DefinedSurface<never>[]> = {
  [K in keyof T]: T[K]["id"];
};

export interface OUIConfig<TSurfaces extends readonly DefinedSurface<never>[]> {
  /**
   * The socket OUI will speak over. The integrator owns the connection —
   * auth, reconnection, lifecycle — and OUI owns what travels on it.
   */
  socket: SocketLike;

  /**
   * Surfaces produced by `defineSurface`. A plain object with the same shape
   * will not compile: DefinedSurface is branded.
   */
  surfaces: TSurfaces;

  /**
   * Wire configuration. `namespace` defaults to 'oui' and is the supported way
   * to change the event prefix — hardcoding it at the call site is what made
   * this option unreachable in the first integration.
   */
  transport?: Omit<OUITransportConfig, "namespace"> & { namespace?: string };
}

/** A live OUI instance. */
export interface OUIInstance {
  /** The transport OUI owns. Exposed for wiring, not for reimplementation. */
  readonly transport: OwnedTransport;

  /** Manifests for every registered surface, as the agent sees them. */
  readonly manifests: readonly OUISurface[];

  /** Register every surface and connect. */
  start(): Promise<void>;

  /** Deregister every surface and disconnect. */
  stop(): void;

  /** Look up a registered surface by id. */
  getSurface(id: string): DefinedSurface<never> | undefined;
}

/**
 * Instantiate OUI.
 *
 * `const` on the type parameter captures surface ids as literal types, which is
 * what allows duplicate detection to name the offending id rather than failing
 * with an unassignable-to-never error.
 */
export function createOUI<
  const TSurfaces extends readonly DefinedSurface<never>[],
>(
  config: OUIConfig<TSurfaces> & ValidateSurfaceIds<SurfaceIds<TSurfaces>>,
): OUIInstance {
  const {
    socket,
    surfaces,
    transport: transportConfig,
  } = config as OUIConfig<TSurfaces>;

  // Defensive, not decorative: the compile-time checks only bind when a caller
  // passes literals. A surface list assembled at runtime, or JS with no types
  // at all, reaches here unchecked.
  if (!socket) {
    throw new Error(
      "[OUI] createOUI requires a socket. OUI owns the wire; the integrator owns the connection.",
    );
  }
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw new Error("[OUI] createOUI requires at least one surface.");
  }

  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (seen.has(surface.id)) {
      throw new Error(
        `[OUI] Duplicate surface id "${surface.id}". Registration is keyed by id, so the second would replace the first.`,
      );
    }
    seen.add(surface.id);
  }

  const transport = brand<"transport", OUITransport>(
    createWebSocketTransport(socket, transportConfig),
  );

  const byId = new Map(surfaces.map((s) => [s.id, s] as const));

  return {
    transport,
    manifests: surfaces.map((s) => s.toManifest()),

    async start() {
      await transport.connect();
      for (const surface of surfaces) {
        transport.registerSurface(surface.toManifest());
      }
    },

    stop() {
      for (const surface of surfaces) {
        transport.deregisterSurface(surface.id);
      }
      transport.disconnect();
    },

    getSurface(id) {
      return byId.get(id);
    },
  };
}

/** Re-exported so integrators can name the error type in tests. */
export type { OUIConfigError };
