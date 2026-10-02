/**
 * W8 acceptance (ADR-0181 §2, ADR-0227 §2.1): a product's OpenAPI document becomes
 * the agent's API tools, each call acting as the user.
 *
 * Against the fixture product's real HTTP API, which authenticates callers and
 * enforces permissions itself:
 * - exactly the opted-in operations become tools, with input validation;
 * - an operation without exposure is not offered;
 * - a call carries the auth seam's headers and runs with the user's permissions;
 * - a permission the user lacks comes back as the route's own 403, which reaches the
 *   model as an error in a real turn;
 * - only flagged reads reach the product's own assistant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiTools, type OpenApiTool } from '../openapi/index.js';
import { createToolInputValidator } from '../tools/input-validation.js';
import { createToolRegistry, type ToolExecutionContext } from '../tools/types.js';
import { runAgentTurn } from '../orchestrator.js';
import {
  DESK_AGENT_OPERATIONS,
  DESK_PA_OPERATIONS,
  deskAgentHeaders,
  deskEvents,
  startDeskApi,
  type DeskApi,
} from '../testing/index.js';
import { chunk, scriptedOpenAI, sse } from './support/replay.js';

let api: DeskApi;
let tools: OpenApiTool[];
const byName = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

const asUser = (userId: string): ToolExecutionContext => ({
  userId,
  accountId: 'desk-1',
  turnId: 'turn-1',
  conversationId: 'conv-1',
});

beforeAll(async () => {
  api = await startDeskApi();
  tools = loadOpenApiTools(api.document, { baseUrl: api.baseUrl, actAs: deskAgentHeaders, audience: 'agents', events: deskEvents });
});
afterAll(async () => {
  await api.close();
});

describe('OpenAPI document → agent tools', () => {
  it('produces exactly the opted-in operations, each a complete, callable tool', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...DESK_AGENT_OPERATIONS].sort());

    for (const tool of tools) {
      expect(tool.kind).toBe('backend');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.effect).toBeDefined();
      expect(tool.operation).toMatchObject({ operationId: tool.name });
      expect(tool.operation.security.length).toBeGreaterThan(0);
    }

    // Reads are side-effect free, writes are not (the worker's quota reads this).
    expect(byName('listOrders').effect).toBe('view');
    expect(byName('listOrders').inputSchema.sideEffects).toBe(false);
    expect(byName('renameWatchlist').effect).toEqual({ kind: 'mutate', operation: 'renameWatchlist' });
    expect(byName('renameWatchlist').inputSchema.sideEffects).toBeUndefined();

    // Effect and destructive are on every tool, for approvals to key on.
    expect(byName('placeOrder').effect).toEqual({ kind: 'transaction', operation: 'placeOrder' });
    expect(byName('placeOrder').consequence).toBe('Sends a live order to the exchange.');
    expect(byName('deleteWatchlist').destructive).toBe(true);
    expect(byName('renameWatchlist').destructive).toBe(false);
    expect(byName('runReport').effect).toEqual({ kind: 'job' });

    // Required permissions from the standard security requirement.
    expect(byName('renameWatchlist').operation.security).toEqual([
      { session: ['watchlists:write'] },
      { agent: ['watchlists:write'] },
    ]);
    expect(byName('placeOrder').operation).toMatchObject({ method: 'post', path: '/v1/orders', title: 'Place an order' });
  });

  it('builds each input from the operation: parameters, $refs, the body, never read-only fields', () => {
    expect(byName('listOrders').inputSchema).toEqual({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'filled', 'cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many to return, at most' },
      },
      additionalProperties: false,
      sideEffects: false,
    });

    // Path parameters from the path item and the operation; the body's fields beside them.
    expect(byName('renameWatchlist').inputSchema).toEqual({
      type: 'object',
      properties: {
        watchlistId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 60 },
      },
      required: ['watchlistId', 'name'],
      additionalProperties: false,
    });
    expect(byName('getOrder').inputSchema.required).toEqual(['orderId']);

    // The order's id and status are the server's (readOnly): the model never sends them.
    const place = byName('placeOrder').inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(place.properties).sort()).toEqual(['limitPrice', 'quantity', 'side', 'symbol']);
    expect(place.required).toEqual(['symbol', 'side', 'quantity']);
    expect(place.properties.side).toEqual({ type: 'string', enum: ['buy', 'sell'] });

    // The description says what the operation is and what calling it does.
    expect(byName('listOrders').description).toBe('List your orders\n\nYour own orders, newest first.');
    expect(byName('placeOrder').description).toContain('irreversible');
    expect(byName('placeOrder').description).toContain('Sends a live order to the exchange.');
    expect(byName('deleteWatchlist').description).toContain('removes or replaces');
    expect(byName('runReport').description).toContain('starts a job');
  });

  it('validates input against the operation, as the worker does before any call', () => {
    const validate = (name: string) => createToolInputValidator(byName(name).inputSchema);
    expect(validate('listOrders')({ status: 'open', limit: 5 })).toMatchObject({ ok: true });
    expect(validate('listOrders')({ limit: 0 })).toMatchObject({ ok: false });
    expect(validate('listOrders')({ status: 'pending' })).toMatchObject({ ok: false });
    expect(validate('listOrders')({ accountId: 'desk-2' })).toMatchObject({
      ok: false,
      errors: ['(input) has a property this tool does not accept: "accountId"'],
    });
    expect(validate('placeOrder')({ symbol: 'acme', side: 'buy', quantity: 1 })).toMatchObject({ ok: false });
    expect(validate('placeOrder')({ symbol: 'ACME', side: 'buy', quantity: 1, id: 'o-9' })).toMatchObject({ ok: false });
    expect(validate('placeOrder')({ symbol: 'ACME', side: 'buy', quantity: 1, limitPrice: null })).toMatchObject({ ok: true });
    expect(validate('renameWatchlist')({ watchlistId: 'w-1' })).toMatchObject({
      ok: false,
      errors: ['(input) is missing required property "name"'],
    });
  });

  it('does not offer an operation without exposure', () => {
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('listUsers')).toBe(false); // no x-agent
    expect(names.has('reindex')).toBe(false); // x-agent.expose: false
    expect(names.has('getHealth')).toBe(false); // no x-agent, public
  });

  it('gives the product’s own assistant only the flagged reads', () => {
    const pa = loadOpenApiTools(api.document, { baseUrl: api.baseUrl, actAs: deskAgentHeaders, audience: 'pa', events: deskEvents });
    expect(pa.map((t) => t.name).sort()).toEqual([...DESK_PA_OPERATIONS].sort());
    for (const tool of pa) expect(tool.inputSchema.sideEffects).toBe(false);
  });
});

describe('calling an operation as the user', () => {
  it('sends the auth seam’s headers and returns what the API gives this user', async () => {
    const before = api.requests.length;
    const result = await byName('listOrders').execute({ status: 'open', limit: 5 }, asUser('ana'));

    expect(result).toEqual({
      success: true,
      data: { orders: [{ id: 'o-1', symbol: 'ACME', side: 'buy', quantity: 10, limitPrice: 12.5, status: 'open' }] },
    });
    const sent = api.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'GET',
      path: '/v1/orders',
      query: { status: ['open'], limit: ['5'] },
      caller: 'ana',
      headers: { 'x-desk-agent': deskAgentHeaders({ userId: 'ana', accountId: 'desk-1' })['x-desk-agent'] },
    });
  });

  it('puts path parameters in the path and the rest in a JSON body', async () => {
    const before = api.requests.length;
    const result = await byName('renameWatchlist').execute({ watchlistId: 'w-1', name: 'Growth' }, asUser('bo'));
    expect(result).toEqual({ success: true, data: { id: 'w-1', accountId: 'desk-1', name: 'Growth' } });
    expect(api.requests[before]).toMatchObject({
      method: 'PATCH',
      path: '/v1/watchlists/w-1',
      body: { name: 'Growth' },
      headers: { 'content-type': 'application/json' },
      caller: 'bo',
    });
  });

  it('returns the route’s own 403 as an error when the user lacks the permission', async () => {
    const result = await byName('renameWatchlist').execute({ watchlistId: 'w-1', name: 'Mine' }, asUser('ana'));
    expect(result).toEqual({
      success: false,
      error: 'renameWatchlist was refused: 403 Forbidden: Missing permission watchlists:write',
      data: { status: 403, body: { error: { message: 'Missing permission watchlists:write' } } },
    });
  });

  it('reports a completed call with no body by its status', async () => {
    const api2 = await startDeskApi();
    try {
      const [del] = loadOpenApiTools(api2.document, { baseUrl: api2.baseUrl, actAs: deskAgentHeaders, audience: 'agents', events: deskEvents })
        .filter((t) => t.name === 'deleteWatchlist');
      expect(await del!.execute({ watchlistId: 'w-1' }, asUser('bo'))).toEqual({ success: true, data: { status: 204 } });
      expect(api2.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/watchlists/w-1', caller: 'bo' });
    } finally {
      await api2.close();
    }
  });

  it('never runs an irreversible operation on the agent’s say-so (ADR-0228)', async () => {
    const before = api.requests.length;
    const result = await byName('placeOrder').execute({ symbol: 'ACME', side: 'buy', quantity: 1 }, asUser('ana'));
    expect(result).toMatchObject({ success: false, data: { code: 'APPROVAL_REQUIRED' } });
    expect(result.error).toContain('placeOrder');
    expect(api.requests.length).toBe(before);
  });

  it('does not call the API when the auth seam fails', async () => {
    const failing = loadOpenApiTools(api.document, {
      baseUrl: api.baseUrl,
      audience: 'agents',
      events: deskEvents,
      actAs: () => {
        throw new Error('signing key unavailable');
      },
    });
    const before = api.requests.length;
    const result = await failing.find((t) => t.name === 'listOrders')!.execute({}, asUser('ana'));
    expect(result).toEqual({ success: false, error: 'listOrders could not act as the user: signing key unavailable' });
    expect(api.requests.length).toBe(before);
  });
});

describe('a real turn', () => {
  it('delivers the route’s 403 to the model as the tool’s error, and the turn completes', async () => {
    const reply = 'You do not have permission to rename watchlists.';
    const model = scriptedOpenAI(
      [
        sse([
          chunk([
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_rename_1',
                    type: 'function',
                    function: { name: 'renameWatchlist', arguments: '{"watchlistId":"w-1","name":"Mine"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
          chunk([], { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }),
        ]),
        sse([
          chunk([{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }]),
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
          chunk([], { usage: { prompt_tokens: 560, completion_tokens: 12, total_tokens: 572 } }),
        ]),
      ],
      { toolCallId: 'call_rename_1', reply },
    );
    const before = api.requests.length;

    const result = await runAgentTurn(
      {
        model: model.model,
        tools: createToolRegistry(tools),
        emit: { emit: async () => {} },
        systemPrompt: 'You help on the desk.',
      },
      {
        turnId: 'turn-403',
        conversationId: 'conv-403',
        userId: 'ana',
        accountId: 'desk-1',
        socketRoom: 'member:ana',
        content: 'Rename my Tech watchlist to Mine',
      },
    );

    // The model was offered the API tools.
    const firstRequest = model.requests[0] as { tools: Array<{ function: { name: string } }> };
    expect(firstRequest.tools.map((t) => t.function.name).sort()).toEqual([...DESK_AGENT_OPERATIONS].sort());

    // The API refused ana with its own 403.
    expect(api.requests.slice(before)).toEqual([
      expect.objectContaining({ method: 'PATCH', path: '/v1/watchlists/w-1', caller: 'ana' }),
    ]);

    // The model's next request carries the refusal as the tool's result.
    const secondRequest = model.requests[1] as { messages: Array<{ role: string; tool_call_id?: string; content: string }> };
    const toolMessage = secondRequest.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_rename_1');
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage!.content)).toEqual({
      error: 'renameWatchlist was refused: 403 Forbidden: Missing permission watchlists:write',
      status: 403,
      body: { error: { message: 'Missing permission watchlists:write' } },
    });

    expect(result.stopReason).toBe('complete');
    expect(result.newMessages.at(-1)).toMatchObject({ role: 'assistant', content: reply });
  });
});
