/**
 * W8 acceptance, MCP (ADR-0181 §2, ADR-0227 §2.5): the MCP server serves the same
 * generated API tools, with the same exposure, and each MCP client acts as its own
 * principal.
 *
 * A real MCP client talks to the server over the protocol, as a principal the
 * transport authenticated; the tools call the fixture product's real HTTP API,
 * which enforces its own permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { loadOpenApiTools, type OpenApiTool } from '@ouispec/agent-worker/openapi';
import {
  DESK_AGENT_OPERATIONS,
  DESK_SESSIONS,
  DESK_USERS,
  deskEvents,
  startDeskApi,
  type DeskApi,
} from '@ouispec/agent-worker/testing';
import { createMCPApiToolServer } from '../server/api-tool-server.js';

let api: DeskApi;
let tools: OpenApiTool[];

beforeAll(async () => {
  api = await startDeskApi();
  // An MCP client authenticates as its own principal: its calls carry its own credential.
  tools = loadOpenApiTools(api.document, {
    baseUrl: api.baseUrl,
    audience: 'agents',
    events: deskEvents,
    actAs: (ctx) => ({ authorization: `Bearer ${String(ctx.userToken)}` }),
  });
});
afterAll(async () => {
  await api.close();
});

/** An MCP client whose every message arrives authenticated as `token`, as an HTTP transport's bearer auth does. */
async function connect(token: string | null) {
  const { server, toolCount } = createMCPApiToolServer({
    tools,
    principal: (auth) => {
      const userId = auth ? DESK_SESSIONS[auth.token] : undefined;
      const user = userId ? DESK_USERS[userId] : undefined;
      return user ? { userId: user.userId, accountId: user.accountId, userToken: auth!.token } : null;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const authInfo: AuthInfo | undefined = token ? { token, clientId: 'desk-mcp-client', scopes: [] } : undefined;
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: JSONRPCMessage) => send(message, { authInfo });
  const client = new Client({ name: 'desk-mcp-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, toolCount, close: () => client.close() };
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

describe('MCP serves the generated API tools', () => {
  it('lists exactly the same tools, with the same input schemas, and says what each one changes', async () => {
    const { client, toolCount, close } = await connect('session-bo');
    try {
      const { tools: listed } = await client.listTools();
      expect(toolCount).toBe(DESK_AGENT_OPERATIONS.length);
      expect(listed.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
      expect(listed.map((t) => t.name).sort()).toEqual([...DESK_AGENT_OPERATIONS].sort());

      for (const tool of tools) {
        const served = listed.find((t) => t.name === tool.name)!;
        expect(served.description).toBe(tool.description);
        // The same schema, less the worker's own flag.
        const { sideEffects: _flag, ...schema } = tool.inputSchema;
        expect(served.inputSchema).toEqual(schema);
      }

      const annotations = (name: string) => listed.find((t) => t.name === name)!.annotations;
      expect(annotations('listOrders')).toEqual({ title: 'List your orders', readOnlyHint: true, destructiveHint: false });
      expect(annotations('renameWatchlist')).toEqual({ title: 'Rename a watchlist', readOnlyHint: false, destructiveHint: false });
      expect(annotations('deleteWatchlist')).toEqual({ title: 'Delete a watchlist', readOnlyHint: false, destructiveHint: true });
      expect(annotations('placeOrder')).toEqual({ title: 'Place an order', readOnlyHint: false, destructiveHint: true });
    } finally {
      await close();
    }
  });

  it('runs a read and a write as the client’s own principal', async () => {
    const { client, close } = await connect('session-bo');
    try {
      const before = api.requests.length;
      const read = await client.callTool({ name: 'listOrders', arguments: {} });
      expect(read.isError).toBeFalsy();
      expect(JSON.parse(text(read))).toEqual({
        orders: [{ id: 'o-3', symbol: 'ACME', side: 'sell', quantity: 7, limitPrice: 13, status: 'open' }],
      });

      const write = await client.callTool({ name: 'renameWatchlist', arguments: { watchlistId: 'w-1', name: 'Semis' } });
      expect(write.isError).toBeFalsy();
      expect(JSON.parse(text(write))).toEqual({ id: 'w-1', accountId: 'desk-1', name: 'Semis' });

      expect(api.requests.slice(before)).toEqual([
        expect.objectContaining({ method: 'GET', path: '/v1/orders', caller: 'bo', headers: expect.objectContaining({ authorization: 'Bearer session-bo' }) }),
        expect.objectContaining({ method: 'PATCH', path: '/v1/watchlists/w-1', caller: 'bo', body: { name: 'Semis' } }),
      ]);
    } finally {
      await close();
    }
  });

  it('returns the route’s own 403 as an error when the principal lacks the permission', async () => {
    const { client, close } = await connect('session-ana');
    try {
      const result = await client.callTool({ name: 'renameWatchlist', arguments: { watchlistId: 'w-1', name: 'Mine' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Error: renameWatchlist was refused: 403 Forbidden: Missing permission watchlists:write');
      expect(api.requests.at(-1)).toMatchObject({ method: 'PATCH', caller: 'ana' });
    } finally {
      await close();
    }
  });

  it('refuses invalid input, an unexposed operation, an unauthenticated client and an unapproved transaction without calling the API', async () => {
    const before = api.requests.length;
    const bo = await connect('session-bo');
    const anon = await connect(null);
    try {
      const invalid = await bo.client.callTool({ name: 'listOrders', arguments: { limit: 0, accountId: 'desk-2' } });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain('Invalid input for "listOrders"');
      expect(text(invalid)).toContain('"accountId"');

      const unexposed = await bo.client.callTool({ name: 'listUsers', arguments: {} });
      expect(unexposed.isError).toBe(true);
      expect(text(unexposed)).toBe('Unknown tool: listUsers');

      const unauthenticated = await anon.client.callTool({ name: 'listOrders', arguments: {} });
      expect(unauthenticated.isError).toBe(true);
      expect(text(unauthenticated)).toBe('Not authenticated: this server runs a tool only as the principal its client authenticated as');

      const order = await bo.client.callTool({ name: 'placeOrder', arguments: { symbol: 'ACME', side: 'buy', quantity: 1 } });
      expect(order.isError).toBe(true);
      expect(text(order)).toContain('APPROVAL_REQUIRED');

      expect(api.requests.length).toBe(before);
    } finally {
      await bo.close();
      await anon.close();
    }
  });

  it('requires the principal seam', () => {
    expect(() => createMCPApiToolServer({ tools, principal: undefined as never })).toThrow(/principal is required/);
  });
});
