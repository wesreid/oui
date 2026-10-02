/**
 * MCP Tool Server and Surface Server — Integration Tests
 *
 * Uses InMemoryTransport + MCP Client to validate the full MCP protocol round-trip:
 * tools/list, tools/call, resources/list, resources/read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { UISurfaceSchema } from '@ouispec/agent-core';
import { createMCPToolServer, registerOUISurfaces } from '../server/tool-server.js';
import { createMCPServer } from '../server/adapter.js';
import { DEFAULT_SERVER_INFO } from '../server/server-info.js';
import {
  createMockRegistry,
  createMockApi,
  createMockSurface,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Shared harness: Server + Client connected via InMemoryTransport
// ---------------------------------------------------------------------------

function createTestHarness() {
  const registry = createMockRegistry();
  const api = createMockApi();
  const surface = createMockSurface();

  const { server, toolCount } = createMCPToolServer({ registry, api });
  const { resourceCount } = registerOUISurfaces({ server, surface });

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  return { server, client, toolCount, resourceCount, registry, api, surface };
}

async function connectHarness(harness: ReturnType<typeof createTestHarness>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    harness.server.connect(serverTransport),
    harness.client.connect(clientTransport),
  ]);
  return { clientTransport, serverTransport };
}

// ---------------------------------------------------------------------------
// Level 1: Unit — createMCPToolServer construction
// ---------------------------------------------------------------------------

describe('createMCPToolServer (unit)', () => {
  it('registers one MCP tool per intent in the registry', () => {
    const registry = createMockRegistry();
    const api = createMockApi();
    const { toolCount } = createMCPToolServer({ registry, api });
    expect(toolCount).toBe(3);
  });

  it('names itself neutrally when the product names nothing (no Closure default)', async () => {
    const { server } = createMCPToolServer({ registry: createMockRegistry(), api: createMockApi() });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerVersion()).toEqual(DEFAULT_SERVER_INFO);
    expect(DEFAULT_SERVER_INFO.name).toBe('agent-sdk-mcp');
    await client.close();
  });

  it("introduces itself with the product's serverInfo", async () => {
    const { server } = createMCPToolServer({
      registry: createMockRegistry(),
      api: createMockApi(),
      serverInfo: { name: 'custom-server', version: '2.0.0' },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerVersion()).toMatchObject({ name: 'custom-server', version: '2.0.0' });
    await client.close();
  });

  it('the protocol adapter names itself the same way', async () => {
    const adapter = createMCPServer({ registry: createMockRegistry(), api: createMockApi() });
    expect(await adapter.handleRequest('initialize')).toMatchObject({ serverInfo: DEFAULT_SERVER_INFO });
  });
});

// ---------------------------------------------------------------------------
// Level 1: Unit — registerOUISurfaces construction
// ---------------------------------------------------------------------------

describe('registerOUISurfaces (unit)', () => {
  it('registers resources for pages + modals + global actions + manifest', () => {
    const registry = createMockRegistry();
    const api = createMockApi();
    const surface = createMockSurface();
    const { server } = createMCPToolServer({ registry, api });
    const { resourceCount } = registerOUISurfaces({ server, surface });
    // 2 pages + 1 modal + 1 global-actions + 1 manifest = 5
    expect(resourceCount).toBe(5);
  });

  it('omits global-actions resource when there are no global actions', () => {
    const registry = createMockRegistry();
    const api = createMockApi();
    const surface = createMockSurface();
    surface.globalActions = [];
    const { server } = createMCPToolServer({ registry, api });
    const { resourceCount } = registerOUISurfaces({ server, surface });
    // 2 pages + 1 modal + 0 global-actions + 1 manifest = 4
    expect(resourceCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Level 2: Integration — Full MCP protocol round-trip
// ---------------------------------------------------------------------------

describe('MCP protocol integration (tools)', () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeAll(async () => {
    harness = createTestHarness();
    await connectHarness(harness);
  });

  afterAll(async () => {
    await harness.client.close();
    await harness.server.close();
  });

  it('tools/list returns all intents as MCP tools with correct structure', async () => {
    const result = await harness.client.listTools();
    expect(result.tools).toHaveLength(3);

    const toolNames = result.tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['create_clip', 'delete_clip', 'list_clips']);

    const createClip = result.tools.find(t => t.name === 'create_clip');
    expect(createClip).toBeDefined();
    expect(createClip!.description).toBe('Create a new video clip');
    expect(createClip!.inputSchema).toBeDefined();
    expect(createClip!.inputSchema.type).toBe('object');
    expect(createClip!.inputSchema.properties).toHaveProperty('title');
    expect(createClip!.inputSchema.properties).toHaveProperty('duration');
    expect(createClip!.inputSchema.required).toEqual(['title', 'duration']);
  });

  it('delete tool is annotated as destructive', async () => {
    const result = await harness.client.listTools();
    const deleteTool = result.tools.find(t => t.name === 'delete_clip');
    expect(deleteTool!.annotations).toBeDefined();
    expect(deleteTool!.annotations!.destructiveHint).toBe(true);
  });

  it('read-only tool (list_clips) is annotated as readOnly', async () => {
    const result = await harness.client.listTools();
    const listTool = result.tools.find(t => t.name === 'list_clips');
    expect(listTool!.annotations).toBeDefined();
    expect(listTool!.annotations!.readOnlyHint).toBe(true);
  });

  it('tools/call executes the intent and returns the result', async () => {
    const result = await harness.client.callTool({
      name: 'create_clip',
      arguments: { title: 'My Clip', duration: 60 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const textContent = result.content[0];
    expect(textContent.type).toBe('text');
    expect('text' in textContent && textContent.text).toBeDefined();

    const parsed = JSON.parse('text' in textContent ? textContent.text : '');
    expect(parsed.id).toBe('clip-001');
    expect(parsed.title).toBe('Test Clip');
  });

  it('tools/call returns isError for unknown tool', async () => {
    const result = await harness.client.callTool({
      name: 'nonexistent_tool',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const textContent = result.content[0];
    expect('text' in textContent && textContent.text).toContain('Unknown tool');
  });
});

describe('MCP protocol integration (tools — error handling)', () => {
  it('returns isError when intent execution fails with IntentResult.success=false', async () => {
    const registry = createMockRegistry();
    const api = createMockApi({
      executeResult: {
        success: false,
        error: { code: 'VALIDATION', message: 'Title is required' },
      },
    });

    const { server } = createMCPToolServer({ registry, api });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'create_clip',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const textContent = result.content[0];
    expect('text' in textContent && textContent.text).toContain('Title is required');

    await client.close();
    await server.close();
  });

  it('returns isError when intent execution throws', async () => {
    const registry = createMockRegistry();
    const api = createMockApi({
      executeError: new Error('Service unavailable'),
    });

    const { server } = createMCPToolServer({ registry, api });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'create_clip',
      arguments: { title: 'Fail', duration: 10 },
    });

    expect(result.isError).toBe(true);
    const textContent = result.content[0];
    expect('text' in textContent && textContent.text).toContain('Service unavailable');

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Level 2: Integration — Resources (OUI Surfaces)
// ---------------------------------------------------------------------------

describe('MCP protocol integration (resources)', () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeAll(async () => {
    harness = createTestHarness();
    await connectHarness(harness);
  });

  afterAll(async () => {
    await harness.client.close();
    await harness.server.close();
  });

  it('resources/list returns all surface resources', async () => {
    const result = await harness.client.listResources();
    expect(result.resources.length).toBe(5);

    const uris = result.resources.map(r => r.uri).sort();
    expect(uris).toEqual([
      'surface://global-actions',
      'surface://manifest',
      'surface://modals/confirm_delete',
      'surface://pages/clip_editor',
      'surface://pages/project_dashboard',
    ]);
  });

  it('resources/read returns page declaration as JSON', async () => {
    const result = await harness.client.readResource({ uri: 'surface://pages/clip_editor' });
    expect(result.contents).toHaveLength(1);

    const content = result.contents[0];
    expect(content.mimeType).toBe('application/json');
    expect('text' in content).toBe(true);

    const page = JSON.parse('text' in content ? content.text : '');
    expect(page.id).toBe('clip_editor');
    expect(page.route).toBe('/clips/:clipId/edit');
    expect(page.actions).toHaveLength(2);
    expect(page.forms).toHaveLength(1);
    expect(page.players).toHaveLength(1);
  });

  it('resources/read returns modal declaration as JSON', async () => {
    const result = await harness.client.readResource({ uri: 'surface://modals/confirm_delete' });
    const content = result.contents[0];
    const modal = JSON.parse('text' in content ? content.text : '');
    expect(modal.id).toBe('confirm_delete');
    expect(modal.actions).toHaveLength(2);
  });

  it('resources/read returns global actions as JSON array', async () => {
    const result = await harness.client.readResource({ uri: 'surface://global-actions' });
    const content = result.contents[0];
    const actions = JSON.parse('text' in content ? content.text : '');
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('open_search');
    expect(actions[1].id).toBe('toggle_theme');
  });

  it('resources/read returns full manifest', async () => {
    const result = await harness.client.readResource({ uri: 'surface://manifest' });
    const content = result.contents[0];
    const manifest = JSON.parse('text' in content ? content.text : '');
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.modals).toHaveLength(1);
    expect(manifest.globalActions).toHaveLength(2);
    expect(manifest.entityRoutes).toBeDefined();
    expect(manifest.entityRoutes.clip).toBe('/clips/:id/edit');
  });

  it('resources/read throws for unknown URI', async () => {
    await expect(
      harness.client.readResource({ uri: 'surface://pages/nonexistent' }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Level 3: Acceptance — Full server with tools + resources from realistic data
// ---------------------------------------------------------------------------

describe('MCP server acceptance (W11 D37)', () => {
  it('produces a fully functional MCP server from realistic registry + surface data', async () => {
    // 1. ARRANGE: Build a complete server from realistic fixtures
    const registry = createMockRegistry();
    const api = createMockApi();
    const surface = createMockSurface();

    const { server, toolCount } = createMCPToolServer({
      registry,
      api,
      serverInfo: { name: 'closure-studio', version: '2.7.0' },
    });
    const { resourceCount } = registerOUISurfaces({ server, surface });

    // Connect with a real MCP client
    const client = new Client({ name: 'acceptance-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // 2. ACT + ASSERT: Verify the full MCP protocol exchange

    // Verify tool catalogue completeness
    expect(toolCount).toBe(3);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(3);

    // Verify every intent has become a callable tool with a valid inputSchema
    for (const tool of tools.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }

    // Verify tool execution produces a valid result
    const callResult = await client.callTool({
      name: 'create_clip',
      arguments: { title: 'Acceptance Clip', duration: 120 },
    });
    expect(callResult.isError).toBeFalsy();
    expect(callResult.content.length).toBeGreaterThan(0);
    const payload = JSON.parse(
      'text' in callResult.content[0] ? callResult.content[0].text : '',
    );
    expect(payload.id).toBeTruthy();

    // Verify resource catalogue completeness
    expect(resourceCount).toBe(5);
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(5);
    for (const resource of resources.resources) {
      expect(resource.uri).toBeTruthy();
      expect(resource.name).toBeTruthy();
    }

    // Verify every resource is readable and returns valid JSON
    for (const resource of resources.resources) {
      const readResult = await client.readResource({ uri: resource.uri });
      expect(readResult.contents).toHaveLength(1);
      const content = readResult.contents[0];
      expect(content.mimeType).toBe('application/json');
      const parsed = JSON.parse('text' in content ? content.text : '');
      expect(parsed).toBeDefined();
    }

    // Verify the manifest resource contains the complete surface
    const manifestResult = await client.readResource({ uri: 'surface://manifest' });
    const manifest = JSON.parse(
      'text' in manifestResult.contents[0] ? manifestResult.contents[0].text : '',
    );
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.modals).toHaveLength(1);
    expect(manifest.globalActions).toHaveLength(2);
    expect(manifest.entityRoutes).toEqual({
      clip: '/clips/:id/edit',
      project: '/projects/:id',
    });

    await client.close();
    await server.close();
  });

  it('handles an empty registry gracefully (zero tools, manifest-only resources)', async () => {
    const baseRegistry = createMockRegistry();
    const emptyRegistry = {
      ...baseRegistry,
      intents: new Map() as typeof baseRegistry.intents,
      domains: new Map() as typeof baseRegistry.domains,
      entities: new Map() as typeof baseRegistry.entities,
    };
    const api = createMockApi();
    const surface: UISurfaceSchema = {
      pages: [],
      modals: [],
      globalActions: [],
    };

    const { server, toolCount } = createMCPToolServer({ registry: emptyRegistry, api });
    const { resourceCount } = registerOUISurfaces({ server, surface });

    expect(toolCount).toBe(0);
    // Only the manifest resource
    expect(resourceCount).toBe(1);

    const client = new Client({ name: 'empty-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(0);

    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(1);
    expect(resources.resources[0].uri).toBe('surface://manifest');

    await client.close();
    await server.close();
  });
});


