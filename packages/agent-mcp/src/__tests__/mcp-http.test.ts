/**
 * The generated API tools over MCP's Streamable HTTP, stateless: one HTTP request
 * in, one response out, as a serverless host (a Lambda behind an API gateway)
 * serves it. The principal is the credential the host authenticated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiTools, type OpenApiTool } from '@ouispec/agent-worker/openapi';
import { DESK_SESSIONS, DESK_USERS, deskEvents, startDeskApi, type DeskApi } from '@ouispec/agent-worker/testing';
import { createMCPApiToolServer } from '../server/api-tool-server.js';
import { handleMCPRequest } from '../server/http.js';

let api: DeskApi;
let tools: OpenApiTool[];
beforeAll(async () => {
  api = await startDeskApi();
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

const createServer = () =>
  createMCPApiToolServer({
    tools,
    principal: (auth) => {
      const userId = auth ? DESK_SESSIONS[auth.token] : undefined;
      const user = userId ? DESK_USERS[userId] : undefined;
      return user ? { userId: user.userId, accountId: user.accountId, userToken: auth!.token } : null;
    },
  }).server;

const post = (body: unknown, token = 'session-bo') =>
  handleMCPRequest(
    createServer,
    new Request('https://api.desk.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify(body),
    }),
    { token, clientId: 'desk-cli', scopes: [] },
  );

describe('MCP over stateless HTTP', () => {
  it('initializes, lists the tools and runs one, each request on its own', async () => {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desk-cli', version: '1' } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toContain('application/json');
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(await init.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } });

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const { result } = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(result.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());

    const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getQuote', arguments: { symbol: 'ACME' } } });
    expect(await call.json()).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: JSON.stringify({ symbol: 'ACME', bid: 12.4, ask: 12.6 }, null, 2) }] },
    });
    expect(api.requests.at(-1)).toMatchObject({ path: '/v1/quotes/ACME', caller: 'bo' });
  });

  it('answers a notification with 202 and nothing else, and refuses a GET stream', async () => {
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    const get = await handleMCPRequest(createServer, new Request('https://api.desk.test/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }));
    expect(get.status).toBe(405);
  });

  it('runs a call only as the principal the host authenticated', async () => {
    const call = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'getQuote', arguments: { symbol: 'ACME' } } }, 'session-nobody');
    expect(await call.json()).toMatchObject({ id: 4, result: { isError: true } });
  });
});
