/**
 * How an MCP server introduces itself when the product names nothing. The
 * product's own name belongs in `serverInfo`; the platform has no default
 * that names any one product.
 */
export const DEFAULT_SERVER_INFO: { name: string; version: string } = { name: 'agent-sdk-mcp', version: '1.0.0' };
