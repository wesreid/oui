/**
 * MCP API Tool Server — serves an agent SDK's generated API tools
 * (`loadOpenApiTools`, ADR-0181 §2) over MCP, with the same exposure the worker has.
 *
 * Each MCP client acts as its own principal (ADR-0181 §4): the host resolves the
 * credential the transport authenticated to a caller, and the tools call the API as
 * that caller through their `actAs` seam. The API decides access, so a permission
 * the caller lacks comes back as the route's own refusal. A call is validated
 * against the tool's input schema before it runs, as the worker does.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  createToolInputValidator,
  type RegisteredTool,
  type ToolExecutionContext,
  type ToolInputValidator,
} from '@ouispec/agent-worker/openapi';
import { effectAccess, effectKind } from '@ouispec/bindings';
import { toCallToolResult } from './results.js';

/** The caller an MCP client authenticated as. Other fields reach the tools' `actAs` in its context. */
export interface MCPPrincipal {
  userId: string;
  accountId: string;
  [key: string]: unknown;
}

export interface MCPApiToolServerConfig {
  /** The generated API tools, loaded with an `actAs` that calls the API as the MCP client's principal. */
  tools: RegisteredTool[];
  /**
   * Who the client is, from the credential its transport authenticated (for example
   * the bearer token an HTTP transport verified). Return null to refuse the call.
   * Required; there is no default.
   */
  principal: (auth: AuthInfo | undefined) => MCPPrincipal | null | Promise<MCPPrincipal | null>;
  serverInfo?: { name: string; version: string };
}

export interface MCPApiToolServerResult {
  /** The configured Server, ready for `server.connect(transport)`. */
  server: Server;
  toolCount: number;
}

interface ServedTool {
  tool: RegisteredTool;
  listed: Tool;
  validate: ToolInputValidator;
}

const NOT_AUTHENTICATED = 'Not authenticated: this server runs a tool only as the principal its client authenticated as';

function annotationsOf(tool: RegisteredTool): ToolAnnotations {
  const readOnly = effectAccess(tool.effect) === 'read';
  const irreversible = tool.effect !== undefined && effectKind(tool.effect) === 'transaction';
  const title = (tool as { operation?: { title?: unknown } }).operation?.title;
  return {
    ...(typeof title === 'string' ? { title } : {}),
    readOnlyHint: readOnly,
    // MCP assumes a write is destructive unless told otherwise.
    destructiveHint: !readOnly && (tool.destructive === true || irreversible),
  };
}

function listedTool(tool: RegisteredTool): Tool {
  // `sideEffects` is the worker's own flag, not JSON Schema.
  const { sideEffects: _sideEffects, ...inputSchema } = tool.inputSchema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations: annotationsOf(tool),
  };
}

/**
 * Create an MCP server that lists and runs the given tools. It is not yet connected:
 * call `server.connect(transport)`.
 */
export function createMCPApiToolServer(config: MCPApiToolServerConfig): MCPApiToolServerResult {
  if (typeof config.principal !== 'function') {
    throw new Error('createMCPApiToolServer: principal is required: it names who each call runs as, and has no default');
  }
  const info = config.serverInfo ?? { name: 'agent-sdk-api-tools', version: '1.0.0' };
  const served = new Map<string, ServedTool>();
  for (const tool of config.tools) {
    if (served.has(tool.name)) throw new Error(`createMCPApiToolServer: two tools are named "${tool.name}"`);
    served.set(tool.name, { tool, listed: listedTool(tool), validate: createToolInputValidator(tool.inputSchema) });
  }

  const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...served.values()].map((entry) => entry.listed),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const entry = served.get(name);
    if (!entry) return toCallToolResult({ success: false, error: `Unknown tool: ${name}` }, { bare: true });

    let principal: MCPPrincipal | null;
    try {
      principal = await config.principal(extra.authInfo);
    } catch {
      principal = null;
    }
    if (!principal) return toCallToolResult({ success: false, error: NOT_AUTHENTICATED }, { bare: true });

    const validation = entry.validate(args ?? {});
    if (!validation.ok) {
      return toCallToolResult({ success: false, error: `Invalid input for "${name}": ${validation.errors.join('; ')}` });
    }

    const ctx: ToolExecutionContext = {
      ...principal,
      userId: principal.userId,
      accountId: principal.accountId,
      turnId: `mcp-${String(extra.requestId)}`,
      conversationId: `mcp-${extra.sessionId ?? 'session'}`,
      abortSignal: extra.signal,
      toolCallId: String(extra.requestId),
    };
    try {
      return toCallToolResult(await entry.tool.execute(validation.value, ctx));
    } catch (err) {
      return toCallToolResult({ success: false, error: `Execution error: ${err instanceof Error ? err.message : String(err)}` }, { bare: true });
    }
  });

  return { server, toolCount: served.size };
}
