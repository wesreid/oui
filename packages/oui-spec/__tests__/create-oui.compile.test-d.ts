/**
 * Compile-time contract for createOUI.
 *
 * Every `@ts-expect-error` below is a requirement: the line MUST fail to
 * compile, and tsc reports an error if it does not. That inverts the usual
 * risk — a validation that silently stops working becomes a build failure
 * rather than a guarantee nobody notices is gone.
 *
 * These exist because OUI's first integrator satisfied every type in the
 * package without using any of its runtime: `SocketLike` was importable and
 * `OUITransport` was a plain interface, so studio-ui rebuilt the wire by hand
 * and both ends agreed only by matching string literals.
 *
 * Checked with `npm run typecheck:contract`.
 */
import { createOUI, defineSurface } from '../src/core/index.js';
import type { OwnedTransport } from '../src/core/index.js';
import type { OUITransport } from '../src/transport/types.js';
import type { SocketLike } from '../src/transport/websocket.js';

const socket = {} as SocketLike;

const alpha = defineSurface({ id: 'alpha', name: 'Alpha', description: 'd', actions: [] });
const beta = defineSurface({ id: 'beta', name: 'Beta', description: 'd', actions: [] });
const alphaAgain = defineSurface({ id: 'alpha', name: 'Other', description: 'd', actions: [] });

// ─── The valid case compiles ─────────────────────────────────────────────────

const oui = createOUI({ socket, surfaces: [alpha, beta] });
void oui.manifests;
void oui.transport;

// A namespace other than the default is supported configuration, not a
// call-site literal — hardcoding it is what made the option unreachable.
void createOUI({ socket, surfaces: [alpha], transport: { namespace: 'myapp' } });

// ─── Every requirement fails at compile time ─────────────────────────────────

// Duplicate surface ids: registration is keyed by id, so the second replaces
// the first and the agent sees one surface's actions under the other's name.
// @ts-expect-error — Duplicate surface id: "alpha"
createOUI({ socket, surfaces: [alpha, alphaAgain] });

// No surfaces: registers nothing, dispatches nowhere, looks connected.
// @ts-expect-error — createOUI requires at least one surface
createOUI({ socket, surfaces: [] });

// No socket: OUI owns the wire, the integrator owns the connection.
// @ts-expect-error — Property 'socket' is missing
createOUI({ surfaces: [alpha] });

// A surface that never went through defineSurface skipped its validation and
// has no real manifest. Structural typing would have accepted this.
const handRolled = {
  id: 'gamma',
  name: 'Gamma',
  description: 'd',
  actions: [],
  toManifest: () => ({}) as never,
  executeAction: async () => ({}) as never,
  getActionIds: () => [] as string[],
  getPollingConfig: () => undefined,
};
// @ts-expect-error — Property '[OUI_BRAND]' is missing
createOUI({ socket, surfaces: [handRolled] });

// A transport OUI did not construct cannot stand in for one it did. This is
// the specific hole studio-ui went through.
const foreign = {} as OUITransport;
// @ts-expect-error — Property '[OUI_BRAND]' is missing in type 'OUITransport'
const stolen: OwnedTransport = foreign;
void stolen;
