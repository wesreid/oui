# @oui/transport

**Two one-way channels. Dispatch goes down. Observations go up.**

The transport layer implements the OUI wire protocol — the actual delivery mechanism for action dispatches and observation updates between agent runtimes and UI surfaces. It provides WebSocket (Socket.IO) and direct (in-memory) implementations of the `OUITransport` interface.

---

## Install

```bash
pnpm add @oui/transport
```

---

## The Two-Channel Model

OUI does **not** use request/response. Instead, it defines two independent, one-directional channels:

```
┌────────────────────────────────────────────────────────────────┐
│  DISPATCH CHANNEL (server → client)                            │
│                                                                │
│  Agent Lambda fires an action instruction at the UI.           │
│  Lambda terminates immediately. No waiting. No correlation.    │
│                                                                │
│  dispatch(surfaceId, actionId, params) ──────────────► browser │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  OBSERVATION CHANNEL (client → server)                         │
│                                                                │
│  Browser pushes state updates as observations.                 │
│  The agent reads them on its next invocation.                  │
│                                                                │
│  browser ──────────────► pushObservation(update) ──► agent DB  │
└────────────────────────────────────────────────────────────────┘
```

This architecture exists because:
- Agent Lambdas have finite execution time (30s timeout)
- UI operations can take minutes (file uploads, ML inference, user confirmations)
- Request/response forces the Lambda to block — OUI doesn't

---

## `OUITransport` Interface

Every transport implements this interface:

```typescript
interface OUITransport {
  // ─── Dispatch Channel (server → client) ─────────────────────
  dispatch(surfaceId: string, actionId: string, params: Record<string, unknown>): void;
  onAction(handler: OUIActionHandler): () => void;

  // ─── Observation Channel (client → server) ──────────────────
  pushObservation(update: OUIObservationUpdate): void;
  onObservation(handler: OUIObservationHandler): () => void;

  // ─── Surface Lifecycle ──────────────────────────────────────
  registerSurface(surface: OUISurface): void;
  deregisterSurface(surfaceId: string): void;
  onSurfaceRegister(handler: (surface: OUISurface) => void): () => void;
  onSurfaceDeregister(handler: (surfaceId: string) => void): () => void;

  // ─── Connection ─────────────────────────────────────────────
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
}
```

All `on*` methods return an unsubscribe function for cleanup.

---

## WebSocket Transport

The primary transport for production use. Maps OUI protocol events to Socket.IO events with a configurable namespace prefix.

```typescript
import { createWebSocketTransport } from '@oui/transport';
import { io } from 'socket.io-client';

// Client side (browser)
const socket = io('wss://your-server.com', { path: '/oui' });
const transport = createWebSocketTransport(socket, {
  namespace: 'oui',           // Event prefix (default: 'oui')
  bufferWhileDisconnected: true,  // Queue messages during disconnects
  maxBufferSize: 100,         // Max queued messages before dropping
  connectTimeoutMs: 10000,    // Connection timeout
});

await transport.connect();

// Listen for dispatched actions
transport.onAction((surfaceId, actionId, params) => {
  console.log(`Action dispatched: ${surfaceId}/${actionId}`, params);
});

// Push an observation
transport.pushObservation({
  surfaceId: 'dataviz-wizard',
  observationId: 'wizard_state',
  value: { step: 'configure', chartType: 'bar' },
  timestamp: Date.now(),
});
```

### Socket.IO Events

With default namespace `oui`:

| Event | Direction | Payload |
|-------|-----------|---------|
| `oui:dispatch` | server → client | `{ surfaceId, actionId, params, timestamp }` |
| `oui:observation` | client → server | `OUIObservationUpdate` |
| `oui:surface:register` | client → server | `{ surface: OUISurface, timestamp }` |
| `oui:surface:deregister` | client → server | `{ surfaceId, timestamp }` |

### Server Side

```typescript
import { createWebSocketTransport } from '@oui/transport';

// In your Socket.IO server handler
io.on('connection', (socket) => {
  const transport = createWebSocketTransport(socket, { namespace: 'oui' });

  // Listen for surface registrations
  transport.onSurfaceRegister((surface) => {
    console.log(`Surface registered: ${surface.id}`);
    // Store manifest for agent runtime to read
  });

  // Listen for observations
  transport.onObservation((update) => {
    console.log(`Observation: ${update.surfaceId}/${update.observationId}`, update.value);
    // Persist for agent to read on next invocation
  });

  // Dispatch an action (from agent runtime)
  transport.dispatch('dataviz-wizard', 'render_chart', { quality: 'draft' });
});
```

