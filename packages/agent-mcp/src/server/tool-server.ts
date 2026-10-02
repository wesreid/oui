/**
 * MCP Tool Server — exposes Agent SDK CompiledIntents as MCP tools via @modelcontextprotocol/sdk.
 *
 * Each CompiledIntent in the SchemaRegistry becomes an MCP tool whose input schema
 * comes from the intent's toolDefinition.function.parameters (JSON Schema).
 * When a client calls the tool, execution is delegated to AgentApiSurface.executeIntent().
 *
 * Uses the low-level Server class (not McpServer) because our intent schemas are
 * JSON Schema objects, not Zod shapes. The low-level API gives us full control over
 * the tools/list and tools/call protocol handlers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { toCallToolResult } from './results.js';
import { DEFAULT_SERVER_INFO } from './server-info.js';
import type {
  SchemaRegistry,
  AgentApiSurface,
  CompiledIntent,
  UISurfaceSchema,
  PageDeclaration,
  ModalDeclaration,
} from '@ouispec/agent-core';

// ---------------------------------------------------------------------------
// Tool Server
// ---------------------------------------------------------------------------

export interface MCPToolServerConfig {
  /** The compiled schema registry containing intents to expose as MCP tools. */
  registry: SchemaRegistry;
  /** The API surface used to execute intents when tools are called. */
  api: AgentApiSurface;
  /** Server identification metadata. */
  serverInfo?: { name: string; version: string };
}

export interface MCPToolServerResult {
  /** The configured Server instance, ready for transport connection. */
  server: Server;
  /** Count of tools registered from the intent registry. */
  toolCount: number;
}

/**
 * Creates an MCP server with every CompiledIntent from the registry exposed as a tool.
 *
 * The returned server is not yet connected to any transport — call
 * `server.connect(transport)` to start serving.
 */
export function createMCPToolServer(config: MCPToolServerConfig): MCPToolServerResult {
  const { registry, api } = config;
  const info = config.serverInfo ?? DEFAULT_SERVER_INFO;

  const toolIndex = buildToolIndex(registry);

  const server = new Server(
    { name: info.name, version: info.version },
    { capabilities: { tools: {}, resources: {} } },
  );

  // tools/list — return the full tool catalogue built from intents
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...toolIndex.values()].map(entry => entry.tool),
  }));

  // tools/call — look up the intent and execute via the API surface
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeIntentForMCP(api, name, args ?? {}, toolIndex);
  });

  return { server, toolCount: toolIndex.size };
}

// ---------------------------------------------------------------------------
// Surface Server
// ---------------------------------------------------------------------------

export interface RegisterOUISurfacesConfig {
  /** An already-instantiated Server (e.g. from createMCPToolServer). */
  server: Server;
  /** The UI surface schema describing the application's pages, modals, and actions. */
  surface: UISurfaceSchema;
}

export interface RegisterOUISurfacesResult {
  /** Total number of MCP resources registered. */
  resourceCount: number;
}

/**
 * Registers ListResources and ReadResource handlers on the given Server that
 * expose every declarative element of a UISurfaceSchema as an MCP resource.
 *
 * Resource URI scheme:
 *   surface://pages/{pageId}        — a single page declaration
 *   surface://modals/{modalId}      — a single modal declaration
 *   surface://global-actions        — the global actions list
 *   surface://manifest              — the full surface manifest
 *
 * Call this after `createMCPToolServer` but before `server.connect(transport)`.
 */
export function registerOUISurfaces(config: RegisterOUISurfacesConfig): RegisterOUISurfacesResult {
  const { server, surface } = config;
  const resourceIndex = buildResourceIndex(surface);

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [...resourceIndex.values()].map(entry => ({
      uri: entry.uri,
      name: entry.name,
      description: entry.description,
      mimeType: 'application/json',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request): ReadResourceResult => {
    const { uri } = request.params;
    const entry = resourceIndex.get(uri);
    if (!entry) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(entry.data, null, 2),
      }],
    };
  });

  return { resourceCount: resourceIndex.size };
}

// ---------------------------------------------------------------------------
// Internal: Tool Index
// ---------------------------------------------------------------------------

interface ToolIndexEntry {
  intent: CompiledIntent;
  tool: Tool;
}

function buildToolIndex(registry: SchemaRegistry): Map<string, ToolIndexEntry> {
  const index = new Map<string, ToolIndexEntry>();

  for (const intent of registry.intents.values()) {
    index.set(intent.id, {
      intent,
      tool: intentToMCPTool(intent),
    });
  }

  return index;
}

function intentToMCPTool(intent: CompiledIntent): Tool {
  return {
    name: intent.id,
    description: intent.description,
    inputSchema: intent.toolDefinition.function.parameters as Tool['inputSchema'],
    annotations: buildToolAnnotations(intent),
  };
}

/**
 * Derives MCP ToolAnnotations from intent metadata.
 * Marks destructive intents (those that delete entities) as such.
 */
function buildToolAnnotations(intent: CompiledIntent): {
  title?: string;
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
} {
  const isDestructive = intent.outcome.deletes !== undefined;
  const isReadOnly =
    intent.outcome.produces === undefined &&
    intent.outcome.mutates === undefined &&
    intent.outcome.deletes === undefined;

  return {
    title: intent.id,
    ...(isDestructive ? { destructiveHint: true } : {}),
    ...(isReadOnly ? { readOnlyHint: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal: Intent Execution
// ---------------------------------------------------------------------------

async function executeIntentForMCP(
  api: AgentApiSurface,
  intentId: string,
  args: Record<string, unknown>,
  toolIndex: Map<string, ToolIndexEntry>,
): Promise<CallToolResult> {
  if (!toolIndex.has(intentId)) {
    return toCallToolResult({ success: false, error: `Unknown tool: ${intentId}` }, { bare: true });
  }

  try {
    const result = await api.executeIntent(intentId, args);
    return toCallToolResult(
      result.success ? { success: true, data: result.data } : { success: false, error: result.error?.message ?? 'Unknown error' },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown execution error';
    return toCallToolResult({ success: false, error: `Execution error: ${message}` }, { bare: true });
  }
}

// ---------------------------------------------------------------------------
// Internal: Resource Index
// ---------------------------------------------------------------------------

interface ResourceIndexEntry {
  uri: string;
  name: string;
  description: string;
  data: unknown;
}

function buildResourceIndex(surface: UISurfaceSchema): Map<string, ResourceIndexEntry> {
  const index = new Map<string, ResourceIndexEntry>();

  for (const page of surface.pages) {
    const uri = pageURI(page);
    index.set(uri, {
      uri,
      name: `page:${page.id}`,
      description: page.description,
      data: page,
    });
  }

  for (const modal of surface.modals) {
    const uri = modalURI(modal);
    index.set(uri, {
      uri,
      name: `modal:${modal.id}`,
      description: modal.description,
      data: modal,
    });
  }

  if (surface.globalActions.length > 0) {
    const uri = 'surface://global-actions';
    index.set(uri, {
      uri,
      name: 'global-actions',
      description: 'Global actions available regardless of current page',
      data: surface.globalActions,
    });
  }

  const manifestURI = 'surface://manifest';
  index.set(manifestURI, {
    uri: manifestURI,
    name: 'surface-manifest',
    description: 'Complete OUI surface manifest: pages, modals, global actions, and entity routes',
    data: surface,
  });

  return index;
}

function pageURI(page: PageDeclaration): string {
  return `surface://pages/${page.id}`;
}

function modalURI(modal: ModalDeclaration): string {
  return `surface://modals/${modal.id}`;
}
