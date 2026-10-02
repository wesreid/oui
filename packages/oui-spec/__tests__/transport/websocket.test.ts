import { createWebSocketTransport } from '../../src/transport/websocket.js';
import type { SocketLike } from '../../src/transport/websocket.js';
import type { OUIObservationUpdate, OUISurface } from '../../src/spec/types.js';

let reqSeq = 0;
function req(surfaceId: string, actionId: string, params: Record<string, unknown>) {
  return { requestId: `r${++reqSeq}`, surfaceId, actionId, params, timestamp: Date.now() };
}

// ─── Mock Socket ─────────────────────────────────────────────────────────────

type Listener = (...args: any[]) => void;

function createMockSocket(opts: { connected?: boolean } = {}): SocketLike & {
  _listeners: Map<string, Listener[]>;
  _emit: (event: string, ...args: any[]) => void;
  _emitted: Array<{ event: string; data: unknown; ack?: Listener }>;
} {
  const listeners = new Map<string, Listener[]>();
  const emitted: Array<{ event: string; data: unknown; ack?: Listener }> = [];

  const socket: SocketLike & {
    _listeners: Map<string, Listener[]>;
    _emit: (event: string, ...args: any[]) => void;
    _emitted: Array<{ event: string; data: unknown; ack?: Listener }>;
  } = {
    connected: opts.connected ?? true,
    _listeners: listeners,
    _emitted: emitted,

    emit(event: string, data: unknown, ack?: Listener) {
      emitted.push(typeof ack === 'function' ? { event, data, ack } : { event, data });
    },

    on(event: string, handler: Listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },

    off(event: string, handler: Listener) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },

    once(event: string, handler: Listener) {
      const wrapped: Listener = (...args) => {
        socket.off(event, wrapped);
        handler(...args);
      };
      socket.on(event, wrapped);
    },

    connect() {
      // simulate connecting
    },

    disconnect() {
      // simulate disconnecting
    },

    /** Simulate receiving an event from the remote side */
    _emit(event: string, ...args: any[]) {
      const handlers = listeners.get(event) ?? [];
      // Copy the array because once-handlers may mutate it during iteration
      [...handlers].forEach(h => h(...args));
    },
  };

  return socket;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSurfaceManifest(id = 'test-surface'): OUISurface {
  return {
    id,
    name: 'Test',
    description: 'A test surface',
    actions: [{ id: 'action1', description: 'Does thing', input: { type: 'object' } }],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createWebSocketTransport()', () => {
  it('creates a transport from a mock socket', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);

    expect(transport).toBeDefined();
    expect(typeof transport.dispatch).toBe('function');
    expect(typeof transport.onAction).toBe('function');
    expect(typeof transport.pushObservation).toBe('function');
    expect(typeof transport.onObservation).toBe('function');
    expect(typeof transport.registerSurface).toBe('function');
    expect(typeof transport.deregisterSurface).toBe('function');
    expect(typeof transport.connect).toBe('function');
    expect(typeof transport.disconnect).toBe('function');
    expect(transport.connected).toBe(true);
  });

  describe('dispatch()', () => {
    it('emits correct namespaced event with default prefix', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);

      transport.dispatch(req('surface-1', 'click_button', { x: 10 }));

      expect(socket._emitted).toHaveLength(1);
      expect(socket._emitted[0].event).toBe('oui:dispatch');
      expect(socket._emitted[0].data).toMatchObject({
        surfaceId: 'surface-1',
        actionId: 'click_button',
        params: { x: 10 },
      });
      expect((socket._emitted[0].data as any).timestamp).toBeTypeOf('number');
    });

    it('uses custom namespace prefix', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket, { namespace: 'studio' });

      transport.dispatch(req('s', 'a', {}));

      expect(socket._emitted[0].event).toBe('studio:dispatch');
    });
  });

  describe('onAction()', () => {
    it('listens for correct namespaced event and calls handler', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      transport.onAction(handler);
      socket._emit('oui:dispatch', { requestId: 'r-1', surfaceId: 's-1', actionId: 'do_thing', params: { key: 'val' } });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({ requestId: 'r-1', surfaceId: 's-1', actionId: 'do_thing', params: { key: 'val' } }));
      // No receipt was asked for.
      expect(handler.mock.calls[0][1]).toBeUndefined();
    });

    it('returns cleanup function that removes listener', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      const unsub = transport.onAction(handler);
      unsub();
      socket._emit('oui:dispatch', { requestId: 'r-x', surfaceId: 's', actionId: 'a', params: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it('uses custom namespace for listening', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket, { namespace: 'custom' });
      const handler = vi.fn();

      transport.onAction(handler);
      socket._emit('custom:dispatch', { requestId: 'r-y', surfaceId: 's', actionId: 'a', params: {} });

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('pushObservation()', () => {
    it('emits correct namespaced event', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const update: OUIObservationUpdate = {
        surfaceId: 'surf-1',
        observationId: 'cursor_pos',
        value: { x: 100, y: 200 },
        timestamp: 1234567890,
      };

      transport.pushObservation(update);

      expect(socket._emitted[0].event).toBe('oui:observation');
      expect(socket._emitted[0].data).toEqual(update);
    });
  });

  describe('onObservation()', () => {
    it('receives observation updates from the socket', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();
      const update: OUIObservationUpdate = {
        surfaceId: 'surf-1',
        observationId: 'selection',
        value: ['item-1'],
        timestamp: Date.now(),
      };

      transport.onObservation(handler);
      socket._emit('oui:observation', update);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(update);
    });
  });

  describe('surface lifecycle', () => {
    it('registerSurface emits correct event', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);

      transport.registerSurface(makeSurfaceManifest('my-surface'));

      expect(socket._emitted[0].event).toBe('oui:surface:register');
      expect((socket._emitted[0].data as any).surface.id).toBe('my-surface');
      expect((socket._emitted[0].data as any).timestamp).toBeTypeOf('number');
    });

    it('deregisterSurface emits correct event', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);

      transport.deregisterSurface('my-surface');

      expect(socket._emitted[0].event).toBe('oui:surface:deregister');
      expect((socket._emitted[0].data as any).surfaceId).toBe('my-surface');
      expect((socket._emitted[0].data as any).timestamp).toBeTypeOf('number');
    });

    it('onSurfaceRegister receives surface from event payload', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      transport.onSurfaceRegister(handler);
      socket._emit('oui:surface:register', { surface: makeSurfaceManifest('received-surface') });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].id).toBe('received-surface');
    });

    it('onSurfaceDeregister receives surfaceId from event payload', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      transport.onSurfaceDeregister(handler);
      socket._emit('oui:surface:deregister', { surfaceId: 'removed-surface' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('removed-surface');
    });
  });

  describe('buffering', () => {
    it('buffers messages when disconnected and bufferWhileDisconnected is true (default)', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);

      transport.dispatch(req('s', 'a', { queued: true }));
      transport.pushObservation({ surfaceId: 's', observationId: 'o', value: 1, timestamp: 1 });

      // Nothing emitted yet (socket disconnected)
      expect(socket._emitted).toHaveLength(0);
    });

    it('flushes buffer on connect', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);

      transport.dispatch(req('s', 'action1', { p: 1 }));
      transport.dispatch(req('s', 'action2', { p: 2 }));

      expect(socket._emitted).toHaveLength(0);

      // Simulate socket connection
      socket._emit('connect');

      // Buffer should be flushed — messages now emitted
      expect(socket._emitted).toHaveLength(2);
      expect(socket._emitted[0].event).toBe('oui:dispatch');
      expect((socket._emitted[0].data as any).actionId).toBe('action1');
      expect(socket._emitted[1].event).toBe('oui:dispatch');
      expect((socket._emitted[1].data as any).actionId).toBe('action2');
    });

    it('does not buffer when bufferWhileDisconnected is false', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket, { bufferWhileDisconnected: false });

      transport.dispatch(req('s', 'a', {}));
      transport.pushObservation({ surfaceId: 's', observationId: 'o', value: 1, timestamp: 1 });

      // Nothing buffered and nothing emitted
      expect(socket._emitted).toHaveLength(0);

      // Simulate connect — nothing flushed since nothing was buffered
      socket._emit('connect');
      expect(socket._emitted).toHaveLength(0);
    });

    it('respects maxBufferSize and drops excess messages', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket, { maxBufferSize: 3 });

      // Try to queue 5 messages (limit is 3)
      for (let i = 0; i < 5; i++) {
        transport.dispatch(req('s', `action_${i}`, {}));
      }

      // Simulate connect — only first 3 should flush
      socket._emit('connect');
      expect(socket._emitted).toHaveLength(3);
      expect((socket._emitted[0].data as any).actionId).toBe('action_0');
      expect((socket._emitted[2].data as any).actionId).toBe('action_2');
    });
  });

  describe('connection state tracking', () => {
    it('reports connected: true when socket starts connected', () => {
      const socket = createMockSocket({ connected: true });
      const transport = createWebSocketTransport(socket);
      expect(transport.connected).toBe(true);
    });

    it('reports connected: false when socket starts disconnected', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);
      expect(transport.connected).toBe(false);
    });

    it('updates connected state on connect/disconnect events', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);

      expect(transport.connected).toBe(false);

      socket._emit('connect');
      expect(transport.connected).toBe(true);

      socket._emit('disconnect');
      expect(transport.connected).toBe(false);
    });

    it('onConnectionChange fires on connect/disconnect', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      transport.onConnectionChange(handler);
      socket._emit('connect');
      expect(handler).toHaveBeenCalledWith(true);

      socket._emit('disconnect');
      expect(handler).toHaveBeenCalledWith(false);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('onConnectionChange cleanup removes the handler', () => {
      const socket = createMockSocket({ connected: false });
      const transport = createWebSocketTransport(socket);
      const handler = vi.fn();

      const unsub = transport.onConnectionChange(handler);
      unsub();

      socket._emit('connect');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('disconnect()', () => {
    it('calls socket.disconnect', () => {
      const socket = createMockSocket();
      socket.disconnect = vi.fn();
      const transport = createWebSocketTransport(socket);

      transport.disconnect();

      expect(socket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe('custom namespace prefix', () => {
    it('all events use the custom namespace', () => {
      const socket = createMockSocket();
      const transport = createWebSocketTransport(socket, { namespace: 'myapp' });

      transport.dispatch(req('s', 'a', {}));
      transport.pushObservation({ surfaceId: 's', observationId: 'o', value: 1, timestamp: 1 });
      transport.registerSurface(makeSurfaceManifest());
      transport.deregisterSurface('s');

      const events = socket._emitted.map(e => e.event);
      expect(events).toEqual([
        'myapp:dispatch',
        'myapp:observation',
        'myapp:surface:register',
        'myapp:surface:deregister',
      ]);
    });
  });
});

describe('a result, acknowledged (§7.3.6)', () => {
  const result = { requestId: 'r', success: true, timestamp: 1 };

  it('hands the receiver an acknowledgment, and reports what it said: received, or refused and why', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);
    const acks: unknown[] = [];
    transport.sendResult(result, ack => acks.push(ack));
    const [sent] = socket._emitted;
    expect(sent.event).toBe('oui:action:result');
    sent.ack!({ ok: true, kept: true });
    sent.ack!({ ok: false, error: 'payload larger than 524288 bytes' });
    sent.ack!({ ok: false, reason: 'not in the room' });
    sent.ack!({ ok: false });
    sent.ack!(undefined);
    sent.ack!('yes');
    expect(acks).toEqual([
      { ok: true },
      { ok: false, reason: 'payload larger than 524288 bytes' },
      { ok: false, reason: 'not in the room' },
      { ok: false, reason: 'refused' },
    ]);
  });

  it('sends no acknowledgment callback when none is asked for', () => {
    const socket = createMockSocket();
    createWebSocketTransport(socket).sendResult(result);
    expect(socket._emitted[0]).not.toHaveProperty('ack');
  });

  it('keeps the acknowledgment of an answer queued while disconnected', () => {
    const socket = createMockSocket({ connected: false });
    const transport = createWebSocketTransport(socket);
    const acks: unknown[] = [];
    transport.sendResult(result, ack => acks.push(ack));
    expect(socket._emitted).toHaveLength(0);
    socket._emit('connect');
    socket._emitted[0].ack!({ ok: false, error: 'too large' });
    expect(acks).toEqual([{ ok: false, reason: 'too large' }]);
  });

  it('acknowledges receipt of a request when the sender asks, and refuses one it cannot answer', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);
    transport.onAction((_r, receipt) => receipt?.({ ok: true }));
    const receipts: unknown[] = [];
    socket._emit('oui:dispatch', req('s', 'a', {}), (r: unknown) => receipts.push(r));
    socket._emit('oui:dispatch', { surfaceId: 's', actionId: 'a' }, (r: unknown) => receipts.push(r));
    expect(receipts).toEqual([{ ok: true }, { ok: false, reason: 'a request needs requestId, surfaceId and actionId' }]);
  });

  it('passes on the surfaces the agent runtime holds, and nothing that is not a hash', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);
    const got: unknown[] = [];
    transport.onAction(r => got.push(r.knownSurfaces));
    socket._emit('oui:dispatch', { ...req('s', 'a', {}), knownSurfaces: 'fnv1a64:0123456789abcdef' });
    socket._emit('oui:dispatch', { ...req('s', 'a', {}), knownSurfaces: 42 });
    expect(got).toEqual(['fnv1a64:0123456789abcdef', undefined]);
  });
});