---

## `SocketLike` Interface

The WebSocket transport doesn't depend on Socket.IO directly. It accepts any object implementing this minimal interface:

```typescript
interface SocketLike {
  readonly connected?: boolean;
  emit(event: string, data: unknown): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
  connect?(): void;
  disconnect?(): void;
}
```

This means you can use:
- Socket.IO client (`io()`)
- Socket.IO server socket (from `io.on('connection', socket => ...)`)
- Any custom WebSocket wrapper that implements these methods
- Mock sockets for testing

---

## Direct Transport (In-Memory)

For same-process communication (tests, API surfaces in Lambda, SSR) where the agent runtime and surface run in the same process:

```typescript
import { createDirectTransportPair } from '@oui/transport';

const { server, client } = createDirectTransportPair();

// Server side — dispatch actions and receive observations
server.onObservation((update) => {
  console.log('Got observation:', update);
});
server.dispatch('my-surface', 'do_thing', { name: 'test' });

// Client side — receive actions and push observations
client.onAction((surfaceId, actionId, params) => {
  console.log(`Action: ${surfaceId}/${actionId}`, params);
  // Execute and push result as observation
  client.pushObservation({
    surfaceId,
    observationId: `${surfaceId}:${actionId}:status`,
    value: { status: 'complete', data: { result: 42 } },
    timestamp: Date.now(),
  });
});
```

### Testing with Direct Transport

The direct transport makes testing surfaces trivial — no WebSocket server, no network, synchronous message delivery:

```typescript
import { createDirectTransportPair } from '@oui/transport';
import { datavizSurface } from './dataviz.surface';

describe('dataviz surface', () => {
  it('selects a dataset', async () => {
    const { server, client } = createDirectTransportPair();
    const observations: any[] = [];

    server.onObservation((update) => observations.push(update));

    // Register the surface
    client.registerSurface(datavizSurface.toManifest());

    // Dispatch an action (simulating agent)
    server.dispatch('dataviz-wizard', 'select_dataset', { datasetId: 'ds-001' });

    // Assert observations were pushed
    expect(observations).toContainEqual(
      expect.objectContaining({
        surfaceId: 'dataviz-wizard',
        observationId: expect.stringContaining('select_dataset'),
      })
    );
  });
});
```

### Direct Transport Characteristics

- Always connected (`connected: true`)
- Synchronous delivery — messages arrive in the same tick
- No buffering needed
- `connect()` / `disconnect()` are no-ops
- Paired: `server.dispatch()` → `client.onAction()` and `client.pushObservation()` → `server.onObservation()`

---

## Buffering Behavior

The WebSocket transport buffers messages while disconnected (configurable):

```typescript
const transport = createWebSocketTransport(socket, {
  bufferWhileDisconnected: true,  // default: true
  maxBufferSize: 100,             // default: 100
});
```

When disconnected:
- Outgoing messages are queued in memory
- When connection is re-established, buffered messages are flushed in order
- If the buffer exceeds `maxBufferSize`, new messages are dropped (oldest are retained)

When `bufferWhileDisconnected: false`:
- Messages sent while disconnected are silently dropped

---

## Connection Lifecycle

```typescript
const transport = createWebSocketTransport(socket);

// Monitor connection state
transport.onConnectionChange((connected) => {
  if (connected) {
    console.log('Transport connected — re-registering surfaces');
  } else {
    console.log('Transport disconnected — observations will buffer');
  }
});

// Connect (with timeout)
await transport.connect(); // throws if timeout exceeded

// Check state
console.log(transport.connected); // true

// Disconnect
transport.disconnect();
```

---

## Configuration

```typescript
interface OUITransportConfig {
  /** Event namespace prefix (default: 'oui') */
  namespace?: string;

  /** Connection timeout in ms (default: 10000) */
  connectTimeoutMs?: number;

  /** Buffer messages while disconnected (default: true) */
  bufferWhileDisconnected?: boolean;

  /** Max buffer size before dropping (default: 100) */
  maxBufferSize?: number;
}
```

---

## Exports

```typescript
// Transport interface
export type { OUITransport, OUIActionHandler, OUIObservationHandler, OUITransportConfig } from '@oui/transport';

// WebSocket implementation
export { createWebSocketTransport } from '@oui/transport';
export type { SocketLike } from '@oui/transport';

// Direct (in-memory) implementation
export { createDirectTransportPair } from '@oui/transport';
```

---

## License

MIT
