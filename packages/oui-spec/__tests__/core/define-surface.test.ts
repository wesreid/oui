import { defineSurface } from '../../src/core/define-surface.js';
import type { ActionDefinition, SurfaceDefinition } from '../../src/core/define-surface.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface TestContext {
  userId: string;
  db: { get: (id: string) => Promise<unknown> };
}

function makeAction(overrides: Partial<ActionDefinition<TestContext>> = {}): ActionDefinition<TestContext> {
  return {
    id: 'test_action',
    description: 'A test action',
    input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (params) => ({ success: true, data: { received: params } }),
    ...overrides,
  };
}

function makeSurface(overrides: Partial<SurfaceDefinition<TestContext>> = {}): SurfaceDefinition<TestContext> {
  return {
    id: 'test-surface',
    name: 'Test Surface',
    description: 'A surface for testing',
    actions: [makeAction()],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('defineSurface()', () => {
  it('returns a valid DefinedSurface with all expected methods', () => {
    const surface = defineSurface(makeSurface());

    expect(surface.id).toBe('test-surface');
    expect(surface.name).toBe('Test Surface');
    expect(surface.description).toBe('A surface for testing');
    expect(surface.actions).toHaveLength(1);
    expect(typeof surface.toManifest).toBe('function');
    expect(typeof surface.executeAction).toBe('function');
    expect(typeof surface.getActionIds).toBe('function');
    expect(typeof surface.getPollingConfig).toBe('function');
  });

  it('preserves optional fields (version, activation, metadata, observations)', () => {
    const surface = defineSurface(makeSurface({
      version: '1.2.3',
      activation: { routes: '/dashboard', condition: 'user logged in' },
      metadata: { tier: 'pro' },
      observations: [{ id: 'obs1', description: 'An observation', schema: { type: 'string' } }],
    }));

    expect(surface.version).toBe('1.2.3');
    expect(surface.activation).toEqual({ routes: '/dashboard', condition: 'user logged in' });
    expect(surface.metadata).toEqual({ tier: 'pro' });
    expect(surface.observations).toHaveLength(1);
  });

  describe('validation', () => {
    it('throws on duplicate action IDs', () => {
      expect(() =>
        defineSurface(makeSurface({
          actions: [
            makeAction({ id: 'duplicate' }),
            makeAction({ id: 'duplicate', description: 'Second one' }),
          ],
        })),
      ).toThrow('[OUI] Duplicate action ID "duplicate" in surface "test-surface"');
    });

    it('throws on duplicate observation IDs', () => {
      expect(() =>
        defineSurface(makeSurface({
          observations: [
            { id: 'obs_dup', description: 'First', schema: { type: 'number' } },
            { id: 'obs_dup', description: 'Second', schema: { type: 'string' } },
          ],
        })),
      ).toThrow('[OUI] Duplicate observation ID "obs_dup" in surface "test-surface"');
    });

    it('allows distinct action IDs without error', () => {
      expect(() =>
        defineSurface(makeSurface({
          actions: [
            makeAction({ id: 'action_a' }),
            makeAction({ id: 'action_b' }),
            makeAction({ id: 'action_c' }),
          ],
        })),
      ).not.toThrow();
    });

    it('allows distinct observation IDs without error', () => {
      expect(() =>
        defineSurface(makeSurface({
          observations: [
            { id: 'obs_a', description: 'A', schema: { type: 'string' } },
            { id: 'obs_b', description: 'B', schema: { type: 'number' } },
          ],
        })),
      ).not.toThrow();
    });
  });

  describe('toManifest()', () => {
    it('returns an OUISurface without handler functions', () => {
      const surface = defineSurface(makeSurface({
        version: '2.0.0',
        actions: [
          makeAction({ id: 'action_with_handler' }),
        ],
        observations: [
          { id: 'obs1', description: 'Obs', schema: { type: 'boolean' }, getValue: () => true },
        ],
      }));

      const manifest = surface.toManifest();

      // Actions should have schema fields but no handler
      expect(manifest.actions[0].id).toBe('action_with_handler');
      expect(manifest.actions[0].description).toBe('A test action');
      expect(manifest.actions[0].input).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
      expect((manifest.actions[0] as any).handler).toBeUndefined();

      // Observations should have schema fields but no getValue
      expect(manifest.observations![0].id).toBe('obs1');
      expect(manifest.observations![0].schema).toEqual({ type: 'boolean' });
      expect((manifest.observations![0] as any).getValue).toBeUndefined();
    });

    it('preserves all action metadata fields in manifest', () => {
      const surface = defineSurface(makeSurface({
        actions: [
          makeAction({
            id: 'full_action',
            output: { type: 'object', properties: { result: { type: 'string' } } },
            confirm: true,
            async: true,
            polling: { intervalMs: 2000, maxAttempts: 10 },
            usage: 'Use when X',
            preconditions: 'User must be admin',
            estimatedDuration: '2-5s',
            tags: ['admin', 'destructive'],
          }),
        ],
      }));

      const action = surface.toManifest().actions[0];
      expect(action.output).toEqual({ type: 'object', properties: { result: { type: 'string' } } });
      expect(action.confirm).toBe(true);
      expect(action.async).toBe(true);
      expect(action.polling).toEqual({ intervalMs: 2000, maxAttempts: 10 });
      expect(action.usage).toBe('Use when X');
      expect(action.preconditions).toBe('User must be admin');
      expect(action.estimatedDuration).toBe('2-5s');
      expect(action.tags).toEqual(['admin', 'destructive']);
    });

    it('preserves surface-level fields in manifest', () => {
      const surface = defineSurface(makeSurface({
        version: '3.0.0',
        activation: { routes: ['/a', '/b'], entity: { type: 'project', id: 'p-123' } },
        metadata: { capabilities: ['edit', 'delete'] },
      }));

      const manifest = surface.toManifest();
      expect(manifest.id).toBe('test-surface');
      expect(manifest.name).toBe('Test Surface');
      expect(manifest.description).toBe('A surface for testing');
      expect(manifest.version).toBe('3.0.0');
      expect(manifest.activation).toEqual({ routes: ['/a', '/b'], entity: { type: 'project', id: 'p-123' } });
      expect(manifest.metadata).toEqual({ capabilities: ['edit', 'delete'] });
    });

    it('returns undefined for observations when none are defined', () => {
      const surface = defineSurface(makeSurface({ observations: undefined }));
      const manifest = surface.toManifest();
      expect(manifest.observations).toBeUndefined();
    });
  });

  describe('executeAction()', () => {
    it('calls the correct handler with the provided params and context', async () => {
      const handler = vi.fn(async (params: Record<string, unknown>, context: TestContext) => ({
        success: true,
        data: { name: params.name, user: context.userId },
      }));

      const surface = defineSurface(makeSurface({
        actions: [makeAction({ id: 'greet', handler })],
      }));

      const ctx: TestContext = { userId: 'user-42', db: { get: vi.fn() } };
      const result = await surface.executeAction('greet', { name: 'World' }, ctx);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ name: 'World' }, ctx);
      expect(result).toEqual({ success: true, data: { name: 'World', user: 'user-42' } });
    });

    it('routes to the correct handler among multiple actions', async () => {
      const handlerA = vi.fn(async () => ({ success: true, data: 'A' }));
      const handlerB = vi.fn(async () => ({ success: true, data: 'B' }));

      const surface = defineSurface(makeSurface({
        actions: [
          makeAction({ id: 'action_a', handler: handlerA }),
          makeAction({ id: 'action_b', handler: handlerB }),
        ],
      }));

      const ctx: TestContext = { userId: 'u', db: { get: vi.fn() } };
      const result = await surface.executeAction('action_b', {}, ctx);

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledOnce();
      expect(result).toEqual({ success: true, data: 'B' });
    });

    it('returns error result for unknown action ID', async () => {
      const surface = defineSurface(makeSurface());
      const ctx: TestContext = { userId: 'u', db: { get: vi.fn() } };
      const result = await surface.executeAction('nonexistent', {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('ACTION_NOT_FOUND');
      expect(result.error!.message).toContain('nonexistent');
      expect(result.error!.message).toContain('test-surface');
    });

    it('catches handler exceptions and returns error result with Error message', async () => {
      const surface = defineSurface(makeSurface({
        actions: [makeAction({
          id: 'throws',
          handler: async () => { throw new Error('Database connection failed'); },
        })],
      }));

      const ctx: TestContext = { userId: 'u', db: { get: vi.fn() } };
      const result = await surface.executeAction('throws', {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('ACTION_EXECUTION_ERROR');
      expect(result.error!.message).toBe('Database connection failed');
    });

    it('catches non-Error throws and stringifies them', async () => {
      const surface = defineSurface(makeSurface({
        actions: [makeAction({
          id: 'throws_string',
          handler: async () => { throw 'raw string error'; },
        })],
      }));

      const ctx: TestContext = { userId: 'u', db: { get: vi.fn() } };
      const result = await surface.executeAction('throws_string', {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('ACTION_EXECUTION_ERROR');
      expect(result.error!.message).toBe('raw string error');
    });

    it('returns handler result including dispatchMeta for async actions', async () => {
      const surface = defineSurface(makeSurface({
        actions: [makeAction({
          id: 'async_action',
          async: true,
          polling: { intervalMs: 1000 },
          handler: async () => ({
            success: true,
            data: { status: 'dispatched' },
            dispatchMeta: { jobId: 'job-123' },
          }),
        })],
      }));

      const ctx: TestContext = { userId: 'u', db: { get: vi.fn() } };
      const result = await surface.executeAction('async_action', {}, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status: 'dispatched' });
      expect(result.dispatchMeta).toEqual({ jobId: 'job-123' });
    });
  });

  describe('getActionIds()', () => {
    it('returns all action IDs', () => {
      const surface = defineSurface(makeSurface({
        actions: [
          makeAction({ id: 'create_item' }),
          makeAction({ id: 'update_item' }),
          makeAction({ id: 'delete_item' }),
        ],
      }));

      expect(surface.getActionIds()).toEqual(['create_item', 'update_item', 'delete_item']);
    });

    it('returns empty array when no actions defined', () => {
      const surface = defineSurface(makeSurface({ actions: [] }));
      expect(surface.getActionIds()).toEqual([]);
    });
  });

  describe('getPollingConfig()', () => {
    it('returns polling config for async actions with polling defined', () => {
      const polling = { intervalMs: 5000, maxAttempts: 20, maxDurationMs: 60000 };
      const surface = defineSurface(makeSurface({
        actions: [makeAction({ id: 'long_running', async: true, polling })],
      }));

      const config = surface.getPollingConfig('long_running');
      expect(config).toEqual(polling);
    });

    it('returns polling config with subscribe configuration', () => {
      const polling = {
        intervalMs: 2000,
        subscribe: { event: 'job:complete', filter: { jobId: '$dispatchResult.jobId' } },
      };
      const surface = defineSurface(makeSurface({
        actions: [makeAction({ id: 'subscribed_action', async: true, polling })],
      }));

      const config = surface.getPollingConfig('subscribed_action');
      expect(config).toEqual(polling);
      expect(config!.subscribe!.event).toBe('job:complete');
      expect(config!.subscribe!.filter).toEqual({ jobId: '$dispatchResult.jobId' });
    });

    it('returns undefined for sync actions (no polling)', () => {
      const surface = defineSurface(makeSurface({
        actions: [makeAction({ id: 'sync_action' })],
      }));

      expect(surface.getPollingConfig('sync_action')).toBeUndefined();
    });

    it('returns undefined for unknown action ID', () => {
      const surface = defineSurface(makeSurface());
      expect(surface.getPollingConfig('nonexistent')).toBeUndefined();
    });
  });
});
