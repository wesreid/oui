import { createDirectTransportPair } from '../../src/transport/direct.js';
import type { OUIObservationUpdate, OUISurface } from '../../src/spec/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSurfaceManifest(id = 'test-surface'): OUISurface {
  return {
    id,
    name: 'Test Surface',
    description: 'A surface for testing',
    actions: [{ id: 'do_thing', description: 'Does the thing', input: { type: 'object' } }],
  };
}

function makeObservationUpdate(overrides: Partial<OUIObservationUpdate> = {}): OUIObservationUpdate {
  return {
    surfaceId: 'test-surface',
    observationId: 'current_selection',
    value: { itemId: 'item-1' },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createDirectTransportPair()', () => {
  it('returns an object with server and client transport instances', () => {
    const { server, client } = createDirectTransportPair();

    expect(server).toBeDefined();
    expect(client).toBeDefined();
    expect(typeof server.dispatch).toBe('function');
    expect(typeof server.onAction).toBe('function');
    expect(typeof server.pushObservation).toBe('function');
    expect(typeof server.onObservation).toBe('function');
    expect(typeof server.registerSurface).toBe('function');
    expect(typeof server.deregisterSurface).toBe('function');
    expect(typeof server.onSurfaceRegister).toBe('function');
    expect(typeof server.onSurfaceDeregister).toBe('function');
    expect(typeof client.dispatch).toBe('function');
    expect(typeof client.onAction).toBe('function');
    expect(typeof client.pushObservation).toBe('function');
    expect(typeof client.onObservation).toBe('function');
    expect(typeof client.registerSurface).toBe('function');
    expect(typeof client.deregisterSurface).toBe('function');
  });

  describe('dispatch channel (server → client)', () => {
    it('server dispatch reaches client onAction handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      client.onAction(handler);
      server.dispatch('my-surface', 'click_button', { target: '#btn' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('my-surface', 'click_button', { target: '#btn' });
    });

    it('supports multiple onAction handlers', () => {
      const { server, client } = createDirectTransportPair();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      client.onAction(handler1);
      client.onAction(handler2);
      server.dispatch('s', 'a', { x: 1 });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('delivers dispatch params exactly as provided', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();
      client.onAction(handler);

      const complexParams = {
        nested: { deep: { value: [1, 2, 3] } },
        special: null,
        empty: '',
      };
      server.dispatch('surface-x', 'complex_action', complexParams);

      expect(handler).toHaveBeenCalledWith('surface-x', 'complex_action', complexParams);
    });
  });

  describe('observation channel (client → server)', () => {
    it('client pushObservation reaches server onObservation handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();
      const update = makeObservationUpdate();

      server.onObservation(handler);
      client.pushObservation(update);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(update);
    });

    it('supports multiple onObservation handlers', () => {
      const { server, client } = createDirectTransportPair();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      server.onObservation(handler1);
      server.onObservation(handler2);
      client.pushObservation(makeObservationUpdate());

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe('surface lifecycle (client → server)', () => {
    it('client registerSurface reaches server onSurfaceRegister handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();
      const manifest = makeSurfaceManifest('wizard-surface');

      server.onSurfaceRegister(handler);
      client.registerSurface(manifest);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(manifest);
    });

    it('client deregisterSurface reaches server onSurfaceDeregister handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      server.onSurfaceDeregister(handler);
      client.deregisterSurface('wizard-surface');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('wizard-surface');
    });

    it('supports multiple surface lifecycle handlers', () => {
      const { server, client } = createDirectTransportPair();
      const regHandler1 = vi.fn();
      const regHandler2 = vi.fn();

      server.onSurfaceRegister(regHandler1);
      server.onSurfaceRegister(regHandler2);
      client.registerSurface(makeSurfaceManifest());

      expect(regHandler1).toHaveBeenCalledOnce();
      expect(regHandler2).toHaveBeenCalledOnce();
    });
  });

  describe('unsubscribe (cleanup functions)', () => {
    it('onAction cleanup properly unsubscribes the handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      const unsub = client.onAction(handler);
      server.dispatch('s', 'a', {});
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      server.dispatch('s', 'a', {});
      expect(handler).toHaveBeenCalledOnce(); // not called again
    });

    it('onObservation cleanup properly unsubscribes the handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      const unsub = server.onObservation(handler);
      client.pushObservation(makeObservationUpdate());
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      client.pushObservation(makeObservationUpdate());
      expect(handler).toHaveBeenCalledOnce();
    });

    it('onSurfaceRegister cleanup properly unsubscribes the handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      const unsub = server.onSurfaceRegister(handler);
      client.registerSurface(makeSurfaceManifest());
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      client.registerSurface(makeSurfaceManifest());
      expect(handler).toHaveBeenCalledOnce();
    });

    it('onSurfaceDeregister cleanup properly unsubscribes the handler', () => {
      const { server, client } = createDirectTransportPair();
      const handler = vi.fn();

      const unsub = server.onSurfaceDeregister(handler);
      client.deregisterSurface('s-1');
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      client.deregisterSurface('s-1');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('unsubscribing one handler does not affect other handlers', () => {
      const { server, client } = createDirectTransportPair();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = client.onAction(handler1);
      client.onAction(handler2);

      unsub1();
      server.dispatch('s', 'a', {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe('connection state', () => {
    it('both sides report connected: true', () => {
      const { server, client } = createDirectTransportPair();
      expect(server.connected).toBe(true);
      expect(client.connected).toBe(true);
    });

    it('connect() resolves immediately', async () => {
      const { server, client } = createDirectTransportPair();
      await expect(server.connect()).resolves.toBeUndefined();
      await expect(client.connect()).resolves.toBeUndefined();
    });

    it('disconnect() does not throw', () => {
      const { server, client } = createDirectTransportPair();
      expect(() => server.disconnect()).not.toThrow();
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});
