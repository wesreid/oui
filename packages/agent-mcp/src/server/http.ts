/**
 * MCP's Streamable HTTP, stateless: each HTTP request gets its own server and
 * transport, and is answered with JSON. This suits a host that keeps no state
 * between requests, such as a Lambda behind an API gateway.
 *
 * The host authenticates the request itself and passes what it verified as
 * `authInfo`; tools reach it as their principal (`createMCPApiToolServer`).
 * There is no session and no server-sent stream: a GET is refused.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Answer one MCP HTTP request. `createServer` builds a fresh server for it, so no
 * state is shared between requests or callers.
 */
export async function handleMCPRequest(createServer: () => Server, request: Request, authInfo?: AuthInfo): Promise<Response> {
  // No session to resume or end, and no stream a stateless host could hold open:
  // MCP allows 405 for both.
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server answers POST only' }, id: null }), {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'application/json' },
    });
  }
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, authInfo ? { authInfo } : undefined);
  } finally {
    await transport.close();
    await server.close();
  }
}
