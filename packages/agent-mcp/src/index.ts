export { createMCPServer } from './server/adapter.js';
export type { MCPServerConfig } from './server/adapter.js';

export { createMCPToolServer, registerOUISurfaces } from './server/tool-server.js';
export type {
  MCPToolServerConfig,
  MCPToolServerResult,
  RegisterOUISurfacesConfig,
  RegisterOUISurfacesResult,
} from './server/tool-server.js';

// Generated API tools (ADR-0181 §2), each call as the MCP client's own principal
export { createMCPApiToolServer } from './server/api-tool-server.js';
export type { MCPApiToolServerConfig, MCPApiToolServerResult, MCPPrincipal } from './server/api-tool-server.js';
export { handleMCPRequest } from './server/http.js';
