import { toCallToolResult } from './results.js';
import type { SchemaRegistry, AgentApiSurface, CompiledIntent, CompiledEntity } from '@ouispec/agent-core';
import { DEFAULT_SERVER_INFO } from './server-info.js';

export interface MCPServerConfig {
  registry: SchemaRegistry;
  api: AgentApiSurface;
  serverInfo?: { name: string; version: string };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface MCPToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Creates an MCP-compatible server from an Agent SDK schema registry.
 * Maps: intents → MCP tools, entities → MCP resources.
 */
export function createMCPServer(config: MCPServerConfig) {
  const { registry, api } = config;
  const serverInfo = config.serverInfo ?? DEFAULT_SERVER_INFO;

  function listTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const intent of registry.intents.values()) {
      tools.push(intentToMCPTool(intent));
    }
    return tools;
  }

  function listResources(): MCPResource[] {
    const resources: MCPResource[] = [];
    for (const entity of registry.entities.values()) {
      resources.push(entityToMCPResource(entity));
    }
    return resources;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const intent = registry.getIntent(name);
    if (!intent) {
      return toCallToolResult({ success: false, error: `Unknown tool: ${name}` }, { bare: true });
    }

    try {
      const result = await api.executeIntent(name, args);
      return toCallToolResult(
        result.success ? { success: true, data: result.data } : { success: false, error: result.error?.message ?? 'Unknown error' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return toCallToolResult({ success: false, error: `Execution error: ${message}` }, { bare: true });
    }
  }

  async function readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
    const match = uri.match(/^entity:\/\/(\w+)$/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const entityType = match[1];
    const entities = await api.queryEntities(entityType, { limit: 50 });

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(entities, null, 2),
      }],
    };
  }

  return {
    serverInfo,
    listTools,
    listResources,
    callTool,
    readResource,

    async handleRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
      switch (method) {
        case 'initialize':
          return { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo };
        case 'tools/list':
          return { tools: listTools() };
        case 'resources/list':
          return { resources: listResources() };
        case 'tools/call':
          return callTool(params?.name as string, (params?.arguments as Record<string, unknown>) ?? {});
        case 'resources/read':
          return readResource(params?.uri as string);
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },
  };
}

function intentToMCPTool(intent: CompiledIntent): MCPTool {
  return {
    name: intent.id,
    description: intent.description,
    inputSchema: intent.toolDefinition.function.parameters as Record<string, unknown>,
  };
}

function entityToMCPResource(entity: CompiledEntity): MCPResource {
  return {
    uri: `entity://${entity.id}`,
    name: `${entity.id} collection`,
    description: entity.description ?? `All ${entity.id} entities`,
    mimeType: 'application/json',
  };
}
